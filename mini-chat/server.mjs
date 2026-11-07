// server.mjs —— 最小可跑的「claude -p 常驻聊天后端」，零依赖，Node 18+
// 启动：node server.mjs        打开：http://127.0.0.1:3456
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3456);
const MODEL = process.env.MODEL || "sonnet";
const CHATS_DIR = join(ROOT, "chats");
const UPLOADS_DIR = join(ROOT, "uploads");
const PERSONA_FILE = join(ROOT, "persona.md");
const PROMPT_FILE = join(ROOT, ".tmp-prompt.md");
const MCP_FILE = join(ROOT, "mcp.json");
for (const d of [CHATS_DIR, UPLOADS_DIR]) mkdirSync(d, { recursive: true });

// ───────── 存储：一个窗口一个 JSON 文件 ─────────
const safeId = (id) => (/^[\w-]{1,64}$/.test(String(id || "")) ? String(id) : null);
const chatPath = (id) => join(CHATS_DIR, `${id}.json`);
function loadChat(id) {
  if (!existsSync(chatPath(id))) return { id, sessionId: null, messages: [] };
  return JSON.parse(readFileSync(chatPath(id), "utf8"));
}
function saveChat(chat) {
  writeFileSync(chatPath(chat.id), JSON.stringify(chat, null, 2));
}

// ───────── 系统提示词：现读现拼 ─────────
function buildPrompt() {
  const persona = existsSync(PERSONA_FILE) ? readFileSync(PERSONA_FILE, "utf8").trim() : "你是一个温柔的聊天伙伴。";
  return persona; // 想再拼用户画像、工具说明，就在这里 [a, b, c].join("\n\n")
}

// ───────── 进程：一个窗口一条常驻 claude ─────────
const procs = new Map();      // chatId → claude 子进程
const generating = new Map(); // chatId → { stop() }（正在生成的那一轮）

function getProc(chatId, resumeId) {
  const live = procs.get(chatId);
  if (live && !live.killed) return live;

  const promptText = buildPrompt();
  writeFileSync(PROMPT_FILE, promptText);
  const args = [
    "--print",                              // 非交互模式：一切的前提
    "--input-format", "stream-json",        // stdin 持续吃 JSON → 进程常驻
    "--output-format", "stream-json",       // stdout 一行一个 JSON 事件
    "--verbose",                            // 不带就只有很少几种事件
    "--include-partial-messages",           // 逐字 / 逐念头的 delta
    "--model", MODEL,
    "--system-prompt-file", PROMPT_FILE,    // 换掉官方的系统提示词主体
    "--system-prompt-snapshot", "off",      // --resume 时用新提示词，不用第一次拍下的那份
    "--thinking-display", "summarized",     // 让 thinking 有可读文本（隐藏 flag）
    "--tools", "Read",                      // 内置工具只留 Read（看图要用）
    "--permission-mode", "dontAsk",         // 没放行的一律拒绝，不会卡住等人点
  ];
  if (existsSync(MCP_FILE)) {
    args.push("--mcp-config", MCP_FILE, "--strict-mcp-config", "--allowedTools", "Read,mcp__mini");
  }
  if (resumeId) args.push("--resume", resumeId);

  const env = { ...process.env, CHAT_ID: chatId }; // CHAT_ID 会一路传给 MCP 子进程
  delete env.ANTHROPIC_API_KEY;                    // 不删就走 API 计费、不走订阅

  const proc = spawn("claude", args, { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  proc._listeners = new Set();
  proc._promptText = promptText;
  const emit = (ev) => { for (const fn of [...proc._listeners]) fn(ev); };

  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop(); // 最后一段可能不完整，留到下一批
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      emit(ev);
    }
  });
  proc.stderr.on("data", (c) => console.error("[claude stderr]", String(c).slice(0, 300)));
  proc.stdin.on("error", () => {});
  proc.on("error", (e) => emit({ type: "_exit", code: e.message }));
  proc.on("close", (code) => {
    if (procs.get(chatId) === proc) procs.delete(chatId);
    emit({ type: "_exit", code });
  });
  procs.set(chatId, proc);
  console.log(`[spawn] ${chatId}${resumeId ? ` --resume ${resumeId.slice(0, 8)}` : "（新会话）"}`);
  return proc;
}

// ───────── POST /chat：喂一轮，用 SSE 流回去 ─────────
function handleChat(req, res, body) {
  const chatId = safeId(body.chatId);
  const text = String(body.text || "");
  const imagePath = body.imagePath ? String(body.imagePath) : null;
  if (!chatId || (!text && !imagePath)) return sendJson(res, 400, { error: "chatId 和 text 必填" });
  if (generating.has(chatId)) return sendJson(res, 409, { error: "上一句还在生成" });

  const chat = loadChat(chatId);
  chat.messages.push({ role: "user", content: text, imagePath, time: new Date().toISOString() });
  saveChat(chat);

  // 人格档改过 → 旧进程退役（启动参数改不了，只能重开）
  const live = procs.get(chatId);
  if (live && !live.killed && live._promptText !== buildPrompt()) live.kill();
  const needSpawn = !procs.get(chatId) || procs.get(chatId).killed;
  const proc = getProc(chatId, needSpawn ? chat.sessionId : null);

  // 这一轮真正发给模型的内容：系统提醒 + 她的话 + 图片指引
  let content = `<system-reminder>现在时间：${new Date().toLocaleString("zh-CN")}</system-reminder>\n\n${text}`;
  if (imagePath) content += `\n\n[对方发了一张图片，请用 Read 工具查看：${imagePath}]`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (obj) => { if (!res.writableEnded) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} } };
  const beat = setInterval(() => { if (!res.writableEnded) { try { res.write(": ping\n\n"); } catch {} } }, 15_000);

  const segments = []; // 按到达顺序：{kind:"thinking"|"text", text} 或 {kind:"tool", ...}
  const last = () => segments[segments.length - 1];
  const append = (kind, t) => { if (last()?.kind !== kind) segments.push({ kind, text: "" }); last().text += t; };
  let inMyTurn = false;
  let done = false;
  let sessionId = null;
  let lastUuid = null;
  let startTimer = null;

  const finish = (error) => {
    if (done) return;
    done = true;
    clearInterval(beat);
    clearTimeout(startTimer);
    proc._listeners.delete(onEvent);
    generating.delete(chatId);
    const reply = segments.filter((s) => s.kind === "text").map((s) => s.text).join("\n\n");
    const c = loadChat(chatId);
    if (segments.length) c.messages.push({ role: "assistant", content: reply, segments, uuid: lastUuid, time: new Date().toISOString() });
    if (sessionId) c.sessionId = sessionId;
    saveChat(c);
    write(error ? { type: "error", error: String(error) } : { type: "done" });
    if (!res.writableEnded) res.end();
  };

  const onEvent = (ev) => {
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === "_exit") return finish(inMyTurn ? null : `claude 进程退出了（${ev.code}）`);

    if (ev.type === "stream_event") {
      const e = ev.event;
      if (e?.type === "message_start") inMyTurn = true; // 守门：这之前的都是上一轮的残流
      if (!inMyTurn) return;
      if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta") {
        append("thinking", e.delta.thinking);
        write({ type: "thinking", text: e.delta.thinking });
      }
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
        append("text", e.delta.text);
        write({ type: "text", text: e.delta.text });
      }
      return;
    }
    if (!inMyTurn) {
      // 启动就失败（没登录等）不会有 message_start，但会有 is_error 的 result
      if (ev.type === "result" && ev.is_error) finish(ev.result || "claude 报错");
      return;
    }
    if (ev.type === "assistant") {
      const blocks = ev.message?.content || [];
      if (blocks.some((b) => b.type === "text")) lastUuid = ev.uuid;
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        const tool = { kind: "tool", id: b.id, name: b.name, input: b.input, done: false };
        segments.push(tool);
        write({ type: "tool", tool });
      }
    }
    if (ev.type === "user") {
      for (const b of ev.message?.content || []) {
        if (b.type !== "tool_result") continue;
        const tool = segments.find((s) => s.kind === "tool" && s.id === b.tool_use_id);
        if (tool) { tool.done = true; write({ type: "tool", tool }); }
      }
    }
    if (ev.type === "result") finish(ev.is_error ? ev.result || "claude 报错" : null);
  };

  startTimer = setTimeout(() => { if (!inMyTurn) finish("90 秒还没开始回复"); }, 90_000);
  proc._listeners.add(onEvent);
  generating.set(chatId, { stop: () => { finish(null); proc.kill(); } });
  proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  // 她关了页面也不停：生成照跑、照样落库，回来时 GET /api/chat/:id 就能拿到
}

// ───────── POST /upload：图片落盘，返回绝对路径 ─────────
function handleUpload(res, body) {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(String(body.dataUrl || ""));
  if (!m) return sendJson(res, 400, { error: "只收 png / jpg / gif / webp 的 dataURL" });
  const file = join(UPLOADS_DIR, `img-${Date.now()}.${m[1].replace("jpeg", "jpg")}`);
  writeFileSync(file, Buffer.from(m[2], "base64"));
  sendJson(res, 200, { path: file, url: `/uploads/${basename(file)}` });
}

// ───────── 小工具 ─────────
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
function sendFile(res, file) {
  if (!existsSync(file)) return sendJson(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求太大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// ───────── 路由 ─────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/") return sendFile(res, join(ROOT, "index.html"));
    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) return sendFile(res, join(UPLOADS_DIR, basename(url.pathname)));
    if (req.method === "GET" && url.pathname.startsWith("/api/chat/")) {
      const id = safeId(basename(url.pathname));
      if (!id) return sendJson(res, 400, { error: "bad id" });
      return sendJson(res, 200, { ...loadChat(id), generating: generating.has(id) });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (url.pathname === "/chat") return handleChat(req, res, body);
      if (url.pathname === "/upload") return handleUpload(res, body);
      if (url.pathname === "/stop") {
        generating.get(safeId(body.chatId))?.stop();
        return sendJson(res, 200, { ok: true });
      }
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`mini-chat 在 http://127.0.0.1:${PORT}`));
