// smoke-test.mjs —— 冒烟测试：起一个临时后端，自动跑六项，跑完自己收拾干净退出
// 用法：node mini-chat/smoke-test.mjs           （默认用 haiku，省额度；MODEL=sonnet 可换）
// 升级 Claude Code 之后先跑一遍它：六项都过了再放心用。
//
// 测的六项：① 流式 + MCP + 窗口 id 透传  ② 重启后端后 --resume  ③ 发图（落盘 + Read）
//           ④ 停止键  ⑤ 停止之后接着聊  ⑥ 落库
// 用一个独立的窗口 id、独立的端口；不碰你自己的聊天记录，跑完删掉自己的测试窗口和测试图片。
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SMOKE_PORT || 3457);
const BASE = `http://127.0.0.1:${PORT}`;
const CHAT = `smoke-${Date.now()}`;
const MODEL = process.env.MODEL || "haiku";

let server = null;
let serverLog = "";
let uploaded = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(PORT), MODEL };
    delete env.ANTHROPIC_API_KEY;
    server = spawn("node", [join(DIR, "server.mjs")], { cwd: DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (c) => { serverLog += c; if (String(c).includes("mini-chat 在")) resolve(); });
    server.stderr.on("data", (c) => { serverLog += c; });
    server.once("exit", (code) => reject(new Error(`后端没起来（退出码 ${code}）：\n${serverLog.slice(-1000)}`)));
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode != null) return resolve();
    server.removeAllListeners("exit");
    server.once("close", resolve);
    server.kill("SIGTERM");
  });
}
const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function chat(text, { imagePath, onFirstText } = {}) {
  const res = await post("/chat", { chatId: CHAT, text, imagePath });
  if (!res.ok) throw new Error(`/chat ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", reply = "", fired = false;
  const counts = {}, tools = [];
  let end = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop();
    for (const evt of events) {
      const line = evt.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = JSON.parse(line.slice(6));
      counts[data.type] = (counts[data.type] || 0) + 1;
      if (data.type === "text") { reply += data.text; if (onFirstText && !fired) { fired = true; onFirstText(); } }
      if (data.type === "tool" && data.tool.done) tools.push(data.tool.name);
      if (data.type === "done" || data.type === "error") end = data;
    }
  }
  return { reply: reply.trim(), counts, tools, end };
}

// 生成一张 16×16 的纯红 PNG（不用任何图片库）
function redPng(size = 16) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([230, 20, 20]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "✅" : "❌"} ${name}  ${detail}`); };

const timer = setTimeout(() => { console.log("❌ 总超时（5 分钟），退出"); server?.kill(); process.exit(1); }, 300_000);
try {
  console.log(`模型 ${MODEL}，端口 ${PORT}，测试窗口 ${CHAT}\n`);
  await startServer();

  const r1 = await chat("记住：暗号是橙子。然后调用 whoami 工具，告诉我窗口 id。");
  check("① 流式 + MCP + 窗口 id", r1.end?.type === "done" && (r1.counts.text || 0) > 0 && r1.tools.includes("mcp__mini__whoami") && r1.reply.includes(CHAT),
    `text 事件 ${r1.counts.text || 0} 个，工具 ${JSON.stringify(r1.tools)}，回复：${r1.reply.slice(0, 60)}`);

  await stopServer();
  await startServer();
  const r2 = await chat("我们刚才定的暗号是什么？只回暗号本身。");
  check("② 重启后端后 --resume", r2.reply.includes("橙") && serverLog.includes("--resume"), `回复：${r2.reply.slice(0, 40)}`);

  const up = await post("/upload", { dataUrl: `data:image/png;base64,${redPng().toString("base64")}` }).then((r) => r.json());
  uploaded = up.path;
  const r3 = await chat("这张图主要是什么颜色？只回颜色。", { imagePath: up.path });
  check("③ 发图（落盘 + Read）", r3.reply.includes("红") && r3.tools.includes("Read"), `工具 ${JSON.stringify(r3.tools)}，回复：${r3.reply.slice(0, 40)}`);

  const r4 = await chat("从 1 数到 300，每个数字单独一行，不要别的话。", { onFirstText: () => post("/stop", { chatId: CHAT }) });
  check("④ 停止键", r4.end?.type === "done" && r4.reply.length < 200, `收到 ${r4.end?.type}，已流出 ${r4.reply.length} 字`);

  const r5 = await chat("刚才被打断了。暗号还记得吗？只回暗号。");
  check("⑤ 停止之后接着聊", r5.reply.includes("橙"), `回复：${r5.reply.slice(0, 40)}`);

  const saved = await fetch(`${BASE}/api/chat/${CHAT}`).then((r) => r.json());
  check("⑥ 落库", saved.messages.length === 10 && Boolean(saved.sessionId) && saved.generating === false,
    `${saved.messages.length} 条消息，sessionId ${saved.sessionId ? "已存" : "没存"}`);
} catch (e) {
  check("运行", false, e.message);
  console.log(serverLog.slice(-1500));
} finally {
  clearTimeout(timer);
  await stopServer();
  rmSync(join(DIR, "chats", `${CHAT}.json`), { force: true });
  if (uploaded) rmSync(uploaded, { force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} 项没过。` : "\n全部通过。");
  process.exit(failed ? 1 : 0);
}
