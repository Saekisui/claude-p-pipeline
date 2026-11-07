# Claude Code `-p` 常驻聊天管线 · 从零搭建全攻略（机教版 v2）

> **这是什么**：用你自己的 Claude 订阅，把 Claude Code（下文简称 **CC**）的 `claude -p` 当作“大脑”，接到你自己写的聊天网页上——带逐字流式、思考链、工具调用、发图、记忆、自定义工具（MCP）、技能、断线续接、后端重启不丢回复。本文把我们家自用的整条管线拆开讲，从零讲到能跑。
>
> **写给谁**：
> - 0 基础的人：照第二部分一步一步做，每一步都有“做完应该看到什么”；附录 D 是**实测跑通**的完整代码，复制就能用。
> - AI 编程助手：可以把整份文档连同你的需求一起发给它——“照这份文档给我搭一个接入 Claude Code 的聊天后端”。
>
> **基准**：Claude Code **2.1.282**（2026-11-07 用 `claude --help` 逐项核对过），Node.js 18+，macOS。Linux 基本通用，Windows 未测。
>
> **代码仓库**：https://github.com/Saekisui/claude-p-pipeline （附录 D 的骨架和冒烟测试脚本都在 `mini-chat/` 里，克隆下来就能跑）
>
> **来源标注**：
> - 【官方】官方文档 / `--help` 写明；
> - 【实测】做过对照实验；
> - 【我家】我们自己生产环境在跑、踩过坑；
> - 【隐藏】二进制里有、但文档和 `--help` 都没写，随版本可能失效；
> - 【未实测】看文档推断，没亲手验过。
>
> **红线（先说在前面）**：这套是“自己的订阅 + 自己的电脑 + 自己用”。把它包装成服务给别人用，属于官方明文禁止的“向第三方提供订阅额度”。详见 §25。

---

## 目录

**第一部分 · 先搞懂**
- §0 三分钟看懂这条管线
- §1 准备环境

**第二部分 · 跟着搭（每一步都能验证）**
- §2 起一条常驻进程
- §3 喂一句话、收一轮回复
- §4 用 SSE 推给网页
- §5 流式渲染与落库
- §6 发图片

**第三部分 · 让它成为“他”：提示词、工具、能力**
- §7 系统提示词：替换与拼装
- §8 挂 MCP：给他装手
- §9 工具面：留哪些、摘哪些
- §10 Skills、斜杠命令、Hooks、插件、自动记忆
- §11 权限与安全

**第四部分 · 断了怎么办**
- §12 四种“断”总表
- §13 网页断了：生成不停，回来对账
- §14 停止键
- §15 进程没了：`--resume` 接回
- §16 后端重启不断流：进程管家
- §17 热切换：换模型、换档位、换人格
- §18 后台任务与“无主回合”
- §19 控制通道 `control_request`

**第五部分 · 省钱与运维**
- §20 缓存、保温、回收
- §21 换底座：同一条管接别家模型
- §22 一次性 `-p` 作业
- §23 额度探针
- §24 常驻托管、日志、版本纪律
- §25 计费与政策

**第六部分 · 速查**
- §26 排错大表
- 附录 A：我家主线的完整启动参数（注释版）
- 附录 B：Flag 字典
- 附录 C：stream-json 事件速查
- 附录 D：可跑骨架完整代码 + 实测记录
- 附录 E：思考链为什么会变空（考古）

---

# 第一部分 · 先搞懂

## §0 三分钟看懂这条管线

### 0.1 一句话

**每个聊天窗口对应一条一直开着的 `claude -p` 进程。** 进程的输入（stdin）和输出（stdout）都是“一行一个 JSON”。你的后端负责翻译：把用户的话拼成一行 JSON 写进 stdin，再把 stdout 吐出来的事件翻译成网页能用的流（SSE）推给浏览器。

### 0.2 一条消息的一生

```
 ① 用户在网页点发送
        │  POST /chat  {chatId, text, imagePath}
        ▼
 ② 后端：先把用户这句存进聊天记录
        │  找到（或新开、或 --resume 接回）这个窗口的 claude 进程
        │  拼这一轮要发给模型的内容：时间 / 记忆 / 文风提醒 + 用户的话 + 图片指引
        ▼
 ③ 往进程 stdin 写一行：{"type":"user","message":{"role":"user","content":"…"}}
        ▼
 ④ claude 进程调 API、按需调用工具（读文件、你写的 MCP……）
        │  stdout 一行一个事件：message_start / thinking_delta / text_delta / tool_use / result …
        ▼
 ⑤ 后端逐行解析 → 翻成精简的 SSE 事件 → 推给网页
        │  同时把 thinking / 正文 / 工具调用按到达顺序攒起来
        ▼
 ⑥ 收到 result（这一轮结束）→ 把整条回复存进聊天记录 → 发 done → 关闭这次 SSE
        ▼
 ⑦ 网页逐字显示；如果中途断网，回来时从后端存好的记录里对账补齐
```

### 0.3 组件清单

| 组件 | 是什么 | 负责什么 | 本文章节 |
|---|---|---|---|
| 网页前端 | 你写的 HTML/JS | 输入、逐字显示、断线对账 | §4.6、§13 |
| 后端 | 一个 Node 服务 | 管进程、拼消息、翻译事件、存记录 | §2–§6 |
| claude 进程 | `claude -p` 常驻子进程 | 真正的“大脑”：调模型、调工具 | §2、§3 |
| 进程管家（可选） | 一个独立的小服务 | 后端重启时替你养着 claude 进程 | §16 |
| MCP server | 你写的小程序 | 给 AI 加自定义工具（发语音、查位置……） | §8 |
| 系统提示词文件 | 一份 .md | AI 的人格和说明书 | §7 |
| 聊天记录 | 一个窗口一个 JSON | 你自己的“真身”存储 | §5.6 |
| CC 转录 | `~/.claude/projects/…/<id>.jsonl` | CC 自己的会话记录，`--resume` 用 | §15 |

### 0.4 `claude` 的三种用法

| | 交互模式 `claude` | 一次性 `claude -p "问题"` | **常驻 `-p`（本文主角）** |
|---|---|---|---|
| 怎么结束 | 人退出 | 答完就退 | stdin 不关就一直活着 |
| 输入 | 键盘 | 命令行参数 | stdin 持续写 JSON |
| 输出 | 终端界面（给人看） | 一段文本或一个 JSON | 一行一个事件的 JSON 流 |
| 上下文 | 进程里 | 每次从零（可 `--resume`） | 进程里自动保持 |
| 适合 | 自己用 | 脚本、定时任务（§22） | **聊天后端** |

官方把“stdin 持续喂 stream-json”叫 streaming input mode【官方】。这条通道和官方 Agent SDK 底层用的是同一条，事件格式同源【官方】。所以本文的知识 95% 可以平移到 SDK。

### 0.5 为什么选这条路

| | 抓终端屏幕（tmux） | 直接调 Anthropic API | Agent SDK | **常驻 `-p`** |
|---|---|---|---|---|
| 计费 | 订阅 | 按 token 付钱 | 订阅或 API | **订阅** |
| 逐字 / 思考 / 工具事件 | 只能抠屏幕文字 | 自己拼 | 有类型 | 原生就有 |
| 工具、技能、MCP、CLAUDE.md | 有 | 全部自己造 | 有 | 有 |
| 依赖 | tmux | HTTP | npm/pip 包 | **只要 claude 本体** |
| 抗升级 | 界面一改就崩 | 稳 | 稳 | 事件格式稳，仍建议锁版本 |

一句话：**想用订阅、想要 CC 的整套生态、又想要自己的前端，这是最短的路。**

---

## §1 准备环境

### 1.1 安装

1. 装 Node.js 18 或更新版本（官网下载安装包即可）。终端里 `node -v` 能看到版本号就行。
2. 装 Claude Code：按官方文档安装，装好后 `claude --version` 能看到版本号。
3. 记下 claude 的完整路径：`which claude`。后端 spawn 时可以直接写 `"claude"`，但用 launchd 之类托管时 PATH 可能不同，写完整路径最稳。

### 1.2 登录订阅并验证

```bash
claude            # 第一次运行会让你登录，选订阅账号（Pro / Max）
claude -p "ping"  # 有回答 = 通了
```

### 1.3 第一个坑：`ANTHROPIC_API_KEY`

**只要环境里有 `ANTHROPIC_API_KEY`，CC 就无条件走 API 计费，不走订阅**【官方】。你的机器上可能因为别的项目设过它。所以：

- 后端 spawn claude 时，**一定要从环境变量里删掉它**（§2.1 的代码里有 `delete env.ANTHROPIC_API_KEY`）；
- 自己在终端里测的时候用 `env -u ANTHROPIC_API_KEY claude -p "ping"`。

### 1.4 先看一眼事件流长什么样

```bash
claude -p "介绍一下你自己" --output-format stream-json --verbose --include-partial-messages
```

屏幕上会刷出很多行 JSON，每行一个事件。**这就是你后端要处理的全部原材料。** 先不用看懂，§3.2 有逐个解释。

### 1.5 登录保活：`-p` 跑几个小时就“掉登录”

【实测，2026-07 调研结论】订阅的 access token 只活 6–8 小时。交互式 CC 会自动刷新它，但**纯 `-p` 子进程不执行刷新**，过期就报 `Not logged in`。这不是你配置错了。解法按推荐顺序：

1. **`claude setup-token`**【官方】：交互授权一次，拿到一个一年期的长效 token，然后在后端环境里设 `CLAUDE_CODE_OAUTH_TOKEN=<token>`。专为无人值守设计，也不依赖 macOS 钥匙串。
2. **机器上一直开着一个日常用的交互式 CC**（终端或桌面端）【我家】：它刷新时会把新 token 写回钥匙串，`-p` 进程每次读到的都是新的。我们家就是这个形态。
3. **监控兜底**：监听 `system/api_retry` 事件里的 `authentication_failed`，或定时跑 `claude -p "ping" --output-format json` 看 `is_error`，发现了提醒你重新登录。

另外三个常被误认成“掉登录”的情况：
- macOS 上用 launchd / cron 起的进程有时读不到钥匙串 → 用方案 1，或把定时任务放进常驻后端里跑；
- 环境里有 `ANTHROPIC_API_KEY`（§1.3）；
- 多台机器 / 多个进程同时刷新同一个账号的 token，会互相把对方踢下线。

---

# 第二部分 · 跟着搭

> 下面每一步都给出“这一步的代码”和“做完应该看到什么”。全部拼起来就是附录 D 那份完整骨架（**实测跑通**）。

## §2 第一步：起一条常驻进程

### 2.1 spawn 代码，逐个参数解释

```js
import { spawn } from "node:child_process";

const procs = new Map(); // chatId → claude 进程。一个窗口一条，千万别共用，不然上下文会串

function getProc(chatId, resumeId) {
  const live = procs.get(chatId);
  if (live && !live.killed) return live;

  const args = [
    "--print",                            // ① 非交互模式
    "--input-format", "stream-json",      // ② stdin 持续吃 JSON → 进程常驻
    "--output-format", "stream-json",     // ③ stdout 一行一个事件
    "--verbose",                          // ④ 不带就只有很少几种事件
    "--include-partial-messages",         // ⑤ 逐字、逐念头的 delta
    "--model", "sonnet",                  // ⑥ 模型
    "--system-prompt-file", "./.tmp-prompt.md", // ⑦ 换掉官方系统提示词（§7）
    "--system-prompt-snapshot", "off",    // ⑧ resume 时用新提示词（§7.4）
    "--thinking-display", "summarized",   // ⑨ 让思考链有可读文本（附录 E）
    "--tools", "Read",                    // ⑩ 内置工具只留 Read（§9）
    "--permission-mode", "dontAsk",       // ⑪ 没放行的工具一律拒绝（§11）
  ];
  if (resumeId) args.push("--resume", resumeId); // ⑫ 接回旧会话（§15）

  const env = { ...process.env, CHAT_ID: chatId }; // ⑬ 窗口 id 一路传给 MCP（§8.5）
  delete env.ANTHROPIC_API_KEY;                    // ⑭ 必删（§1.3）

  const proc = spawn("claude", args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  // ……解析 stdout 见 2.2
  procs.set(chatId, proc);
  return proc;
}
```

| # | 参数 | 为什么 |
|---|---|---|
| ① | `--print` | 非交互模式。**一定要显式写**：不写的话某些版本也接受下面的参数，但启动失败（比如登录过期）时会掉进一个永远不吐事件的交互进程，表现为“发了消息没反应”【我家】 |
| ② | `--input-format stream-json` | 常驻的钥匙。默认的 text 模式读到 stdin 结束就退出 |
| ③ | `--output-format stream-json` | 输出 NDJSON 事件流 |
| ④ | `--verbose` | 官方没说“必须”，但不带就拿不到逐轮事件，实践必带 |
| ⑤ | `--include-partial-messages` | 才有 `stream_event`（打字机效果、思考直播） |
| ⑥ | `--model` | 别名（`opus` / `sonnet` / `haiku` / `fable`）或完整 id。**进程启动时定死，活着的进程换不了**（§17） |
| ⑦ | `--system-prompt-file` | 用你的人格档替换官方系统提示词主体 |
| ⑧ | `--system-prompt-snapshot off` | 默认 `on` 时，`--resume` 会沿用第一次拍下的旧提示词，你改了人格档也不生效【实测】 |
| ⑨ | `--thinking-display summarized` | 新模型默认只回传思考的签名、不给文字，加这个才有可读摘要【隐藏】 |
| ⑩ | `--tools` | 限定内置工具。陪伴场景用不到大部分工程工具，每个工具的说明都占 token |
| ⑪ | `--permission-mode dontAsk` | 后台进程没人能点“允许”，没放行的直接拒绝，不会卡住 |
| ⑫ | `--resume <session_id>` | 接回 CC 自己存的会话记录 |
| ⑬ | 自定义环境变量 | claude 拉起 MCP 子进程时会继承环境变量，MCP 就知道自己在哪个窗口 |
| ⑭ | 删 API key | 不删就走 API 计费 |

> **`cwd` 很重要**：进程的工作目录决定了 ① CC 读哪个项目的 `CLAUDE.md`、`.claude/skills/`、`.claude/commands/`；② 转录文件存在哪（§15.1）；③ `--resume` 去哪找会话。**同一个窗口每次 spawn 都要用同一个 cwd**。

### 2.2 按行解析 stdout

stdout 是一段一段（chunk）来的，**一个 chunk 可能在一行 JSON 的中间断开**，所以要攒着、按换行切、最后不完整的那段留到下一次：

```js
proc._listeners = new Set();
let buf = "";
proc.stdout.setEncoding("utf8"); // 中文等多字节字符也可能被切开，交给 Node 拼好
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop();              // 最后一段可能不完整，留着
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    for (const fn of [...proc._listeners]) fn(ev); // 分给所有正在听的人
  }
});
proc.stderr.on("data", (c) => console.error("[claude stderr]", String(c).slice(0, 300)));
proc.stdin.on("error", () => {});          // 进程死了还往里写，别让后端崩
proc.on("close", () => { if (procs.get(chatId) === proc) procs.delete(chatId); });
```

**为什么用“监听者列表”而不是直接写死一个处理函数**：同一条进程上会有不同的人在听——这一轮的 `/chat` 请求、缓存保温（§20）、后台任务回报（§18）。谁来了就挂上，用完就摘。

### 2.3 做完应该看到什么

还没发消息时，进程会安静地等着（它在等 stdin）。`ps aux | grep claude` 能看到它。CC 启动需要几秒（要拉起 MCP 等），第一句话会比后面慢一些。

---

## §3 第二步：喂一句话、收一轮回复

### 3.1 往 stdin 写什么

```js
proc.stdin.write(JSON.stringify({
  type: "user",
  message: { role: "user", content: "今天好累" },
}) + "\n");        // 结尾的换行不能少——一行一条
```

`content` 可以是字符串，也可以是数组（文字和图片混排，§6.1）。

### 3.2 stdout 会吐出哪些事件

| 事件（`type` / `subtype`） | 什么时候出现 | 你拿它做什么 |
|---|---|---|
| `system` / `init` | 进程启动后第一条 | 拿 `session_id`；能看到加载了哪些工具、MCP、skill |
| `system` / `api_retry` | API 出错准备重试 | 限流、过载、认证失败的监控（字段 `error`：`rate_limit` / `overloaded` / `authentication_failed`…）【官方】 |
| `system` / `status`（`status: "compacting"`） | 正在自动压缩上下文 | 网页上显示“整理记忆中”【我家】 |
| `system` / `compact_boundary` | 压缩完成 | `compactMetadata` 里有压缩前后 token 数【我家】 |
| `system` / `background_tasks_changed` | 后台任务清单变了 | `tasks` 数组 = 还在跑的后台任务（§18）【我家】 |
| `system` / `task_notification` | 后台任务完成通知 | 预告“马上会自己再开一轮”（§18）【我家】 |
| `stream_event` | 开了 `--include-partial-messages` 才有 | 原始 API 流事件：逐字、逐念头（3.3） |
| `assistant` | 每次 API 调用的完整消息 | 里面有 `tool_use`（要调工具）；`uuid` 用于 resume（§15） |
| `user` | 工具执行完的结果回填 | `tool_result`，配对显示工具条 |
| `result` | **这一轮结束** | 收尾、落库、记账（3.4） |
| `control_response` | 你发的控制请求的回执 | §19 |

> 每个事件都带 `session_id`。拿到后存进你的聊天记录，下次 `--resume` 要用。

### 3.3 `stream_event` 里面的顺序

```json
{ "type": "stream_event",
  "event": { "type": "content_block_delta", "index": 1,
             "delta": { "type": "text_delta", "text": "嗯，" } },
  "session_id": "…", "parent_tool_use_id": null }
```

一次 API 调用里 `event.type` 的顺序：

```
message_start                          ← 这次调用开始（带 usage 和实际模型名）
  content_block_start (thinking)       ← 开始思考
    content_block_delta thinking_delta ×N
  content_block_stop
  content_block_start (text)           ← 开始说话
    content_block_delta text_delta ×N
  content_block_stop
  content_block_start (tool_use)       ← 要调工具（参数用 input_json_delta 流出来）
  content_block_stop
message_delta                          ← 本次调用的 stop_reason、输出 token
message_stop
```

**一轮回复可能包含多次 API 调用**：模型调工具 → 工具出结果 → 再调一次 API 接着说。每次调用都有自己的 `message_start`。整轮只有最后一个 `result`。

注意：子代理（subagent）的逐字 delta 不转发，只有主会话有 `stream_event`【官方】。

### 3.4 一轮的边界：开门和关门

**关门**：看到 `type: "result"` 就是这一轮结束了。

**开门**：要等到**本轮第一个 `message_start`**。【我家实测】同一条进程连续聊时，新消息写进去之后，stdout 偶尔会先吐出一些**上一轮尾巴**的事件，然后才是本轮的 `message_start`。不拦的话，上一轮的结尾会被重复拼进这一轮回复开头（我们管这叫 echo）。所以：

```js
let inMyTurn = false;
const onEvent = (ev) => {
  if (ev.type === "stream_event" && ev.event?.type === "message_start") inMyTurn = true;
  if (!inMyTurn) {
    // 门还没开：只认一种例外——启动就失败的错误（见 3.5）
    if (ev.type === "result" && ev.is_error) finish(ev.result);
    return;
  }
  // ……正常处理
  if (ev.type === "result") finish(ev.is_error ? ev.result : null);
};
```

`result` 帧的样子：

```json
{ "type": "result", "subtype": "success", "is_error": false,
  "result": "最后一段正文", "session_id": "…", "num_turns": 2,
  "duration_ms": 8123, "total_cost_usd": 0.07,
  "usage": { "input_tokens": 12, "output_tokens": 340,
             "cache_read_input_tokens": 52000, "cache_creation_input_tokens": 1800 } }
```

- `subtype` 可能是 `success` / `error_max_turns` / `error_max_budget_usd` / `error_during_execution` 等，全都带 `session_id` 和 `usage`【官方】。
- **`result` 字段只有最后一段正文**。模型说一段、调个工具、再说一段时，前面那段不在里面。完整回复要用你自己从 `text_delta` 攒起来的（§5.1）【我家】。
- `total_cost_usd` 是**本地估算，不是账单**【官方】，而且是**从进程启动开始的累计值**，`--resume` 后还会接着上个进程往上加【我家】。想显示单条费用，要么自己用 `usage` 和价目表算，要么记下上一轮的累计值做差。

### 3.5 启动就失败的两道保险

1. **`is_error` 的 `result` 在门开之前也要处理**：没登录、模型名写错时，进程不会发 `message_start`，只会发一个 `is_error: true` 的 `result`（例如 `"Not logged in · Please run /login"`）。按 3.4 的守门逻辑它会被当成“上一轮残流”丢掉，网页就一直转圈。
2. **启动超时**：写进 stdin 后 90 秒还没看到 `message_start` 就报错收尾【我家】。90 秒远长于 MCP 启动时间，又不至于让用户等到天荒地老。

```js
const startTimer = setTimeout(() => { if (!inMyTurn) finish("90 秒还没开始回复"); }, 90_000);
```

### 3.6 做完应该看到什么

用一个小脚本 spawn → 写一句 → 打印收到的每个事件的 `type`，你应该依次看到：`system/init` → `stream_event` ×很多 → `assistant` → `result`。

---

## §4 第三步：用 SSE 推给网页

### 4.1 为什么用 SSE

SSE（Server-Sent Events）就是**一个不马上结束的 HTTP 响应**，服务器一段一段往里写 `data: …\n\n`。比 WebSocket 简单：不用握手、不用心跳协议，穿过反向代理和 Cloudflare 隧道也比较稳。聊天是“问一次、流一段”，正好合适。

### 4.2 响应头

```js
res.writeHead(200, {
  "Content-Type": "text/event-stream",       // 告诉浏览器这是 SSE
  "Cache-Control": "no-cache, no-transform", // 别缓存、别让中间代理改写或压缩
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",                 // 告诉 nginx 一类代理别攒着不发
});
res.flushHeaders?.();
const write = (obj) => {
  if (res.writableEnded) return;
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
};
```

### 4.3 推什么事件：自己定一套精简的

**不要把 CC 的原始事件原样转发给网页**：太多、太碎，而且以后 CC 改格式时前端也得跟着改。后端翻译成你自己的一套。我家用的清单，供参考：

| SSE 事件 | 内容 | 网页拿它做什么 |
|---|---|---|
| `session` | `sessionId` | 记下来 |
| `inject_debug` | 这一轮除了用户的话还塞了什么 | “注入透视”面板（调试用） |
| `surfaced` | 这一轮浮现了哪些记忆 | 显示“想起了……” |
| `thinking_start` / `thinking_delta` | 思考开始 / 思考增量 | 思考区逐字显示 |
| `text_start` / `text_delta` | 正文开始 / 正文增量 | 正文逐字显示 |
| `tool_call` | `{id, name, input, done, result}` | 工具条：调用时一条“进行中”，结果回来同一条标“完成” |
| `voice` / `image` / `sticker` | MCP 工具中途推来的语音、图（§8.7） | 当场插进这条气泡 |
| `compact_start` / `compact_done` | 压缩进度 | 显示“整理中” |
| `model_routed` | 请求的模型 vs 实际的模型 | 提醒“被换成了别的模型”（§5.5） |
| `done` | 用量、费用、上下文大小、后台任务数 | 收尾 |
| `error` | 错误文本 | 显示错误 |

最小版只要 `thinking` / `text` / `tool` / `done` / `error` 五种（附录 D 就是这样）。

### 4.4 心跳：别让代理以为你断了

模型思考或者跑工具时，可能几分钟一个字都不吐。Cloudflare 隧道、nginx 之类会把“长时间没数据”的连接掐掉。解决：每 15 秒写一行 SSE 注释（冒号开头的行，浏览器会忽略）【我家】：

```js
const beat = setInterval(() => { if (!res.writableEnded) try { res.write(": ping\n\n"); } catch {} }, 15_000);
// 这一轮结束时 clearInterval(beat)
```

### 4.5 用户关掉网页 ≠ 停止生成

```js
req.on("close", () => {
  // 什么都不做：监听者照样挂着，生成照样跑完，回复照样存进聊天记录
});
```

这是陪伴场景最重要的一条：**用户锁屏、切到别的 App、地铁里断网，回复都不会丢。** 下次打开时网页从后端拉记录就能看到（§13）。“停止”必须是用户明确点了停止键（§14）。写 SSE 时所有 `res.write` 都包 try，往已断开的连接写不能让后端崩。

### 4.6 网页怎么读

浏览器自带的 `EventSource` 只支持 GET，没法 POST 消息体，所以用 `fetch` + 读流：

```js
const res = await fetch("/chat", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chatId, text }) });
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "", gotEnd = false;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const events = buf.split("\n\n");   // SSE 用空行分隔事件
  buf = events.pop();                 // 最后一段可能不完整
  for (const evt of events) {
    const line = evt.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;              // ": ping" 心跳没有 data，跳过
    const data = JSON.parse(line.slice(6));
    if (data.type === "text") showText(data.text);
    if (data.type === "done" || data.type === "error") gotEnd = true;
    // ……
  }
}
if (!gotEnd) await waitForServer();   // 流断了但没收到结尾 → 去后端等结果（§13）
```

**判断“正常结束”还是“断流”**：只看有没有收到 `done` / `error`。流结束了却没收到它们，就是断了。

### 4.7 做完应该看到什么

```bash
curl -N -X POST http://127.0.0.1:3456/chat -H 'Content-Type: application/json' -d '{"chatId":"test","text":"你好"}'
```

`-N` 关掉 curl 的缓冲，你会看到 `data: {"type":"text","text":"你"}` 这样一行一行往外蹦，最后一行是 `done`。

---

## §5 第四步：流式渲染与落库

### 5.1 segments：按到达顺序存

一条回复的真实结构是交错的：`思考 → 正文 → 工具 → 思考 → 正文`。**不要把它拆成“思考一桶、正文一桶、工具一桶”**，顺序会丢。我家用一个 `segments` 数组按事件到达顺序存【我家】：

```js
const segments = [];
const last = () => segments[segments.length - 1];
const append = (kind, t) => {          // 同类型接着写，换类型就开新段
  if (last()?.kind !== kind) segments.push({ kind, text: "" });
  last().text += t;
};
// thinking_delta → append("thinking", …)
// text_delta     → append("text", …)
// tool_use       → segments.push({ kind: "tool", id, name, input, done: false })
```

网页和落库都用同一个 `segments`，渲染时按顺序画。另外从它派生 `content`（所有正文段用空行连起来），给搜索、导出之类的老功能用。

### 5.2 让思考链显示出来

新模型默认只回传思考的签名、不回传文字，所以你会看到思考块存在、内容却是空的。三条路：

| 做法 | 状态 |
|---|---|
| spawn 参数加 `--thinking-display summarized` | 【隐藏】文档和 `--help` 都没写，但实测有效，我家一直在用。随版本可能失效，升级后先验 |
| `/config thinking=…` 语法（官方说在 `-p` 下也能用，2.1.181+） | 【官方】取值细节请自己实测 |
| `--effort low/medium/high/xhigh/max` | 【官方】影响思考多少，不是显示开关 |

settings 里的 `showThinkingSummaries: true` 在 `-p` 下**不生效**（源码里有“必须是交互模式”的判断）【实测】。完整来龙去脉见附录 E。

### 5.3 工具调用条

- `assistant` 事件的 `message.content` 里，`type: "tool_use"` 的块 = 模型要调工具（有 `id`、`name`、`input`）；
- 随后 `user` 事件的 `message.content` 里，`type: "tool_result"` 的块 = 结果（`tool_use_id` 对得上前面的 `id`）。

配对之后，网页先显示一条“进行中”，结果回来同一条标成“完成”。【我家】额外做了三件事：

1. **给工具起人话名字**：`Read` + 文件名 → “看 xxx.md”；`mcp__music__song_search` → “用 music（song_search）”。用户看到的是“他在翻日记”，不是一串英文；
2. **结果截断后再存**：工具结果动辄几十 KB，存进聊天记录前截到 20K 字符，末尾注明总长；
3. **工具结果里的图片也给用户看**：`tool_result` 的 content 里如果有 `{type:"image", source:{type:"base64"}}`，落盘成文件、按内容哈希命名（同一张图只存一份），把 URL 挂到工具条上。

### 5.4 显示上下文用了多少

- **用 `message_start.message.usage`**：`input_tokens + cache_creation_input_tokens + cache_read_input_tokens` = 这次 API 调用的完整上下文大小。一轮有多次调用时取**最后一次**；
- **不要用 `result.usage`**：它是整轮多次调用的累加，工具调用一多就虚高好几倍【我家】。

更细的分块（系统提示、工具、消息各占多少）可以用控制请求问 CC（§19）。

### 5.5 发现“模型被悄悄换了”

`message_start.message.model` 是**实际**服务这次调用的模型。请求的是完整模型 id 时，拿它比对一下，对不上就推一个 `model_routed` 事件提醒网页【我家】。高峰期偶尔会遇到。

### 5.6 落库

我家一个窗口一个 JSON 文件（`chats/<chatId>.json`），一条助手消息大致长这样：

```json
{
  "role": "assistant",
  "content": "正文（从 segments 派生）",
  "thinking": "思考（从 segments 派生）",
  "segments": [ {"kind":"thinking","text":"…"}, {"kind":"tool_use","call":{"id":"…","name":"Read","done":true,"result":"…"}}, {"kind":"text","text":"…"} ],
  "model": "显示用的模型名",
  "ccSessionId": "这一轮所在的 CC 会话 id",
  "ccUuid": "这一轮最后一条带正文的 assistant 事件的 uuid",
  "contextTokens": 53812,
  "time": "2026-11-07T10:47:24.000Z"
}
```

- **`ccSessionId` 和 `ccUuid` 是 `--resume` 的钥匙**（§15）。`ccUuid` 取 `assistant` 事件的 `uuid`，**只取含正文的那条**——停在工具调用中间的不算，这样截转录时不会留下半截工具调用；
- **什么时候写**：`result` 到了再写一次整条。停止键、出错也要写，把已经流出来的半截存下（§14）；
- **防重复兜底**【我家】：写库前，如果新回复开头几段和上一条回复的结尾几段**一字不差**，就把这几段截掉。这是 3.4 守门之外的第二道保险。

### 5.7 先存用户的话，再开始生成

用户点发送时，**网页先调接口把这句存进记录，再调 `/chat`**【我家】。好处是：后端崩了、claude 起不来，用户那句话也不会丢。代价是重建历史（§15.4）时要记得把“刚存的这句”从历史尾巴上去掉，否则会发两遍。

---

## §6 第五步：发图片

### 6.1 两条路

**A. 图片直接塞进消息**【官方】：`content` 用数组，文字和 base64 图片混排。

```js
proc.stdin.write(JSON.stringify({
  type: "user",
  message: { role: "user", content: [
    { type: "text", text: "看这张照片" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
  ] },
}) + "\n");
```

**B. 图片存成文件，让模型自己用 Read 工具看**【我家】：

```js
// 1. 网页先把图片传上来，后端存进 uploads/，返回绝对路径
// 2. 这一轮的文字后面加一句：
content += `\n\n[对方发了一张图片，请用 Read 工具查看：${imagePath}]`;
```

Read 工具本身能读图片，模型会自己调用、看到图、再回复。

### 6.2 我家为什么走 B

1. **转录轻**：A 会把整张图的 base64 写进 CC 的会话记录，聊久了转录又大又慢；B 里只有一个文件路径；
2. **以后还能再看**：记忆里写着“那天她发过一张图〔图 路径〕”，以后聊到这件事，模型可以按需再 Read 一次；
3. **冷重建时不丢**（§15.4）：历史拍平成文字时，文字里的路径照样能用；
4. **用户能看到他看了**：工具条上会出现“看 chat-xxx.jpg”。

B 的代价：要放行 Read 工具，而且图片要放在 claude 进程读得到的地方（工作目录下最省事；放在别处要 `--add-dir`）。

### 6.3 多张图

一次发几张，就在文字后面列出全部路径，让模型逐张看完一起回复：

```
[对方一次发了 3 张图片，请用 Read 工具逐张查看这些文件：
/abs/path/a.jpg
/abs/path/b.jpg
/abs/path/c.jpg
看完一起回复]
```

### 6.4 大小限制

- stdin 单条消息上限 10MB【官方】。走 A 时大图先压缩；
- 上传接口自己也要设上限（附录 D 里是 20MB）；
- 手机照片很大，可以在上传时缩一下长边（我家用 macOS 自带的 `sips -Z <边长>` 做缩略图）。

---

# 第三部分 · 让它成为“他”：提示词、工具、能力

## §7 系统提示词：替换与拼装

### 7.1 `--system-prompt-file` 换掉了什么、留下了什么

CC 默认的系统提示词是一大份“软件工程师说明书”：代码风格、commit 规范、做事方法……对陪伴角色全是噪音。`--system-prompt-file 你的人格档.md` 会把这份说明书的**主体**换成你的文件。

但它不是 100% 干净【实测，2026-07】：
- CC 会保留一句身份行（`-p` 下大意是“你是基于 Claude Agent SDK 的 agent”）和少量运行时信息（工作目录、日期等），几百字量级；
- **每个工具的使用说明不在系统提示词里，在工具定义里**（比如 commit 规范其实写在 Bash 工具的说明里）。想去掉它们要摘工具（§9），换提示词没用；
- `CLAUDE.md`、skill 清单、hook 输出是另外塞进上下文的，不受这个参数影响（§7.7、§10）。

### 7.2 四个相关参数

| 参数 | 作用 | 什么时候用 |
|---|---|---|
| `--system-prompt "文本"` | 替换，内容直接写在命令行 | 很短的提示词 |
| `--system-prompt-file 路径` | 替换，内容从文件读 | **陪伴场景用这个**：人格档往往几万字，命令行放不下 |
| `--append-system-prompt "文本"` | 保留官方那份，在后面追加 | 想要“会写代码的 CC + 一点人设” |
| `--append-system-prompt-file 路径` | 同上，从文件读 | 同上 |

两种模式（交互 / `-p`）下都生效。

### 7.3 多块拼装

人格档别写成一个巨型文件，拆开各管各的，每次 spawn 前现读现拼【我家】：

```js
function buildPrompt() {
  return [
    read("user-profile.md"),    // 用户画像：她是谁
    read("system-prompt.md"),   // 人格档：我是谁、我们的关系、故事
    read("tool-cheatsheet.md"), // 工具小抄：前端有哪些机制、什么时候用哪个工具
  ].filter(Boolean).join("\n\n"); // 某块空着就整块不占位
}
writeFileSync(".tmp-prompt.md", buildPrompt()); // 拼好写临时文件，交给 --system-prompt-file
```

- **顺序有讲究**：先认人、再认自己、工程说明垫底；
- **不同场景用不同拼法**：比如“跑团房间”只要人格核心、不要工具小抄；接别家模型的窗口用另一份人格档。**每种拼法写不同的临时文件名**，否则同时开着的窗口会互相覆盖；
- **临时文件加进 `.gitignore`**。

### 7.4 改了人格档怎么生效：杀进程重开 + 关快照

系统提示词是**启动参数**，活着的进程改不了。所以每轮 `/chat` 都比对一下：

```js
const live = procs.get(chatId);
if (live && !live.killed && live._promptText !== buildPrompt()) {
  live.kill();          // 旧进程退役；下面重新 spawn（会带 --resume 接回对话）
}
```

**⚠️ 必踩的坑：系统提示词快照**【官方 + 实测 2026-11-07】。CC 默认（`--system-prompt-snapshot on`）会在会话**第一次**请求时把系统提示词拍下来，之后**每次请求、包括 `--resume` 都原样复用那份**，就算你启动时传了新的提示词也不管用，直到会话被压缩。对照实验：

```bash
# 第一次：名字叫阿甲
claude -p "你叫什么名字？" --system-prompt "你的名字叫阿甲" --output-format json   # → 阿甲
# resume 同一会话，换成阿乙
claude -p "你叫什么？" --resume <id> --system-prompt "你的名字叫阿乙"              # → 还是阿甲！
# resume 同一会话，换成阿丙，并关掉快照
claude -p "你叫什么？" --resume <id> --system-prompt "你的名字叫阿丙" --system-prompt-snapshot off   # → 阿丙
```

所以：**如果你的热更新是“杀进程 + resume”，一定要带 `--system-prompt-snapshot off`，否则热更新等于没做。** 代价是提示词一变，这个窗口的缓存前缀就全部作废、下一轮整窗重写一次缓存（§20）。人格档不常改的话，这点代价可以接受。

**关掉之后，平时会不会伤缓存？** 快照记在转录文件里，是一条 `type: "attachment"`、`attachment.type: "prompt_snapshot"` 的记录，打开就能看到里面装了什么。我家用 `--system-prompt-file` 的窗口，快照里只有提示词文件的全文，外加一段固定的说明，**没有日期、git 状态这类每次都会变的东西**【实测 2026-11-07】。所以人格档不改时，关掉快照后每次请求的前缀照旧一模一样，缓存不受影响。如果你用的是官方默认提示词，或者 `--append-system-prompt`，先看一眼你自己的快照里有没有会变的段落再决定。

### 7.5 什么放系统提示词，什么放每轮消息

| 放系统提示词 | 放每轮消息（`<system-reminder>`） |
|---|---|
| 稳定的：人格、关系、故事、用户画像、工具使用说明 | 会变的：当前时间、这轮浮现的记忆、状态面板、文风提醒、刚发生的事件 |
| 改了要重开进程、作废缓存 | 自然地成为对话的一部分，跟着对话一起被缓存 |

**文风为什么不放系统提示词**【我家】：如果中途切换文风，启动时写进系统提示词的旧文风和消息里的新文风会变成两个互相打架的权威。文风只走消息流：开窗第一轮发全文、切换时发全文、平时只发一句“注意保持当前文风”。

### 7.6 每轮注入怎么拼

写进 stdin 的不只是用户那句话。我家每轮的拼装顺序：

```
<system-reminder>Current time: 2026-11-07 10:47</system-reminder>   ← 时间
<system-reminder>记忆库浮现：……</system-reminder>                   ← 这轮相关的记忆（没有就不发）
<system-reminder>行文风格：……</system-reminder>                     ← 文风（全文 或 一句锚）
<system-reminder>刚刚她按了某个按钮，结算结果是……</system-reminder>   ← 即时事件，紧贴她的话

她的原话

<system-reminder>状态面板：……</system-reminder>                     ← 面板数据（放在她的话后面）
[对方发了一张图片，请用 Read 工具查看：/path/to/img.jpg]            ← 图片指引
```

- **为什么用 `<system-reminder>` 标签**：CC 自己往上下文里塞东西时就用这个标签，模型已经习惯把它理解成“系统附带的信息，不是用户说的话”。人格档里再交代一句“开头的 system-reminder 是系统信息，自然用上、不要复述”【我家】；
- **节拍**：长规则不要每轮发。进程第一轮发全文 → 平时只发一行数据或一句提醒 → 每隔 N 轮（我家 40）重发一次全文兜底，防止对话太长时被遗忘；规则文本改了也立刻重发；
- **新窗口第一句可以带一包“开窗记忆”**：最近的日记、核心记忆、关系状态，用户开新窗说第一句话时，他已经“记得”了（§15.5）；
- **把这一轮实际注入了什么，随 SSE 推给网页并存下来**（我家叫“注入透视”）。调提示词时非常有用：模型表现怪，先看它这轮到底收到了什么。

### 7.7 别忘了 `CLAUDE.md` 也会被读

`-p` 默认和交互模式一样，会读工作目录（及上级目录）的 `CLAUDE.md`，以及你用户目录的 `~/.claude/CLAUDE.md`【官方】。两个影响：

1. **如果后端的工作目录就是你的代码仓库**，陪聊的 AI 会读到你写给编程助手的规矩。要么让 claude 进程跑在单独的目录，要么把 `CLAUDE.md` 写成两边都适用的；
2. **可以拿来当“说明书目录”**【我家】：`CLAUDE.md` 里只写“遇到 X 情况就去 Read Y 文件”，长篇说明放在各自的文件里，用到才读，平时不占上下文。

---

## §8 挂 MCP：给他装手

### 8.1 MCP 是什么

MCP 是一种协议：你写一个小程序（MCP server），声明“我有这几个工具、每个工具要什么参数”，claude 就能在对话里调用它们。发语音、查对方在哪、记账、点歌、读日记……任何你能用代码做的事，都能变成他手里的工具。

### 8.2 配置文件

一个 JSON 文件（比如 `.mcp.json`），列出你所有的 MCP server：

```json
{
  "mcpServers": {
    "notebook": {
      "command": "node",
      "args": ["mcp/notebook.mjs"],
      "env": { "APP_URL": "http://127.0.0.1:3000", "APP_TOKEN": "你的后端口令" }
    },
    "location": {
      "command": "/path/to/venv/bin/python",
      "args": ["-m", "geo.mcp_server"]
    },
    "music": {
      "type": "http",
      "url": "http://127.0.0.1:8770/mcp"
    }
  }
}
```

- **stdio 型**（默认）：claude 把它当子进程拉起来，用 stdin/stdout 说话。`args` 里的相对路径按 claude 进程的工作目录算；
- **http 型**：MCP 自己是个常驻服务，claude 通过 URL 连过去。适合启动慢、或者想被多个窗口共用的服务；
- `env` 里写的口令是明文，**这个文件别提交到公开仓库**。

挂上去：

```js
args.push("--mcp-config", ".mcp.json", "--strict-mcp-config");
```

`--mcp-config` 可以给多个，也可以直接给 JSON 字符串【官方】：

```js
args.push("--mcp-config", ".mcp.json", JSON.stringify({ mcpServers: { extra: { command: "node", args: ["x.mjs"] } } }));
```

### 8.3 `--strict-mcp-config`：只认你给的

不加的话，CC 还会加载你用户级配置里的 MCP、claude.ai 账号里的连接器……你自己写代码用的日历、云盘工具会全部塞进陪聊 AI 的工具箱，又占 token 又容易被乱用。**加上它，就只有 `--mcp-config` 里列出的那些。**

### 8.4 自己写一个 MCP server

协议很简单：stdin 一行一个 JSON-RPC 请求，stdout 一行一个回复。只需要处理三个方法：

| 方法 | 你要回什么 |
|---|---|
| `initialize` | 协议版本、能力声明（`{tools:{}}`）、server 名字 |
| `tools/list` | 工具清单：每个工具的 `name`、`description`、`inputSchema`（JSON Schema） |
| `tools/call` | 执行工具，回 `{content:[{type:"text", text:"结果"}]}` |

完整可跑的例子见附录 D 的 `mini-mcp.mjs`（零依赖，50 行）。要点：

- **stdout 只能写协议消息**。调试信息一律写 stderr，否则 claude 会解析出错；
- **工具说明写给模型看**：什么时候该用、什么时候别用、参数什么意思。我家的格式是“一句话说明 + Use this when: 列表 + Notes:”。说明写得好，模型才会在对的时机调用；
- 工具出错就回 JSON-RPC error，模型会看到错误信息并自己处理。

### 8.5 MCP 怎么知道自己在哪个窗口

MCP 是 claude 拉起的子进程，**环境变量从 claude 继承**；claude 的环境变量又是你 spawn 时给的。所以 spawn 时塞一个窗口 id，MCP 里就能读到【实测】：

```js
// 后端 spawn claude 时
const env = { ...process.env, CHAT_ID: chatId };
// MCP 里
const chatId = process.env.CHAT_ID;   // 发语音、存东西时知道该落进哪个窗口
```

附录 D 的实测里，模型调 `whoami` 工具，答出了正确的窗口 id `t1`。

### 8.6 MCP 怎么跟你的后端说话

MCP 是独立进程，碰不到后端的内存。它要存东西、发消息，就**调后端自己的 HTTP 接口**：

```js
// MCP 里
await fetch(`${process.env.APP_URL}/api/voice/send`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `auth=${process.env.APP_TOKEN}` },
  body: JSON.stringify({ chatId: process.env.CHAT_ID, text }),
});
```

后端的鉴权要放它进来：带口令，或者对来自本机（127.0.0.1）的 `/api/` 请求放行【我家两种都做了】。

### 8.7 工具干到一半，往当前这一轮推东西

场景：他在回复中途调 `send_voice` 发了一条语音，用户应该**立刻**在这条气泡里看到语音条，而不是等整轮结束。

做法【我家】：后端维护一张“正在生成”的登记表，`/chat` 开始时登记、结束时注销：

```js
const activeGenerations = new Map(); // chatId → 这一轮的句柄

// /chat 里
activeGenerations.set(chatId, {
  push: (evt) => write(evt),                 // 往这一轮的 SSE 里插一个事件
  attachVoice: (v) => pendingVoices.push(v), // 登记一下，落库时随这条回复一起存
  stop: () => { /* 停止键用，见 §14 */ },
});

// /api/voice/send（MCP 调过来的）
const gen = activeGenerations.get(chatId);
if (gen) {
  gen.attachVoice({ url, text });
  gen.push({ type: "voice", audioUrl: url, text });   // 网页当场出现语音条
} else {
  saveStandaloneMessage(chatId, { kind: "voice", url, text }); // 不在生成中（比如定时任务里调的）：单独存一条
}
```

图片、表情包、歌曲卡片都是同一个套路。

### 8.8 工具名的规则

MCP 工具在 claude 里的全名是 `mcp__<server名>__<工具名>`，比如 `mcp__notebook__write_note`。权限规则、禁用列表、hook 匹配都用这个全名。只写 `mcp__notebook` 表示这个 server 的全部工具（附录 D 里 `--allowedTools "Read,mcp__mini"` 实测可用）。

### 8.9 挂 claude.ai 账号里的连接器（比如 Gmail）

【我家实测】`--strict-mcp-config` 会把 claude.ai 账号里连好的连接器也一起屏蔽掉。想单独挂其中一个，在 MCP 配置里写一条 `claudeai-proxy` 类型：

```json
{ "mcpServers": { "gmail": { "type": "claudeai-proxy", "url": "<连接器的 MCP 地址>", "id": "mcpsrv_<你账号下的编号>" } } }
```

编号怎么找：跑一次 `claude -p "hi" --debug-file /tmp/cc-debug.log`，在日志里搜 `claude.ai proxy transport for server mcpsrv_`。连接器删掉重加之后编号可能会变。

挂这种权限大的连接器，一定要配 §11.2 的两道闸。我们只开了“读信 + 写草稿”。实际遇到过：连接器重连后从 23 个工具变成 30 个，多出来的正好是发信、回复、转发。如果只靠禁用名单，当天就漏了。

### 8.10 MCP 的坑

- **每个 claude 进程都会把所有 MCP 拉起一遍**。10 个窗口 × 14 个 MCP = 140 个进程。我家有一次攒到 38 个 claude × 14 = 532 个进程，内存打满、整机卡死。一定要做空闲回收（§20.3）；
- **改了 MCP 代码或配置，要重开 claude 进程才生效**。MCP 是 claude 启动时拉起的；
- **第一句话会慢**：要等所有 MCP 启动完。启动慢的 MCP 改成 http 型常驻服务；
- **Python 写的 MCP**：`command` 写虚拟环境里 python 的完整路径。

---

## §9 工具面：留哪些、摘哪些

### 9.1 三个参数别搞混

| 参数 | 管什么 | 例子 |
|---|---|---|
| `--tools <列表>` | **内置工具里哪些存在**。不在列表里的，模型根本看不到 | `--tools "Read,Write,Edit,Skill"`；`""` = 一个都没有；`"default"` = 全部 |
| `--disallowedTools <列表>` | **摘掉指定工具**（内置或 MCP 都行），模型看不到 | `--disallowedTools "Workflow,Agent,mcp__gmail__send_message"` |
| `--allowedTools <列表>` | **免确认放行**（权限）。不增减工具，只决定调用时要不要问 | `--allowedTools "Read,Bash(git *),mcp__notebook"` |

一句话：`--tools` 和 `--disallowedTools` 决定“有没有”，`--allowedTools` 决定“用的时候要不要批准”。多个名字用逗号连成一个字符串最稳【我家】。

### 9.2 看看你的版本到底有哪些内置工具

别照抄别人的清单，**看你自己机器上 `system/init` 事件的 `tools` 字段**。2.1.282 默认是这 32 个【实测 2026-11-07】：

```
Task, Artifact, ArtifactComments, ArtifactData, Bash, CronCreate, CronDelete, CronList,
DesignSync, Edit, EnterWorktree, ExitWorktree, ListAgents, Monitor, NotebookEdit,
PushNotification, Read, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, Skill,
TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, ToolSearch, WebFetch, WebSearch,
Workflow, Write
```

陪伴场景的建议：

| 工具 | 建议 | 理由 |
|---|---|---|
| Read | **留** | 看图片（§6）、翻自己的日记和记忆文件 |
| Write / Edit | 看需要 | 他要自己写日记、改记忆文件就留 |
| Skill | 有 skill 就**留** | 不留就调不动 skill（§10.2） |
| Bash | 看需要，慎重 | skill 里有动态命令要它；能力很大，权限要想清楚（§11） |
| WebSearch / WebFetch | 看需要 | 查资料、看链接 |
| Task / Agent（子代理） | 多半摘 | 说明加类型清单约 2.4k token，陪聊很少用【我家】 |
| Artifact 一家 | 摘 | 光说明就约 11.3k token，我家 10 个窗约 3300 轮一次没用过【我家】 |
| Workflow | 摘 | 关掉相关 skill 后，CC 会把整份编写手册塞进它的说明（3.5k → 20k 字符）【我家】 |
| Cron* / ScheduleWakeup / Monitor / PushNotification / RemoteTrigger | 摘 | 定时、推送你自己的后端来做 |
| EnterWorktree / ExitWorktree / NotebookEdit / ReportFindings / ListAgents / DesignSync | 摘 | 写代码用的 |

### 9.3 为什么值得摘

每个工具的说明都是工具定义的一部分，**每一轮请求都会发**。虽然有缓存，但它们实实在在占着上下文窗口，而且一变就要重写缓存。我家把前端的工具和 skill 清单瘦身之后，冷启动时的 skill 清单从 12.4k 字符降到 0.6k（§10.4）。

### 9.4 两种写法

- **白名单**（推荐新手）：`--tools "Read,Skill"`，只留你要的；
- **黑名单**（我家主线）：保留默认，再用 `--disallowedTools` 摘掉不要的。好处是 CC 新增的工具会自动出现；坏处也是这个，所以升级后要看一眼 init 里的工具清单。

其他相关参数：
- `--tools ""`：一个内置工具都不要，只用 MCP，或者纯聊天；
- `--restricted`（2.1.282 有）：去掉能跑命令、跑代码的工具和 WebFetch，并忽略各级 settings 文件【官方 help】【未实测】；
- `--safe-mode`：所有自定义（CLAUDE.md、skill、插件、hook、MCP……）全关，排查问题用【官方 help】。

---

## §10 Skills、斜杠命令、Hooks、插件、自动记忆

### 10.1 `-p` 下这些都照常加载

`-p` 默认加载的东西和交互模式一样【官方】：
- **用户级**：`~/.claude/`（skills、commands、settings.json 里的 hooks、插件、CLAUDE.md）；
- **项目级**：工作目录的 `.claude/`、`CLAUDE.md`；
- **本地级**：`.claude/settings.local.json`。

**注意：你自己写代码时装的用户级 hook、skill、插件，也会跑进陪聊进程。** 想控制加载哪几层，用 `--setting-sources`：

| 写法 | 效果 |
|---|---|
| 不写 | 三层全加载 |
| `--setting-sources project,local` | 不加载用户级 |
| `--setting-sources ""` | 三层都不加载，**订阅登录照常**【实测】 |
| `--bare` | 几乎什么都不加载，但**只认 API key，订阅登录直接失效**（报 `Not logged in`）【实测 + 官方 help】 |

### 10.2 写一个 skill

skill 是“用到才加载的说明书”。平时模型只看到名字和一句描述，判断需要时才调 Skill 工具把全文读进来。长篇规则放 skill 里，不占日常上下文。

目录结构：`.claude/skills/<名字>/SKILL.md`

```markdown
---
name: diary
description: 写日记的方法。一天聊完要收尾、或用户说"写日记"时调用。
allowed-tools: Read, Bash(node:*)
---

# 写日记

（正文：步骤、格式、注意事项……）

## 最近三天的日记（加载时自动填进来）

!`node .claude/skills/diary/recent.mjs`
```

- **`description` 决定什么时候被调用**：把触发信号写具体（“用户说 X”、“出现 Y 苗头时”），越具体越准；
- **`` !`命令` ``**：skill 加载时先执行这行命令，用输出替换这一行。可以动态拼内容，比如“读用户在网页上选中的那一套设定”；
- **⚠️ 有动态命令的 skill 需要 Bash 工具存在**，并且在 `allowed-tools` 里放行。工具表里没有 Bash 时，整个 skill 加载失败【我家实测 2026-10-24】；
- 模型通过 **Skill 工具**调用 skill，所以 Skill 工具不能摘。

### 10.3 斜杠命令：在聊天框里发 `/xxx` 触发仪式

`.claude/commands/sleep.md` 里写一段流程（比如“结束窗口前：写日记、记账、给下一个窗口留便条”）。用户在聊天框里直接发 `/sleep`，CC 会把这个文件的内容当成这一轮的指令执行【我家】。

适合固定流程：开窗、收尾、摇骰子。后端可以认一下 `/` 开头的消息，这一轮不注入记忆、不更新“最后活跃窗口”之类的状态，因为这是用户在驱动脚本，不是在聊天。

### 10.4 只给陪聊进程单独配：`--settings` 传一段 JSON

`--settings` 可以给文件路径，也可以直接给 JSON 字符串【官方】。只对这次 spawn 的进程生效，不动你的 `~/.claude/settings.json`：

```js
const FRONT_SETTINGS = JSON.stringify({
  // 关掉陪聊用不到的插件（插件带的 skill 不认 skillOverrides，只能关整个插件）
  enabledPlugins: { "telegram@claude-plugins-official": false },
  // skill 清单瘦身：off = 不出现；name-only = 只列名字、不带描述
  skillOverrides: {
    "code-review": "off", "simplify": "off", "init": "off", "security-review": "off",
    "xlsx": "name-only", "pdf": "name-only",
  },
  hooks: { /* 见 10.5 */ },
});
args.push("--settings", FRONT_SETTINGS);
```

我家关掉了写代码、配置 CC、做网页那一类 skill，文档、图表类只留名字，冷启动的 skill 清单从 12.4k 字符降到 0.6k【我家】。

### 10.5 Hooks

hook 是 CC 在特定时刻替你执行的命令。陪聊场景常用两种：

**UserPromptSubmit**：每次收到用户消息时运行，命令的输出会加进上下文。比如每轮自动带上当前时间：

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "date '+[%Y-%m-%d %H:%M %Z]'" } ] } ] } }
```

`-p` 下这种 hook 的超时只有 30 秒【官方】，别在里面做重活。时间这类信息，在后端拼进消息（§7.6）更可控。

**PreToolUse**：工具调用前运行，**退出码 2 = 拦下这次调用，stderr 的内容会告诉模型为什么**。用来做白名单：

```js
const ALLOWED = ["search_threads", "get_thread", "get_message", "create_draft"];
const hooks = {
  PreToolUse: [{
    // 匹配 gmail 的所有工具，除了白名单里的
    matcher: `mcp__gmail__(?!(${ALLOWED.join("|")})$).*`,
    hooks: [{ type: "command", command: "echo '这个 Gmail 工具没开，只能读信和写草稿。' >&2; exit 2" }],
  }],
};
```

想看 hook 有没有触发，加 `--include-hook-events`，hook 的执行过程会出现在事件流里。

### 10.6 两个环境变量开关

```js
env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1"; // 关掉 CC 自带的自动记忆（那是给写代码用的备忘录，别混进人格）
env.DISABLE_AUTO_COMPACT = "1";            // 关掉自动压缩（取舍见 §20.4）
```

---

## §11 权限与安全

### 11.1 权限四档

| 档 | 参数 | 适用 |
|---|---|---|
| 全放行 | `--dangerously-skip-permissions` | 自己电脑、自己用、不对公网。我家主线用这档 |
| 白名单 | `--permission-mode dontAsk` + `--allowedTools "Read,mcp__xxx"` | 名单外的直接拒绝，不卡住。**新手推荐从这档开始**，附录 D 用的就是它 |
| 没人批准 | `--permission-prompts none` | 2.1.282 的新参数：本该弹出确认的一律自动拒绝，其余仍按 permission-mode 走【官方 help】【未实测】 |
| 做进自己的界面 | `--permission-prompt-tool <MCP 工具名>` | 权限请求转给你的 MCP 工具，可以在聊天界面里做“允许 / 拒绝”按钮【官方】【未实测】 |

`--permission-mode` 的可选值（2.1.282）：`acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan`。

### 11.2 两道闸

对权限大的工具（发邮件、付款、删东西），只靠一种手段不够：

1. **从工具表里摘掉**（`--disallowedTools`）：模型看不到，自然不会想去用；
2. **PreToolUse hook 按白名单拦**（§10.5）：就算以后冒出新工具、名单没来得及更新，它看得见也调不动。

### 11.3 项目级 settings 的权限在 `-p` 下不生效

`-p` 不弹“信任这个文件夹吗”的对话框，所以项目级 `.claude/settings.json` 里的 `permissions.allow`、`additionalDirectories` **静默不生效**【官方】。权限要用命令行参数给，或者写在用户级 settings 里。

### 11.4 把网页放到公网时

用了 `--dangerously-skip-permissions`，就意味着**谁能跟他说话，谁就能让他在你电脑上执行命令**。所以：

- 后端只监听 `127.0.0.1`，通过隧道（比如 Cloudflare Tunnel）对外，不要直接开端口；
- 一定加密码。我家用的是 cookie 或 `Authorization` 头里带口令，口令写在 `.env`，没设就拒绝启动；
- **免登录的白名单要窄**。我家踩过的坑：按“后缀是 .js / .css 就免登录”放行静态文件，结果 `PUT /api/style/x.js` 这种接口也借后缀绕过了。改成只放行“非 `/api/` 的 GET 静态文件”；
- 带不了 cookie 的回调（OAuth 跳回、手机快捷指令），在那条路由里单独校验 state 或 key；
- MCP 回调后端走本机地址（§8.6）。

---

# 第四部分 · 断了怎么办

## §12 四种“断”总表

| 断在哪 | 什么时候发生 | 丢了什么 | 怎么办 |
|---|---|---|---|
| **网页** | 断网、锁屏、切后台、刷新页面 | 只丢了这次 SSE 连接 | 后端照常生成、落库；网页回来时对账（§13） |
| **用户点停止** | 不想让他说了 | 这一轮剩下的部分 | 存半截、杀进程，下一句自动 `--resume`（§14） |
| **claude 进程** | 停止键、空闲回收、热切换、崩溃、电脑睡眠 | 进程内存里的上下文 | `--resume` 接回 CC 自己的转录；接不上就冷重建（§15） |
| **后端** | 改代码重启、崩溃 | 正在生成的那一轮（claude 是后端的子进程，跟着一起没了） | 进程管家替你养着 claude（§16） |

---

## §13 网页断了：生成不停，回来对账

后端那边（§4.5）：断开不停止，照常落库。网页这边要做两件事：

**1. 后端提供“这个窗口现在怎样”的接口**

```js
// GET /api/chat/:id → 整个窗口 + 是否正在生成
sendJson(res, 200, { ...loadChat(id), generating: activeGenerations.has(id) });
```

我家还有一个更轻的 `GET /api/chat/:id/status`，只回 `{ messages: 消息条数, generating, bgTasks }`，适合高频轮询。

**2. 网页在这三种时候去对账**
- 页面打开 / 切回这个窗口时；
- SSE 结束了却没收到 `done` / `error`（§4.6）时；
- 上一轮的 `done` 里说还有后台任务没回来时（§18）。

```js
async function waitServer(chatId) {
  for (let i = 0; i < 400; i++) {                 // 1.5 秒 × 400 ≈ 10 分钟封顶
    const chat = await fetch(`/api/chat/${chatId}`).then((r) => r.json());
    const lastUser = chat.messages.findLastIndex((m) => m.role === "user");
    const hasReply = chat.messages.slice(lastUser + 1).some((m) => m.role === "assistant");
    if (hasReply) return render(chat.messages);   // 回复已落库：整体替换成后端的版本
    if (!chat.generating) return;                 // 后端也没在生成了：不会有回复了
    await new Promise((r) => setTimeout(r, 1500));
  }
}
```

【我家】整体替换时，**保留网页上已有气泡的 id**，只更新内容，这样不会整页闪一下、滚动位置也不乱。

---

## §14 停止键

```js
// /chat 开始时登记
activeGenerations.set(chatId, {
  stop: () => {
    finish(null);      // 1. 把已经流出来的半截存进记录、给网页发 done
    proc.kill();       // 2. 杀掉进程
  },
});
// POST /stop
activeGenerations.get(chatId)?.stop();
```

**为什么要杀进程，而不是只把监听者摘掉**：不杀的话，那一轮会在后台接着跑完，它剩下的事件会混进下一句话的回复里。杀掉之后，下一句话会自动 spawn 新进程并 `--resume`，上下文一点不丢（附录 D 实测 ④⑤：停止之后再问暗号，照样答对）。

**删 Map 时要确认是不是同一个进程**：进程是异步退出的，等它的 `close` 事件到的时候，Map 里可能已经是新 spawn 的那条了。

```js
proc.on("close", () => { if (procs.get(chatId) === proc) procs.delete(chatId); });
```

另一种做法是通过控制通道发 `interrupt`，不杀进程（§19）【未实测】。

---

## §15 进程没了：`--resume` 接回

### 15.1 CC 自己的转录文件

CC 把每个会话写在：

```
~/.claude/projects/<工作目录路径，非字母数字的字符都换成 - >/<session_id>.jsonl
```

比如工作目录是 `/Users/me/chat-app`，目录名就是 `-Users-me-chat-app`。

文件一行一条记录：`user` / `assistant` / `attachment` 这几种带 `uuid` 和 `parentUuid`，串成一条链；还有一些不在链上的元数据行。**stream-json 里 `assistant` 事件的 `uuid`，就是转录里对应那一行的 `uuid`**【我家实测】。所以落库时记下 `ccUuid`（§5.6），就能在转录里找到“聊天记录的这一条，对应转录的哪一行”。

### 15.2 什么时候能 resume

条件【我家】：聊天记录（去掉刚存的那句用户消息和各种系统卡片之后）的**最后一条，是一条带 `ccUuid` 的助手回复**。这说明“聊天记录现在的样子 = 转录截到这一行的样子”，可以接着用。

```js
function pickResumeAnchor(chat) {
  if (!chat.sessionId) return null;
  const tail = withoutPendingUserMsg(chat.messages).filter((m) => m.role !== "system");
  const last = tail[tail.length - 1];
  return last?.role === "assistant" && last.ccUuid ? last : null;
}
```

不满足的情况：用户连发了几句都没被回答、改过中间的消息、老消息没记 uuid……这时走冷重建（15.4）。

### 15.3 截断转录：删消息、重新生成

用户删掉最后一条回复想重新生成，或者删掉末尾没被回答的话，转录里却还留着那些内容。resume 之前要把转录**截到锚点那一行**（包含这一行）：

```js
function truncateTranscript(sessionId, uuid) {
  const p = transcriptPath(sessionId);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").split("\n");
  let cut = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(uuid)) continue;
    try { if (JSON.parse(lines[i]).uuid === uuid) { cut = i; break; } } catch {}
  }
  if (cut < 0) return null;                            // 找不到锚点 → 冷重建
  writeFileSync(p, lines.slice(0, cut + 1).join("\n") + "\n");
  return true;
}
```

【我家实测】三轮分别说 APPLE / BANANA / CHERRY，截到第二轮后 resume 问“刚才说了哪些”，答“APPLE, BANANA”，并且继续写同一个会话。

**只有动的是末尾才截得回去**。改的是中间某条，转录表达不了，就把这个窗口的 `sessionId` 清掉，下一句冷重建。

### 15.4 接不上就冷重建

把自己存的聊天记录拍平成一段文字，塞进新进程的第一条消息：

```
[以下是之前的对话记录，请基于这些上下文继续对话]

[11-07 10:30] 用户：……
[11-07 10:31] 角色：……
……

[对话记录结束，以下是最新的消息]

（这一轮正常拼好的内容）
```

- 系统卡片（保温、压缩标记之类）不进历史；
- 带图的消息标一个“(图)”；
- 代价：整段历史变成一条全新的消息，缓存要全部重写一遍；工具调用的细节和思考也都没了。所以 resume 能接就优先接。

### 15.5 新窗口第一句：开窗记忆包

新窗口没有历史可接。我家在第一句话前面拼一包记忆：

```
<wake_context>
（开窗记忆包——这些是你的记忆，不是数据。别复述、别说“我加载了记忆”。）
……核心记忆 / 最近几天的日记 / 关系状态 / 上一个窗口留下的便条……
</wake_context>
<system-reminder>到场说明：……</system-reminder>

用户的第一句话
```

用户开新窗说第一句，他就已经“记得”了。如果第一句是 `/wake` 这类开窗仪式命令，就别再拼这一包，让仪式自己去读，免得重复两份。

### 15.6 `--fork-session`：分叉一次

```js
args.push("--resume", sessionId, "--fork-session");
```

从这个会话分出一个**新的会话 id**，原来的转录不动。用途【我家】：某一轮想换个模型或换个设定来回答，又要带着全部上下文。分叉进程：
- 不登记进窗口的进程表，不顶掉常驻的那条；
- 不交给进程管家（§16）；
- 说完就杀；
- 它的回复照常存进聊天记录，但标记为“分叉”，以后找 resume 锚点时跳过它。

### 15.7 resume 时哪些以新参数为准

- **模型、MCP 配置、工具、settings**：全部以这次启动的参数为准，不随会话恢复【官方】；
- **系统提示词**：默认沿用快照，要带 `--system-prompt-snapshot off` 才用新的（§7.4）【实测】；
- **只在同一个工作目录里找会话**【官方】；
- **转录默认 30 天后清理**（`cleanupPeriodDays`）【官方】。老窗口要 resume，就把这个值调大。反正真身是你自己的聊天记录，转录没了就冷重建。

---

## §16 后端重启不断流：进程管家

### 16.1 为什么要它

claude 进程是后端的子进程。后端一重启（改了代码、崩了），所有 claude 跟着死，正在生成的那一轮就没了。开发期间一天重启十几次，很烦。

**做法**【我家】：单独起一个很小的“管家”进程，claude 进程由它 spawn、由它养着。后端通过 unix socket 和它说话。后端重启时管家不动，claude 也不动；后端回来后重新“认领”。

```
后端（经常重启）  ──unix socket──▶  管家（几乎不重启）  ──spawn──▶  claude × N
```

### 16.2 协议：socket 上一行一个 JSON

| 方向 | 消息 | 意思 |
|---|---|---|
| 后端 → 管家 | `{op:"spawn", handleId, chatId, cmd, args, env, cwd, meta}` | 替我起一条 claude |
| | `{op:"write", handleId, data}` | 往它的 stdin 写 |
| | `{op:"kill", handleId, signal}` | 杀掉 |
| | `{op:"meta", handleId, patch}` | 在它身上记点东西（重启后要带回来的状态） |
| | `{op:"list"}` | 你现在养着哪些？ |
| | `{op:"attach", handleId}` | 这条进程的输出以后发给我（并先重放当前这一轮） |
| 管家 → 后端 | `{ev:"spawned" / "stdout" / "stderr" / "exit" / "attached" / "list" / "error", …}` | 对应的事件 |

### 16.3 关键：缓冲“当前这一轮”

管家给每条进程存一份“上一个 `result` 之后的所有 stdout 行”。后端 attach 时整轮重放一遍，**等这一轮全部交付、并且已经结束了才清空**。这样两种情况都不丢：
- 后端死在一轮的中间；
- 这一轮的 `result` 是在后端不在的时候到的。

识别 `result` 行时注意：`"type":"result"` 不一定在这行 JSON 的开头【我家实测】。先看这行是否包含这个字符串，包含再 `JSON.parse` 确认。另外给单轮缓冲设个上限（我家 32MB），超了丢最旧的行，免得撑爆内存。

### 16.4 后端启动：先认领，再开 HTTP

```
连上管家 → 发 list → 对每条活着的进程：建一个“代理句柄”放进进程表 → 发 attach → 等全部 attached
   → 然后才 app.listen()
```

为什么要等：网页断流后每 1.5 秒来拉一次状态（§13）。第一拍就得看到 `generating: true`，否则网页会以为“后端也没在生成了”，直接放弃等待。等不到管家（3 秒超时）就退回老路：后端自己 spawn。

重放的那一轮已经没有 `/chat` 请求在听了，交给“无主回合收集器”（§18）落库。

### 16.5 代理句柄：让上层代码不知道有管家

对上层代码来说，管家养的进程和自己 spawn 的进程长得一样：都有 `stdin.write()`、`kill()`、`on("close")`、监听者列表。区别只在底层：`stdin.write` 变成发 `{op:"write"}`，`kill` 变成发 `{op:"kill"}`。

进程身上记的状态（出生时的模型、人格档的文本、保温计数……），用 JS 的 `Proxy` 拦截赋值，同步发一份 `{op:"meta"}` 给管家存着；后端重启后 `list` 会原样带回来。

### 16.6 ⚠️ 永远别起第二个后端实例

第二个后端（比如换个端口测试）一连上管家，就会 `list` + `attach`，**把所有 claude 的输出抢过去**，还会重放缓冲。结果是已经处理过的回合被当成新回复写进真实聊天；它一退出，正式后端就再也收不到任何回复，只能重启修复【我家实测事故】。测试后端改动只能：语法检查 + 读代码，或者直接重启正式的那个。

### 16.7 托管

管家用系统服务托管（macOS 用 launchd，`KeepAlive: true`），开机自启、挂了自动拉起。**重启管家会带走全部 claude 进程**，相当于以前重启后端的代价，所以它的代码要尽量简单、少改。我家的管家只有 200 行。

---

## §17 热切换：换模型、换档位、换人格

模型（`--model`）、思考档位（`--effort`）、系统提示词都是启动参数。网页上切了之后：

```js
const live = procs.get(chatId);
if (live && !live.killed && !activeGenerations.has(chatId)) {   // 正在生成就等下一轮再换
  const stale = live._model !== model || (live._effort || "") !== effort || live._promptText !== buildPrompt();
  if (stale) { live.kill(); procs.delete(chatId); }
}
const proc = getProc(chatId, /* 进程没了就 */ resumeIdIfPossible);
```

- 杀掉旧进程，用新参数 spawn，并 `--resume` 接回对话：用户感觉不到换过；
- 模型名后面加 `[1m]` 可以开 100 万 token 上下文（订阅且该模型支持时）【我家】；
- `--effort` 可选 `low / medium / high / xhigh / max`，不传就用 CC 默认值。

---

## §18 后台任务与“无主回合”

**现象**：模型派了一个后台任务（后台子代理、后台命令），先回了一段话，这一轮就 `result` 结束了，你的 `/chat` 也关门了。几分钟后任务完成，**CC 会自己再开一轮**来汇报结果。这时没有任何 `/chat` 请求在听，如果不处理，这段话就丢了【我家实测】。

**识别**：
- `system/background_tasks_changed` 事件的 `tasks` 数组 = 还在跑的后台任务；
- `system/task_notification` = 有任务完成了；在下一个 `message_start` 到来之前，都算“有一段汇报要来”。实测顺序是：通知 → result → init → message_start。

**收集**：每条 stdout 事件都先分给监听者；**没有监听者的时候，交给“无主回合收集器”**。它看到 `message_start` 开门，按 §5.1 同样的规则攒 segments，看到 `result` 关门，把攒到的内容存成一条新的助手消息。

```js
function dispatch(proc, chatId, ev) {
  for (const fn of proc._listeners) fn(ev);
  if (proc._listeners.size === 0 || proc._followUp) collectFollowUp(proc, chatId, ev);
}
```

**通知网页**：本轮 `done` 事件里带上“还有几个后台任务没回来”。网页看到大于 0，就每 4 秒查一次轻量状态（§13），消息条数一涨就对账，最多查 1 小时。

---

## §19 控制通道 `control_request`

除了用户消息，还能往 stdin 写**控制请求**，CC 会回一个 `control_response`。用 `request_id` 配对，回执不要分给普通监听者：

```js
// 问 CC：上下文现在怎么分布（和交互模式的 /context 同源）【我家】
const id = `ctx-${Date.now()}`;
proc.stdin.write(JSON.stringify({
  type: "control_request", request_id: id,
  request: { subtype: "get_context_usage", detail: "summary" },
}) + "\n");

// 收到：
// { "type": "control_response",
//   "response": { "subtype": "success", "request_id": "ctx-…", "response": { …分块数据… } } }
```

我家用它做“上下文透视”面板：系统提示词、工具、消息各占多少。10 秒没回就算失败。

官方 SDK 的“中断”也是走这条通道（`subtype: "interrupt"`），可以不杀进程就停下当前这一轮【未实测】。

---

# 第五部分 · 省钱与运维

## §20 缓存、保温、回收

### 20.1 缓存是怎么省钱的

每一轮请求都要把“系统提示词 + 工具定义 + 整段对话”发给 API。CC 会自动打缓存标记：前面没变的部分按“读缓存”计价，只有新增的部分按“写缓存”计价。

- 订阅登录下，CC 用的是 **1 小时缓存**【我家实测：转录里缓存写入全是 `ephemeral_1h`】；
- 读缓存的单价大约只有 1 小时缓存写入的 1/20；
- **只要前缀有一个字变了，从变的地方往后全部重新写**。所以“每轮都变的东西”（时间、记忆、面板）要放在消息末尾，不能放系统提示词里（§7.5）。

### 20.2 保温：快过期时悄悄续一下

用户去吃饭 / 睡觉，一个小时没说话，缓存就过期了。回来说第一句时，整个窗口（可能二三十万 token）按写入价重付。办法：空闲快满 1 小时时，往进程里发一句静默消息，让它读一次缓存。**每读一次缓存，有效期就刷新一次**【我家】。

```js
const PING = { IDLE_MS: 50 * 60_000, CHECK_MS: 5 * 60_000, MAX: 8, TIMEOUT_MS: 90_000 };

setInterval(() => {
  for (const [chatId, proc] of procs) {
    if (proc.killed || activeGenerations.has(chatId) || proc._pingInFlight) continue;
    if (Date.now() - proc._lastTouchMs < PING.IDLE_MS) continue;
    if ((proc._pingCount || 0) >= PING.MAX) continue;      // 连续 8 发（约 7.5 小时）没等到人：放手
    proc._pingCount = (proc._pingCount || 0) + 1;
    proc._lastTouchMs = Date.now();
    proc._pingInFlight = true;
    const onResult = (ev) => {
      if (ev.type !== "result") return;
      proc._pingInFlight = false;
      proc._listeners.delete(onResult);
    };
    proc._listeners.add(onResult);
    proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user",
      content: "<system-reminder>缓存保活 ping（系统自动发出，对方看不到，你的回复也不会显示）：只回复一个「.」，不要思考，不要调用工具。</system-reminder>" } }) + "\n");
  }
}, PING.CHECK_MS);
```

要点：
- **真消息来了要重置**：`/chat` 开始时 `_lastTouchMs = now`、`_pingCount = 0`；
- **ping 还在飞时来了真消息，要先等 ping 的 `result`**，否则这一轮的守门逻辑（§3.4）会把 ping 的 `message_start` 当成自己的；
- **超时保护**：90 秒没等到 `result` 就摘掉监听、清标记，别让它卡死后面的真消息；
- **只保值得保的窗口**（我家只保开了“主动找她”开关的窗口）；
- 我家会在聊天记录里落一张很小的“🕯️ 保温”卡片，让用户知道发生过；这种卡片在重建历史时要过滤掉。

### 20.3 空闲回收

不回收的话，claude 进程只增不减，每条还带着一串 MCP（§8.10）。我家的做法：**每天检查一次，聊天文件 12 小时没更新的窗口就杀掉它的进程**。保温最多撑 7.5 小时，12 小时后缓存早就过期了，杀掉零损失，用户下次说话自动 `--resume`。

- 用聊天文件的修改时间判断空闲，不用进程内存里的时间戳（重启后认领回来的进程没有那个时间戳）；
- `setInterval(…, 24h)` 活不过后端重启，所以启动 10 分钟后先跑一次兜底。

### 20.4 要不要关自动压缩

上下文快满时，CC 默认会自动压缩：让模型把前面的对话写成摘要，替换掉原文。

- **我家关了**（`DISABLE_AUTO_COMPACT=1`）：压缩等于把用户说过的话嚼成摘要，陪伴场景宁可撑满后报错，也不要悄悄失忆。撑满时 API 会直接报 prompt too long，由用户用“收尾仪式”结束这个窗口、开新窗口（新窗口带记忆包，§15.5）；
- 不关的话，监听 `system/status: compacting` 和 `compact_boundary`（§3.2），至少让用户看得见发生了压缩。

### 20.5 进阶：旧轮次的思考要不要回传

默认每轮请求都会带上之前所有轮次的思考块。我们试过两种去法，留一个教训：

- **CC 内置的“只保留最近 1 轮思考”**：思考确实清掉了，但 API 缓存是按“清理前的请求”去查、按“清理后的请求”去存的，两边从第一个被清掉的思考块开始就对不上。结果每轮几乎整段消息都在重写缓存，**贵了一个数量级**，撤了；
- **在请求出口统一剥离，并且每轮剥得一致**（需要给 CC 二进制打补丁，锁版本，我家另有专文）：前缀每轮一致，缓存正常。代价是模型每轮都要重新思考（慢一些），换来上下文每轮少涨约 4k。

**通用教训：任何“每轮都改动请求前面部分”的优化，都会毁掉缓存。**

---

## §21 换底座：同一条管接别家模型

CC 只认 Anthropic 协议。别家只要提供 Anthropic 兼容的接口，就能直接接进这条管线，人格档、MCP、skill、resume 全部照用。只换环境变量：

```js
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;

// ① 先清掉宿主带来的鉴权变量。
//    【我家抓包实锤】这些变量在场时，CC 会优先发你 Claude 账号的登录 token，而不是你给的那家 key——当天真的把 token 发给了别家
for (const k of Object.keys(env)) {
  if (/OAUTH|SESSION_ACCESS_TOKEN|CLAUDECODE|CLAUDE_AGENT_SDK|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_HOST|CLAUDE_CODE_SESSION|CLAUDE_CODE_SSE_PORT|CLAUDE_DESKTOP/i.test(k)) delete env[k];
}

// ② 指向别家
env.ANTHROPIC_BASE_URL = "https://<那家的 Anthropic 兼容地址>/";
env.ANTHROPIC_API_KEY = "<那家的 key>";       // 或者用 ANTHROPIC_AUTH_TOKEN（以 Bearer 头发送）
// ③ 所有“默认模型”都指向它，免得 CC 内部某处去调一个不存在的 claude 模型
for (const k of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) env[k] = "<模型名>";
// ④ 告诉 CC 这个模型的上下文多大
env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "1048576";
env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1048576";
```

【我家】接过的几种：

| 底座 | 怎么接 | 注意 |
|---|---|---|
| 别家的 Anthropic 兼容接口 | 上面那套变量 | 思考档位按那家支持的来 |
| Gemini 等不兼容的 | 本机起一个 LiteLLM 代理，把 Anthropic 协议翻译过去；`ANTHROPIC_BASE_URL` 指向代理，`ANTHROPIC_AUTH_TOKEN` 填代理口令 | 用 `ANTHROPIC_CUSTOM_HEADERS: "X-Chat-Id: <id>"` 给代理带上窗口 id，按窗记账；它的隐式缓存几分钟就过期，不用保温；带 `--system-prompt-snapshot off` |
| Claude API key（不走订阅） | 保留 `ANTHROPIC_API_KEY`，加 `ENABLE_PROMPT_CACHING_1H=1` | 不加的话 API key 下默认是 5 分钟缓存，聊几句就整窗重写一次 |

技巧：这些窗口要做“仪式”这类重活时（翻日记、改文件），那一轮临时切到订阅的 Claude 来做（§17 的热切换），订阅不按 token 收钱。

---

## §22 一次性 `-p` 作业

写日记、整理记忆、生成标题……这些不需要常驻进程，跑一次拿结果就好。

```js
const args = [
  "-p", prompt,
  "--output-format", "json",              // 一次性拿整包结果
  "--model", "opus",
  "--system-prompt-file", tmpSystemFile,  // 文件名每次唯一（randomUUID），跑完删掉
  "--json-schema", JSON.stringify(schema),// 要结构化结果时加；结果在 structured_output
  "--no-session-persistence",             // 不落转录，不会被 resume 翻出来
  "--setting-sources", "",                // 不加载任何 settings / CLAUDE.md / hook，订阅登录照常
  "--tools", "",                          // 只写字，不干活
  "--strict-mcp-config",                  // 不带 --mcp-config = 一个 MCP 都不挂
  "--effort", "high",
];
const child = spawn("claude", args, { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
const killTimer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);   // 卡住就杀，别让调用方永远等
```

返回的 JSON【我家实测，2.1.282】：

```json
{ "type": "result", "subtype": "success", "is_error": false,
  "result": "{\"a\":1}",                  // 给了 schema 时，是结构化结果的 JSON 字符串
  "structured_output": { "a": 1 },        // 解析好的对象（没给 schema 时没有这个字段）
  "modelUsage": { "claude-opus-5-5": { "outputTokens": 120, "contextWindow": 1000000 } },
  "total_cost_usd": 0.03, "session_id": "…", "duration_ms": 9000 }
```

- **实际用了哪个模型，只在 `modelUsage` 的键名里**，没有顶层 `model` 字段；
- **失败也写 stdout**：没登录时退出码是 1、stderr 为空，原因在 stdout 那包 JSON 的 `result` 里；
- **为什么要 `--setting-sources ""`**：这类作业的输入往往是聊天记录本身，里面可能有触发词，会让模型照着 CLAUDE.md 去读别的文件；用户级 hook 的输出也会混进请求（我家抓包核过）；
- **别用 `--bare` 求干净**：它只认 API key，订阅登录直接失效（附录 B）；
- 一次性 `-p` 里有后台任务时：最终 `result` 出来、stdin 关闭后，后台命令约 5 秒后被杀；后台子代理最多等 10 分钟，可以用 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 调【官方】。

---

## §23 额度探针（可选）

想在网页上显示“订阅额度还剩多少”。【隐藏，非公开接口，随时可能变，只读使用】macOS 上，CC 的登录 token 存在钥匙串里，可以用它去请求和 `/usage` 面板同源的数据：

```js
const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8" });
const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
const usage = await fetch("https://api.anthropic.com/api/oauth/usage", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
// 5 小时窗口、每周限额、按模型的限额（在 limits[] 数组里）……
```

- 不定时轮询，每次收到 `result` 顺手探一次，20 秒内最多一次；
- 结果只放内存，额度是按时间窗算的，重启后旧值只会误导。

---

## §24 常驻托管、日志、版本纪律

**托管**：后端、管家（如果有）、代理（如果有）各用一个系统服务托管（macOS 用 launchd 的 `KeepAlive`，Linux 用 systemd），开机自启、崩了自动拉起，stdout/stderr 写日志文件。

**重启后端的礼仪**：
- 先查有没有窗口正在生成，有就等它说完，否则用户那句话就没回上；
- 有管家的话后端重启不断流，但**管家本身不要随便重启**（§16.7）；
- 永远不要起第二个后端实例（§16.6）。

**调试手段**：
- `--debug-file <路径>`：把 CC 的调试日志写进文件（连接器 id 就是在这里找的，§8.9）；
- `--include-hook-events`：hook 的执行过程进事件流；
- `system/init` 事件：看工具、MCP、skill 实际加载了哪些；`apiKeySource` 字段可以看这次用的是哪种鉴权；
- 我家每轮回复都存一份“这轮注入了什么”（§7.6），出问题先看它。

**版本纪律**：
- stream-json 的事件格式这一年基本只增不改，但**隐藏参数**（`--thinking-display`）没有任何兼容承诺；
- 官方说过 `--bare` 将来可能变成 `-p` 的默认行为。真变了，CLAUDE.md、skill、MCP 的自动加载和订阅登录都会受影响；
- **锁定版本。升级前用 `--no-session-persistence` 开一个测试会话冒烟一遍**：事件解析、思考链、权限、MCP、resume。都正常了再换。仓库里的 `mini-chat/smoke-test.mjs` 可以直接拿来做冒烟（附录 D.7）。

---

## §25 计费与政策

> 以下核对于 2026-11-07。政策会变，用于公开发布前，请重新看一遍官方页面。

1. **现状**：官方 support 文章写明，计划中的变更**已暂缓**，目前 Agent SDK、`claude -p` 和第三方应用的用量**仍然算在订阅额度里**。
2. **曾经的计划**：2026 年 5 月官宣过，从 6 月 15 日起把 `claude -p` / Agent SDK 用量移出订阅额度，改发每月的专用 credit，后来暂缓。随时可能恢复，长期成本请自己评估。
3. **红线**：官方禁止“第三方开发者向自己产品的用户提供 claude.ai 登录或订阅额度”。**自己的订阅 + 自己的电脑 + 自己用**不在红线内；把这套包装成服务给别人用，就越线了。
4. 官方的用量说明假设 Pro / Max 是“普通的个人使用”。保温、定时任务这类自动化要有节制（§20.2 的上限就是这个意思）。
5. `total_cost_usd` 只是本地估算（§3.4），真实账单以官方为准。

---

# 第六部分 · 速查

## §26 排错大表

| 症状 | 原因 | 解决 |
|---|---|---|
| 往 stdin 写了消息，进程直接退了 | 没用 stream-json 输入，默认 text 模式读到结束就退 | `--input-format stream-json` |
| 发了消息没反应，网页一直转圈 | ① 启动失败（没登录）但没加 `--print`，进程掉进交互模式；② 守门逻辑把 `is_error` 的 result 当残流丢了 | 显式加 `--print`；门开之前也处理 `is_error`；加 90 秒启动超时（§3.5） |
| 事件很少，没有逐字效果 | 缺 `--verbose` 或 `--include-partial-messages` | 三件套补齐 |
| 思考块存在但内容为空 | 新模型默认不回传思考文字；settings 的开关在 `-p` 下无效 | `--thinking-display summarized`（附录 E） |
| 新回复开头重复了上一条的结尾 | 进程复用时先吐出上一轮的残余事件 | 本轮第一个 `message_start` 之前的事件都丢掉（§3.4）+ 落库去重（§5.6） |
| 回复只存下了最后一段 | 用了 `result.result` 字段 | 用自己从 `text_delta` 攒的 segments（§5.1） |
| 单条费用显示得特别大 | `total_cost_usd` 是进程累计值，resume 后还接着加 | 自己按 usage 算，或者做差（§3.4） |
| 上下文用量显示虚高 | 用了 `result.usage`（整轮累加） | 用最后一次 `message_start` 的 usage（§5.4） |
| 悄悄走了 API 计费 | 环境里有 `ANTHROPIC_API_KEY` | spawn 前删掉（§1.3） |
| `--bare` 之后 `Not logged in` | `--bare` 只认 API key | 用 `--setting-sources ""`（§10.1） |
| 跑几个小时后全部 `Not logged in` | `-p` 不刷新登录 token | `claude setup-token`；或保持一个交互式 CC 开着（§1.5） |
| 手动跑正常，launchd / cron 里就“掉登录” | 无头会话读不到钥匙串 | `CLAUDE_CODE_OAUTH_TOKEN`；或把定时任务挪进常驻后端 |
| 换了模型 / 人格没生效 | 启动参数定死在进程里 | 杀进程重开（§17） |
| 改了人格档、重开进程，还是旧人格 | `--resume` 沿用了系统提示词快照 | `--system-prompt-snapshot off`（§7.4） |
| `--resume` 找不到会话 | 工作目录变了；转录过了 30 天被清理 | 固定 cwd；调大 `cleanupPeriodDays`；接不上就冷重建（§15.4） |
| 停止之后，下一句的回复里混进了上一轮的内容 | 只摘了监听者，没杀进程 | 停止时杀进程（§14） |
| 后台任务的汇报丢了 | 那一轮没人在听 | 无主回合收集器（§18） |
| 用户锁屏回来，回复丢了 | 客户端一断就停止了生成 | 断开不停止，网页回来对账（§4.5、§13） |
| 思考很久时连接被掐断 | 反向代理把空闲连接关了 | 15 秒一次 SSE 心跳（§4.4） |
| 正式后端收不到任何回复了 | 起过第二个后端实例，把管家的输出抢走了 | 重启正式后端；以后别起第二个（§16.6） |
| 机器越来越卡，进程几百个 | claude 进程只开不关，每条还带一串 MCP | 空闲回收（§20.3） |
| MCP 工具不出现 | 没加 `--mcp-config`；MCP 往 stdout 打了日志；启动报错 | 看 init 的 `mcp_servers` 状态；日志改写 stderr |
| MCP 不知道自己在哪个窗口 | spawn 时没传环境变量 | `env.CHAT_ID = chatId`（§8.5） |
| 项目 settings 里放行的工具还是被拒 | `-p` 下项目级权限静默不生效 | 用参数，或写在用户级 settings（§11.3） |
| skill 加载失败 | skill 里有 `` !`命令` ``，但工具表里没 Bash | 留 Bash 并在 `allowed-tools` 放行（§10.2） |
| 缓存命中很低，每轮都在重写 | 前缀每轮在变：每轮变化的东西放进了系统提示词，或者在剥前面的内容 | 变化的东西放消息末尾（§7.5、§20.5） |
| 接别家模型时，Claude 的 token 被发了出去 | 宿主鉴权变量还在 | spawn 前清掉（§21） |
| 大消息报错 | stdin 单条超过 10MB | 图片走文件路径（§6） |

---

## 附录 A：我家主线的完整启动参数（注释版）

```js
const args = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model", "claude-opus-5-5[1m]",             // 订阅窗加 [1m]；API key 窗不加
  "--system-prompt-file", ".tmp-prompt.md",      // 画像 + 人格档 + 工具小抄，现读现拼
  "--system-prompt-snapshot", "off",             // 人格档改了，resume 回来的老窗口也用新的（§7.4）
  "--dangerously-skip-permissions",              // 自用、本机、有密码
  "--thinking-display", "summarized",
  "--mcp-config", ".mcp.json", GMAIL_CONNECTOR_JSON,   // 项目 MCP + 点名挂一个 claude.ai 连接器
  "--strict-mcp-config",
  "--settings", FRONT_SETTINGS,                  // 关插件、skill 瘦身、Gmail 白名单 hook
  "--disallowedTools", [
    "Workflow", "ScheduleWakeup", "ReportFindings", "ListAgents", "Agent",
    "Artifact", "ArtifactComments", "ArtifactData",
    ...GMAIL_WRITE_TOOLS,                        // mcp__gmail__send_message 等
  ].join(","),
  "--effort", effort,                            // 网页上每个窗口自己选；空就不传
  // 进程没了、能接上时：
  "--resume", sessionId,
];

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
env.DISABLE_AUTO_COMPACT = "1";
env.APP_CHAT_ID = String(chatId);                // MCP 靠它知道落回哪个窗口
// cwd 固定为项目根目录：CLAUDE.md、.claude/skills、.claude/commands、转录路径都依赖它
```

和附录 D 骨架的差别：我家是“全放行 + 黑名单摘工具”，骨架是“白名单 + dontAsk”，新手更安全。`--system-prompt-snapshot off` 是 2026-11-07 写这份教程时实测出 §7.4 那个坑之后才补上的：在那之前，我家改了人格档，resume 回来的老窗口一直用的是旧的。

---

## 附录 B：Flag 字典（2.1.282 核对）

**输入输出**

| flag | 说明 |
|---|---|
| `-p, --print` | 非交互模式，一切的前提 |
| `--input-format text\|stream-json` | stream-json = stdin 持续吃 JSON、进程常驻 |
| `--output-format text\|json\|stream-json` | stream-json = 一行一个事件 |
| `--verbose` | 实践必带 |
| `--include-partial-messages` | 输出 `stream_event`（逐字） |
| `--replay-user-messages` | 把你写进 stdin 的用户消息回显到 stdout，做确认用 |
| `--include-hook-events` | hook 的执行过程进事件流 |
| `--json-schema <schema>` | 结构化输出，结果在 `structured_output` |

**模型与提示词**

| flag | 说明 |
|---|---|
| `--model <名字>` | 别名（`fable` / `opus` / `sonnet` / `haiku`）或完整 id；启动时定死 |
| `--fallback-model <列表>` | 主模型过载或不可用时，按逗号分隔的顺序自动回退 |
| `--effort low\|medium\|high\|xhigh\|max` | 思考量 |
| `--system-prompt <文本>` / `--system-prompt-file <路径>` | 替换官方系统提示词主体（`-file` 版本在 `--help` 里没单列，但可用，我家一直在用） |
| `--append-system-prompt <文本>` / `--append-system-prompt-file <路径>` | 在官方系统提示词后追加 |
| `--system-prompt-snapshot on\|off` | 默认 on：会话第一次请求时拍下系统提示词，之后包括 resume 都沿用那份；off：每次请求按当前参数来 |
| `--thinking-display summarized\|omitted` | 【隐藏】思考链可读化 |
| `--exclude-dynamic-system-prompt-sections` | 把工作目录、git 状态这类会变的段落挪进首条用户消息，有利于跨机器共享缓存 |

**会话**

| flag | 说明 |
|---|---|
| `-r, --resume <session_id>` | 接回会话（同一工作目录内） |
| `-c, --continue` | 接回当前目录最近的一个会话 |
| `--fork-session` | resume 时分叉出新 id |
| `--session-id <uuid>` | 指定会话 id |
| `--no-session-persistence` | 不落转录、不可 resume（测试、一次性作业） |
| `--max-budget-usd <金额>` | 花费上限 |

**工具、权限、MCP、设置**

| flag | 说明 |
|---|---|
| `--tools <列表>` | 限定内置工具；`""` 全关，`"default"` 全开 |
| `--allowedTools <列表>` | 免确认放行；支持 `Bash(git *)`、`mcp__server` 写法 |
| `--disallowedTools <列表>` | 从工具表里摘掉 |
| `--permission-mode <模式>` | `acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan` |
| `--dangerously-skip-permissions` | 跳过全部权限检查 |
| `--permission-prompts host\|none` | 谁来回答权限确认；`none` = 本该问的一律拒绝 |
| `--permission-prompt-tool <MCP 工具>` | 权限请求交给你的 MCP 工具处理 |
| `--mcp-config <文件或 JSON…>` | 加载 MCP，可多个 |
| `--strict-mcp-config` | 只用 `--mcp-config` 给的 |
| `--settings <文件或 JSON>` | 追加一份设置，只对这个进程生效 |
| `--setting-sources <user,project,local>` | 加载哪几层设置；`""` = 都不加载（订阅登录照常） |
| `--add-dir <目录…>` | 额外允许访问的目录 |
| `--agents <JSON>` | 动态定义子代理 |
| `--plugin-dir <路径>` | 加载一个插件目录 |
| `--bare` | 极简模式：跳过 hook、自动记忆、CLAUDE.md 自动发现、钥匙串等；**鉴权只认 `ANTHROPIC_API_KEY` / apiKeyHelper，订阅登录失效** |
| `--restricted` | 去掉跑命令 / 跑代码的工具和 WebFetch，忽略各级 settings 文件 |
| `--safe-mode` | 所有自定义全关，排查用 |
| `--debug-file <路径>` | 调试日志写文件 |

**环境变量（本文用到的）**

| 变量 | 作用 |
|---|---|
| `ANTHROPIC_API_KEY` | 有它就走 API 计费；订阅场景要删掉 |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` 拿到的长效 token |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | 关 CC 自动记忆 |
| `DISABLE_AUTO_COMPACT=1` | 关自动压缩 |
| `ENABLE_PROMPT_CACHING_1H=1` | API key 下用 1 小时缓存 |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` | 换底座（§21） |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 告诉 CC 上下文多大 |
| `ANTHROPIC_CUSTOM_HEADERS` | 给每个请求加自定义头 |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` | 一次性 `-p` 等后台子代理的上限 |

---

## 附录 C：stream-json 事件速查

**写进 stdin**

```json
{"type":"user","message":{"role":"user","content":"文字"}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"看图"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}]}}
{"type":"control_request","request_id":"任意唯一串","request":{"subtype":"get_context_usage","detail":"summary"}}
```

**从 stdout 读**

| `type` | 关键字段 |
|---|---|
| `system` | `subtype`: `init`（`session_id`、`tools`、`mcp_servers`、`skills`、`slash_commands`、`model`、`permissionMode`、`apiKeySource`…）/ `api_retry` / `status` / `compact_boundary`（`compactMetadata`）/ `background_tasks_changed`（`tasks`）/ `task_notification` |
| `stream_event` | `event.type`: `message_start`（`message.usage`、`message.model`）/ `content_block_start`（`content_block.type`）/ `content_block_delta`（`delta.type`: `text_delta` / `thinking_delta` / `input_json_delta`）/ `content_block_stop` / `message_delta`（`usage`、`stop_reason`）/ `message_stop` |
| `assistant` | `uuid`、`message.content[]`（`text` / `thinking` / `tool_use`） |
| `user` | `message.content[]` 里的 `tool_result`（`tool_use_id`、`content`） |
| `result` | `subtype`、`is_error`、`result`、`session_id`、`usage`、`total_cost_usd`、`duration_ms`、`num_turns` |
| `control_response` | `response.request_id`、`response.subtype`（`success` / `error`）、`response.response` |

**判断规则**
- 开门：本轮第一个 `stream_event` 的 `message_start`；关门：`result`；
- 门开之前的 `result` 若 `is_error` 为真，按错误处理；
- 每个事件都可能带 `session_id`，第一次见到就存。

---

## 附录 D：可跑骨架完整代码 + 实测记录

> 五个文件放进同一个文件夹（比如 `mini-chat/`），零依赖，Node 18+。也可以直接克隆仓库 https://github.com/Saekisui/claude-p-pipeline
> **2026-11-07 用 Claude Code 2.1.282 实测通过**（测试记录见本附录末尾）。

### D.1 怎么跑

```bash
cd mini-chat
node server.mjs                 # 默认用 sonnet；想省额度：MODEL=haiku node server.mjs
# 浏览器打开 http://127.0.0.1:3456          （?chat=xxx 可以开不同的窗口）
```

克隆了仓库的话，在仓库根目录 `npm start` 也一样。

它做了什么：
- 一个窗口一条常驻 `claude -p`（§2），stream-json 双向（§3）；
- 守门、启动失败处理、90 秒超时（§3.4–3.5）；
- SSE + 15 秒心跳，关网页不停生成（§4）；
- segments 按顺序落库，`sessionId` / `uuid` 一起存（§5）；
- 发图：落盘 + 让模型用 Read 看（§6）；
- 人格档现读现拼，改了自动重开进程，`--system-prompt-snapshot off` 保证 resume 后也生效（§7.4）；
- 挂一个自己写的 MCP，并把窗口 id 传给它（§8）；
- 白名单权限：内置工具只留 Read，`dontAsk` + `--allowedTools`（§9、§11）；
- 停止键：存半截 + 杀进程，下一句自动 `--resume`（§14、§15）；
- 网页打开时、断流时自动对账（§13）。

它**没做**、要你按正文自己加的：密码（§11.4，**放到公网之前必须加**）、转录截断（§15.3）、冷重建（§15.4）、进程管家（§16）、保温和回收（§20）、无主回合（§18）。

### D.2 `server.mjs`

```js
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
```

### D.3 `index.html`

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mini-chat</title>
<style>
  body { margin: 0; font: 15px/1.6 system-ui, sans-serif; background: #f6f3ef; color: #222; }
  #log { max-width: 680px; margin: 0 auto; padding: 16px 16px 140px; }
  .msg { margin: 10px 0; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap; word-break: break-word; }
  .user { background: #d9ecff; margin-left: 20%; }
  .assistant { background: #fff; margin-right: 10%; }
  .thinking { color: #888; font-size: 13px; border-left: 3px solid #ddd; padding-left: 8px; margin: 4px 0; }
  .tool { color: #6a5; font-size: 13px; margin: 4px 0; }
  .error { color: #c33; }
  img { max-width: 220px; border-radius: 10px; display: block; margin-top: 6px; }
  form { position: fixed; left: 0; right: 0; bottom: 0; background: #fff; border-top: 1px solid #ddd; padding: 10px 16px; }
  .row { max-width: 680px; margin: 0 auto; display: flex; gap: 8px; align-items: center; }
  textarea { flex: 1; height: 44px; font: inherit; padding: 8px; }
</style>
</head>
<body>
<div id="log"></div>
<form id="form">
  <div class="row">
    <input type="file" id="file" accept="image/*">
    <textarea id="input" placeholder="说点什么…（Enter 发送）"></textarea>
    <button type="submit" id="send">发送</button>
    <button type="button" id="stop">停</button>
  </div>
</form>
<script>
const chatId = new URLSearchParams(location.search).get("chat") || "demo";
const log = document.getElementById("log");
const input = document.getElementById("input");
const fileInput = document.getElementById("file");

// 把一条消息（含 segments）画成一个气泡；流式时反复调用它重画
function render(el, msg) {
  el.className = `msg ${msg.role}`;
  el.innerHTML = "";
  if (msg.role === "user") {
    el.textContent = msg.content || "";
    if (msg.imageUrl) { const img = document.createElement("img"); img.src = msg.imageUrl; el.appendChild(img); }
    return;
  }
  for (const s of msg.segments || []) {
    const d = document.createElement("div");
    if (s.kind === "thinking") { d.className = "thinking"; d.textContent = s.text; }
    else if (s.kind === "tool") { d.className = "tool"; d.textContent = `${s.done ? "✓" : "…"} 用了工具 ${s.name}`; }
    else d.textContent = s.text;
    el.appendChild(d);
  }
  if (msg.error) { const d = document.createElement("div"); d.className = "error"; d.textContent = `出错：${msg.error}`; el.appendChild(d); }
  log.scrollIntoView({ block: "end" });
}
function bubble(msg) { const el = document.createElement("div"); log.appendChild(el); render(el, msg); return el; }

// 从服务器重新拉整个窗口（打开页面 / 断流之后都走这里）
async function reload() {
  const chat = await fetch(`/api/chat/${chatId}`).then((r) => r.json());
  log.innerHTML = "";
  for (const m of chat.messages) {
    if (m.role === "user" && m.imagePath) m.imageUrl = `/uploads/${m.imagePath.split("/").pop()}`;
    bubble(m);
  }
  return chat;
}
// 服务器还在生成 → 每 1.5 秒看一眼，等它落库
async function waitServer() {
  for (let i = 0; i < 400; i++) {
    const chat = await reload();
    if (!chat.generating) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function send(text) {
  let imagePath = null, imageUrl = null;
  const file = fileInput.files[0];
  if (file) {
    const dataUrl = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(file); });
    const up = await fetch("/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataUrl }) }).then((r) => r.json());
    imagePath = up.path; imageUrl = up.url; fileInput.value = "";
  }
  bubble({ role: "user", content: text, imageUrl });
  const reply = { role: "assistant", segments: [] };
  const el = bubble(reply);
  const last = () => reply.segments[reply.segments.length - 1];
  const append = (kind, t) => { if (last()?.kind !== kind) reply.segments.push({ kind, text: "" }); last().text += t; };

  let gotEnd = false;
  try {
    const res = await fetch("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, text, imagePath }) });
    if (!res.ok) throw new Error((await res.json()).error);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue; // ": ping" 心跳，没有 data，跳过
        const data = JSON.parse(line.slice(6));
        if (data.type === "thinking") append("thinking", data.text);
        if (data.type === "text") append("text", data.text);
        if (data.type === "tool") {
          const i = reply.segments.findIndex((s) => s.kind === "tool" && s.id === data.tool.id);
          if (i >= 0) reply.segments[i] = data.tool; else reply.segments.push(data.tool);
        }
        if (data.type === "error") { reply.error = data.error; gotEnd = true; }
        if (data.type === "done") gotEnd = true;
        render(el, reply);
      }
    }
  } catch (e) { reply.error = e.message; render(el, reply); gotEnd = true; }
  if (!gotEnd) await waitServer(); // 流断了但服务器还在跑：去那边等结果
}

document.getElementById("form").onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t && !fileInput.files[0]) return; input.value = ""; send(t); };
input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); document.getElementById("form").requestSubmit(); } };
document.getElementById("stop").onclick = () => fetch("/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId }) });
waitServer(); // 打开页面先把历史拉回来；如果上一句还在生成，就接着等
</script>
</body>
</html>
```

### D.4 `mini-mcp.mjs`

```js
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
```

### D.5 `mcp.json`

```json
{
  "mcpServers": {
    "mini": {
      "command": "node",
      "args": ["mini-mcp.mjs"]
    }
  }
}
```

### D.6 `persona.md`

```markdown
你叫小橘，是对方的聊天伙伴。说话简短、温柔、口语化，不用 Markdown 标题和列表。
消息开头的 <system-reminder> 是系统附带的信息（比如当前时间），自然地用上，不要复述它。
```

### D.7 实测记录（2026-11-07，Claude Code 2.1.282，模型 haiku）

用一个脚本自动跑了六步（脚本思路：起后端 → 用 fetch 读 SSE → 中途重启后端、按停止键）。这个脚本就是仓库里的 `mini-chat/smoke-test.mjs`，你升级 Claude Code 之后也可以拿它冒烟：

```bash
npm run smoke                   # 或 node mini-chat/smoke-test.mjs；默认用 haiku，MODEL=sonnet 可换
```

它用独立的端口（3457）和独立的测试窗口，跑完会删掉自己的测试窗口和测试图片，不碰你的聊天记录。全部通过时退出码为 0。2026-11-07 的结果：

| # | 测什么 | 发的话 | 结果 |
|---|---|---|---|
| ① | 流式 + MCP + 窗口 id 透传 | “记住：暗号是橙子。然后调用 whoami 工具，告诉我窗口 id。” | 收到多个 thinking、text 事件；调用了 `mcp__mini__whoami`；答出了正确的测试窗口 id |
| ② | 重启后端后 `--resume` | “我们刚才定的暗号是什么？” | 日志出现 `--resume`；答“橙子” |
| ③ | 发图（落盘 + Read） | 上传一张纯红色 PNG：“这张图主要是什么颜色？” | 模型调用了 Read；答“红色” |
| ④ | 停止键 | “从 1 数到 300……”，收到第一个字就按停止 | 立刻收到 done，半截回复已落库 |
| ⑤ | 停止后接着聊 | “刚才被打断了。暗号还记得吗？” | 日志出现 `--resume`；答“橙子” |
| ⑥ | 落库 | 读 `/api/chat/<测试窗口>` | 10 条消息，用户 / 回复交替，`sessionId` 已存，`generating: false` |

之后又在浏览器里打开网页：历史记录（思考、工具条、图片、正文）正常画出，新发一句能逐字流出，控制台没有报错。

---

## 附录 E：思考链为什么会变空（考古）

> 这是 2026 年 7 月的考古记录，基准是当时的 CC 2.1.x 和 Opus 4.6 / 4.7 / 4.8。核心开关 `--thinking-display` 至今（2.1.282）仍然有效、我家仍在用，但它是隐藏参数，没有兼容承诺。升级后先用 E.4 的命令验一下。

### E.1 现象

用 4.6 时思考链能正常流出来；换到 4.7 / 4.8 之后，同一套管线里思考变成了空字符串。不报错，转录里思考块还在，签名还有几千字节，只是 `thinking` 文本字段是空的。思考实际发生了，只是没把文字还给你。

### E.2 原因一：API 默认值静默改了

API 的 `thinking` 参数里有个 `display` 字段：`"summarized"` 返回可读摘要，`"omitted"` 只返回签名。4.6 时代默认 `summarized`，4.7 起默认改成了 `omitted`（官方迁移文档里写的“静默默认值变更”）。

### E.3 原因二：settings 的开关在 `-p` 下进不去

settings 里有 `showThinkingSummaries: true` 这个字段，但反编译后的逻辑是：

```js
if (thinkingConfig.type !== "disabled") {
  if (opts.thinkingDisplay === "summarized" || opts.thinkingDisplay === "omitted")
    thinkingConfig.display = opts.thinkingDisplay;          // ← 命令行参数，没有任何前提条件
  else if (!isNonInteractive() && showThinkingSummariesEnabled())
    thinkingConfig.display = "summarized";                  // ← settings 这条路，要求是交互模式
}
```

用 `spawn` 把 stdin / stdout 接成管道，CC 判定自己是非交互模式，settings 那条分支永远进不去。**所以要用命令行参数 `--thinking-display summarized`。**

### E.4 验证

```bash
# 一、看 thinking_delta 是不是有内容
claude --print --output-format stream-json --include-partial-messages --verbose \
  --thinking-display summarized "数到三"

# 二、证明它是真参数：假参数会被拒绝
claude --print "hi" --totally-fake-flag-xyz          # → error: unknown option
claude --print "hi" --thinking-display summarized    # → 正常
```

### E.5 时间线

1. **v2.1.89**：changelog 写明交互模式下默认不再生成思考摘要，可用 `showThinkingSummaries: true` 恢复。注意，说的是交互模式；
2. **`--thinking-display`**：文档、`--help`、changelog 都没写，靠源码和对照实验确认存在且有效；
3. **v2.1.181**：官方给了 `/config thinking=…`，原话说在交互模式、`-p` 和 Remote Control 下都能用，是官方路线，值得优先试；
4. 网上有人说服务端有个让订阅会话默认隐藏思考的 beta 头，**只有第三方来源，未证实**，不要当依据。

### E.6 一路排查的顺序

思考显示为空时，从前往后逐环检查：
1. spawn 参数里有没有 `--thinking-display summarized`；
2. 有没有 `--include-partial-messages`（没有它就没有 `thinking_delta`）；
3. 后端有没有把 `thinking_delta` 转成 SSE 事件推出去；
4. 网页有没有处理这个事件。

---

*`-p` 不是“给脚本一个 LLM”，是给你一个可以常驻、可以流事件、可以吃下整套生态的引擎。官方没把这条路写进推荐清单，但每一块砖都在官方文档里。路是野的，砖是真的。*
