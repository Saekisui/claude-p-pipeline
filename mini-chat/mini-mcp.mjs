// mini-mcp.mjs —— 最小 MCP server（stdio，一行一个 JSON-RPC 消息），零依赖
// claude 会按 mcp.json 把它当子进程拉起来；它的环境变量从 claude 继承，所以能读到 CHAT_ID。
import readline from "node:readline";

const TOOLS = [
  {
    name: "whoami",
    description: "查看当前是哪个聊天窗口、现在几点。用户问起窗口 id 或时间时调用。",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name) {
  if (name === "whoami") {
    const text = `窗口 id：${process.env.CHAT_ID || "（没传进来）"}；现在：${new Date().toLocaleString("zh-CN")}`;
    return { content: [{ type: "text", text }] };
  }
  throw new Error(`没有这个工具：${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle({ id, method, params }) {
  try {
    if (method === "initialize") {
      return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "0.1.0" } } });
    }
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") return send({ jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments || {}) });
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method?.startsWith("notifications/")) return; // 通知不用回
    if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line)); } catch {}
});
// 调试信息只能写 stderr——stdout 是协议通道，写别的东西会把 claude 搞糊涂
process.stderr.write("[mini-mcp] ready\n");
