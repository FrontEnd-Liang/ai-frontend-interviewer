# 前端面试官 · AI 智能体架构 (Agentic Workflow)

## 📺 项目演示 (Demo)

<div align="center">
  <video src="https://github.com/FrontEnd-Liang/ai-frontend-interviewer/issues/2#issue-4462811577" width="100%" controls autoplay loop muted>
    您的浏览器不支持 HTML5 视频，请点击<a href="https://github.com/FrontEnd-Liang/ai-frontend-interviewer/issues/2#issue-4462811577">此处</a>查看演示。
  </video>
</div>

> **注：** 右侧终端实时展示了 Agent 的路由决策逻辑（如 `internet_search` 调用及物理层拦截日志）。

一个基于现代化多智能体协作流（Agentic Workflow）的前端技术问答平台。系统摒弃了传统的线性问答，利用原生 Tool Calling 能力，实现了本地私有知识库（RAG）、实时互联网检索、**多轮对话记忆（Supabase）**、**思考链状态可视化（Thinking SSE）** 与流式打字机结构化回答。

> **对话大模型：DeepSeek 官方 API（`deepseek-chat`）**，经 `langchain-openai` 的 OpenAI 兼容接口接入。  
> **向量化：Google Gemini Embedding（`gemini-embedding-001`，768 维）**，用于 Pinecone RAG 与 `npm run ingest`。

## 🏗 架构概览

采用 **Next.js（前端 + BFF）+ FastAPI（AI 核心后端）+ Supabase（PostgreSQL）** 混合架构：

```
浏览器 (page.tsx)
    │  POST /api/chat  { message, session_id }  (SSE, 30s 超时)
    ▼
Next.js BFF  app/api/chat/route.ts   ← 代理，透传流式响应
    │  POST http://127.0.0.1:8000/chat
    ▼
FastAPI      backend/main.py
    ├─ database.py   ← 读取/写入 Supabase 对话历史（最近 ~15 轮）
    └─ agent.py      ← DeepSeek Chat + Gemini Embedding + Pinecone + Tavily
    ▼
SSE 事件流 → thinking（路由/检索进度）→ delta 打字机 → 结构化卡片
```

| 层级 | 职责 |
|------|------|
| **Next.js** | UI、SSE 解析与容错、思考状态区、Markdown 技术分析、数据驱动卡片 |
| **FastAPI** | Agent 两阶段路由、RAG、thinking 事件注入、伪流式分片（20ms 节流）、异步落库 |
| **Supabase** | `interviews` / `messages` 表持久化 session 对话 |
| **scripts/ingest.ts** | Node 向 Pinecone 写入手册向量（与后端共用索引） |

## 🛠 技术栈与核心基建

- **前端 / BFF**：Next.js 14（App Router） + React 18 + TypeScript + TailwindCSS + `react-markdown` / `remark-gfm`
- **AI 核心后端**：Python 3.11+ · FastAPI · Uvicorn
- **对话记忆**：Supabase（PostgreSQL）· `supabase-py`
- **AI 编排**：
  - **Node**（入库）：`@langchain/core`、`@langchain/textsplitters` + `GeminiEmbeddings`（768 维）
  - **Python**（对话）：`langchain-openai`（DeepSeek）、`langchain-pinecone`、`langchain-community`（Tavily）
- **基础设施**：
  - **DeepSeek**：阶段 A 工具路由 + 阶段 B JSON 格式化（`temperature=0`，`max_retries=0`，`timeout=15`）
  - **Pinecone**：本地手册 RAG（`search_frontend_handbook`）
  - **Tavily**：互联网搜索（可选，`TAVILY_API_KEY`）

## 📂 目录结构

```text
app/
  api/chat/route.ts        # BFF：转发至 FastAPI，透传 SSE
  page.tsx                 # 聊天 UI、思考链、SSE 消费、Markdown 渲染
backend/
  main.py                  # FastAPI 入口
  agent.py                 # Agent + thinking 队列 + 伪流式 SSE 分片
  database.py              # Supabase 单例与读写
  config.py                # 环境变量（兼容根目录 .env.local）
  supabase_schema.sql      # 建表 SQL（在 Supabase 控制台执行）
  requirements.txt
  .env.example
docs/
  frontend-handbook.md     # RAG 源文件
lib/
  embeddings.ts            # 入库用 Gemini 768 维 Embedding
scripts/
  ingest.ts                # 向量化写入 Pinecone
```

## 快速开始

### 1. 安装依赖

**前端：**

```bash
npm install
```

**Python 后端：**

```bash
cd backend
python -m venv venv
# Windows: venv\Scripts\activate
# macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `.env.local.example` 为 `.env.local`（**Next 与 Python 共用**，`backend/config.py` 自动加载）：

```env
# 对话大模型（必填）
DEEPSEEK_API_KEY=sk-xxxxxxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat

# Embedding / RAG 入库（必填）
GEMINI_API_KEY=AIxxxxxxxxxxxxxxxxxxxx
PINECONE_API_KEY=pcsk_xxxxxxxx
PINECONE_INDEX=ai-interviewer

# 国内访问 Google Embedding API 建议
HTTPS_PROXY=http://127.0.0.1:7890

# 可选
# TAVILY_API_KEY=tvly-xxxxxxxx
# CHAT_BACKEND_URL=http://127.0.0.1:8000

# Supabase 对话记忆（可选；不配置则跳过落库，仍可正常对话）
# SUPABASE_URL=https://xxxxxxxx.supabase.co
# SUPABASE_KEY=eyJ...          # 建议 service_role，仅后端使用
# MEMORY_MAX_MESSAGES=30       # 注入上下文的上限（约 15 轮）
```

### 3. 初始化 Supabase（启用记忆时）

1. 在 [Supabase](https://supabase.com) 创建项目  
2. 打开 SQL Editor，执行 `backend/supabase_schema.sql`  
3. 填入 `SUPABASE_URL` / `SUPABASE_KEY`

表结构概要：

| 表 | 字段 |
|----|------|
| `interviews` | `session_id`, `user_id`, `score`, `created_at`, `updated_at` |
| `messages` | `session_id`, `role` (`user`/`assistant`), `content`, `created_at` |

### 4. 向量入库（首次）

```bash
npm run ingest
```

读取 `docs/frontend-handbook.md`，`gemini-embedding-001`（768 维）写入 Pinecone。

### 5. 启动服务（两个进程）

**终端 1 — Python：**

```bash
cd backend && python main.py
```

健康检查：[http://127.0.0.1:8000/health](http://127.0.0.1:8000/health)

**终端 2 — Next.js：**

```bash
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

## 核心实现

### Agentic Workflow

```
[用户提问 + session_id]
   │
   ├─ Supabase 加载最近 MEMORY_MAX_MESSAGES 条历史
   ├─ 物理层问候拦截 → SSE 短路
   ▼
┌─ 阶段 A：Tool-Calling Router（DeepSeek）────────────────┐
│  ChatOpenAI + bind_tools                                │
│  有历史时：记忆优先 Prompt（姓名/技术栈等必须依据 history）   │
│  工具：search_frontend_handbook (Pinecone)               │
│        internet_search (Tavily, 可选)                    │
│  超时 / API 异常 → 简短 ROUTER_FALLBACK，不进入阶段 B      │
└─────────────────────────┬───────────────────────────────┘
                          ▼
┌─ 阶段 B：json_object 格式化（DeepSeek）─────────────────┐
│  model.bind(response_format={"type": "json_object"})    │
│  json.loads → { analysis, knowledgePoints, codeExample } │
│  解析失败 / 429 / API 异常 → 简短 FORMATTER_FALLBACK      │
│  （严禁将长 raw_answer 塞入降级，避免 SSE 击穿 30s）       │
└─────────────────────────┬───────────────────────────────┘
                          ▼
              thinking 事件（路由/工具进度）→ 伪流式 SSE → 异步写入 Supabase
```

### 思考链与流式体验（Thinking Chain）

**后端（`agent.py`）**

- 进入阻塞阶段前推送 `type: thinking`（如「正在分析问题意图并规划检索路由…」）。
- `run_phases_sync` 通过线程安全队列实时上报：大模型路由、Pinecone 手册检索、Tavily 联网、阶段 B 格式化等步骤。
- `_stream_answer_payload` 将完整 JSON 按 2 字符分片推送 `delta`，每片 `await asyncio.sleep(0.02)`，避免瞬间倾泻、保障前端打字机节奏。

**前端（`page.tsx`）**

| 阶段 | UI 行为 |
|------|---------|
| **思考中**（`thinkingActive`） | 气泡内仅显示顶部思考文案 + 脉冲点，**不挂载**正文 Section，避免空骨架闪烁 |
| **正文流式** | 收到首个有效 `delta` / `knowledgePoints` 后结束思考动画；各 Section **仅在有真实数据**（`length > 0`）时渲染 |
| **占位符拦截** | 含 `(无)`、`本题无需`、纯空白等脏数据不触发正文阶段，但照常拼接 `acc`；`done` 时强制结束思考态 |

**技术分析**区块使用 `ReactMarkdown` + `remarkGfm` 渲染 Markdown（列表、表格、加粗等）；知识点与代码示例保持原有样式。

### 对话记忆（Supabase）

- 前端 `localStorage` 生成并复用 `session_id`，随 `/api/chat` 提交  
- 后端对话前拉取历史，注入 DeepSeek 多轮消息；流结束后 **异步** `persist_turn`  
- 未配置 Supabase 时自动降级，**不影响 Pinecone RAG**  
- 记忆类问题（姓名、擅长框架等）在 System Prompt 中 **优先于工具路由与安全拒答**

### SSE 协议与前端容错（`app/page.tsx`）

| 机制 | 说明 |
|------|------|
| 整请求超时 | **30 秒** `AbortController`，超时停止「思考中」 |
| 缓冲解析 | `carry` + `\n\n` 分块，单条 JSON 失败则跳过，不中断整流 |
| 错误事件 | `type: error` → 错误气泡，移除空 AI 占位 |
| 结束保障 | `finally` 中强制 `setLoading(false)`；`done` 必触发思考态收尾 |

| 事件 `type` | 载荷 | 含义 |
|-------------|------|------|
| `thinking` | `{ message: string }` | 路由 / 检索 / 格式化进度（思考状态区） |
| `delta` | `{ field, text }` | `analysis` / `codeExample` 增量（2 字分片） |
| `knowledgePoints` | `{ items: string[] }` | 知识点标签（一次性） |
| `done` | — | 流结束；强制 `thinking.done` |
| `error` | `{ message }` | 错误信息 |

### 结构化输出

阶段 B 要求模型输出**唯一合法 JSON 对象**（无 Markdown 围栏），字段固定为：

```json
{
  "analysis": "技术分析（2~5 句）",
  "knowledgePoints": ["知识点1", "知识点2"],
  "codeExample": "// 代码或空字符串"
}
```

## 切换模型

**对话（阶段 A / B）**：修改 `.env.local` 中的 `LLM_MODEL`（默认 `deepseek-chat`），可选调整 `DEEPSEEK_BASE_URL`，重启 **Python 后端** 即可。

**向量化（Pinecone / ingest）**：仍使用 `GEMINI_API_KEY` 与 `gemini-embedding-001`（768 维），与对话模型独立配置。

## 常见问题

- **`服务器未配置 DEEPSEEK_API_KEY`**：在根目录 `.env.local` 填写 DeepSeek Key，重启 Python 后端。  
- **`服务器未配置 GEMINI_API_KEY`**：Embedding 与 `npm run ingest` 仍需要 Gemini Key；对话不受影响时需单独配置。  
- **`无法连接 AI 后端`**：确认 `backend` 在 `8000` 端口运行，或检查 `CHAT_BACKEND_URL`。  
- **一直「思考中」**：前端已对 SSE 做 30s 超时与 `finally` 复位；`done` 会强制结束思考动画。仍出现则查后端是否卡在工具调用、DeepSeek 超时（阶段 A `timeout=15`）或代理问题。  
- **阶段 B 400 / response_format 不可用**：已改用 `json_object` 模式 + 手动 `json.loads`；若仍失败会走简短 `FORMATTER_FALLBACK`，不会把长 `raw_answer` 推给前端。  
- **无打字机效果、答案瞬间弹出**：确认 `agent.py` 中 `_stream_answer_payload` 使用 `asyncio.sleep(0.02)`，并重启 Python 后端。  
- **思考结束过早 / 出现「（无）」空卡片**：检查前端 `isPlaceholderDeltaText` / `isPlaceholderKnowledgePoints` 是否误拦真实正文；后端阶段 B 不应输出占位 JSON。  
- **Markdown 无样式**：`prose` 类需 `@tailwindcss/typography` 插件；未安装时 GFM 结构仍可解析，仅排版较朴素。  
- **记不住姓名/技术栈**：确认 Supabase 已建表、Key 正确，且同一浏览器 `session_id` 未变；日志应有 `injected N history message(s)`。  
- **模型仍隐私拒答**：检查 `agent.py` 中 `HISTORY_PRIORITY_INSTRUCTION` 是否生效，并重启 Python。  
- **Pinecone 无结果**：执行 `npm run ingest`，索引维度 **768**。  
- **Embedding 网络不通**：配置 `HTTPS_PROXY`；Python `httpx` 与 Node 均会读取（主要影响 Gemini Embedding，DeepSeek 通常无需代理）。
