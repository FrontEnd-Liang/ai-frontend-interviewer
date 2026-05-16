# 前端面试官 · AI 智能体架构 (Agentic Workflow)

## 📺 项目演示 (Demo)

<div align="center">
  <video src="https://github.com/user-attachments/assets/dea2dc8c-7008-47c9-a3c0-39f2ece4af31" width="100%" controls autoplay loop muted>
    您的浏览器不支持 HTML5 视频，请点击<a href="https://github.com/user-attachments/assets/dea2dc8c-7008-47c9-a3c0-39f2ece4af31">此处</a>查看演示。
  </video>
</div>

> **注：** 右侧终端实时展示了 Agent 的路由决策逻辑（如 `internet_search` 调用及物理层拦截日志）。

一个基于现代化多智能体协作流（Agentic Workflow）的前端技术问答平台。系统摒弃了传统的线性问答，利用原生 Tool Calling 能力，实现了本地私有知识库（RAG）、实时互联网检索、**多轮对话记忆（Supabase）** 与 SSE 流式结构化回答。

> **底层驱动：Google Gemini（推荐 `gemini-2.5-flash`）**，通过 LangChain 接入。

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
    └─ agent.py      ← Gemini + Pinecone + Tavily + 记忆优先 Prompt
    ▼
SSE 事件流 → 前端打字机（analysis / knowledgePoints / codeExample）
```

| 层级 | 职责 |
|------|------|
| **Next.js** | UI、SSE 解析与容错（超时/断流必停 Loading）、结构化卡片 |
| **FastAPI** | Agent 两阶段路由、RAG、JSON 收敛、异步落库 |
| **Supabase** | `interviews` / `messages` 表持久化 session 对话 |
| **scripts/ingest.ts** | Node 向 Pinecone 写入手册向量（与后端共用索引） |

## 🛠 技术栈与核心基建

- **前端 / BFF**：Next.js 14（App Router） + React 18 + TypeScript + TailwindCSS
- **AI 核心后端**：Python 3.11+ · FastAPI · Uvicorn
- **对话记忆**：Supabase（PostgreSQL）· `supabase-py`
- **AI 编排**：
  - **Node**（入库）：`@langchain/core`、`@langchain/textsplitters` + `GeminiEmbeddings`（768 维）
  - **Python**（对话）：`langchain-google-genai`、`langchain-pinecone`、`langchain-community`（Tavily）
- **基础设施**：
  - **Pinecone**：本地手册 RAG（`search_frontend_handbook`）
  - **Tavily**：互联网搜索（可选，`TAVILY_API_KEY`）

## 📂 目录结构

```text
app/
  api/chat/route.ts        # BFF：转发至 FastAPI，透传 SSE
  page.tsx                 # 聊天 UI + SSE 消费 + session_id（localStorage）
backend/
  main.py                  # FastAPI 入口
  agent.py                 # Agent + 记忆优先 System Prompt + SSE
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
# 必填
GEMINI_API_KEY=AIxxxxxxxxxxxxxxxxxxxx
PINECONE_API_KEY=pcsk_xxxxxxxx
PINECONE_INDEX=ai-interviewer

# 国内访问 Google API 建议
HTTPS_PROXY=http://127.0.0.1:7890

# 可选
# GEMINI_MODEL=gemini-2.5-flash
# TAVILY_API_KEY=tvly-xxxxxxxx
# CHAT_BACKEND_URL=http://127.0.0.1:8000

# Supabase 对话记忆（可选；不配置则跳过落库，仍可正常对话）
# SUPABASE_URL=https://xxxxxxxx.supabase.co
# SUPABASE_KEY=eyJ...          # 建议 service_role，仅后端使用
# MEMORY_MAX_MESSAGES=30     # 注入上下文的上限（约 15 轮）
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
┌─ 阶段 A：Tool-Calling Router ─────────────────────────┐
│  有历史时：记忆优先 Prompt（姓名/技术栈等必须依据 history） │
│  工具：search_frontend_handbook (Pinecone)              │
│        internet_search (Tavily, 可选)                   │
└─────────────────────────┬───────────────────────────────┘
                          ▼
┌─ 阶段 B：withStructuredOutput → InterviewResponse ────┐
│  { analysis, knowledgePoints, codeExample }            │
│  429 / 失败 → 降级 JSON，前端不白屏                       │
└─────────────────────────┬───────────────────────────────┘
                          ▼
              SSE 推送 → 异步写入 Supabase（user + assistant）
```

### 对话记忆（Supabase）

- 前端 `localStorage` 生成并复用 `session_id`，随 `/api/chat` 提交  
- 后端对话前拉取历史，注入 Gemini 多轮消息；流结束后 **异步** `persist_turn`  
- 未配置 Supabase 时自动降级，**不影响 Pinecone RAG**  
- 记忆类问题（姓名、擅长框架等）在 System Prompt 中 **优先于工具路由与安全拒答**

### SSE 与前端容错（`app/page.tsx`）

| 机制 | 说明 |
|------|------|
| 整请求超时 | **30 秒** `AbortController`，超时停止「思考中」 |
| 解析容错 | 单条 `data:` JSON 失败则跳过，不卡死整流 |
| 错误事件 | `type: error` → 错误气泡，移除空 AI 占位 |
| 结束保障 | `finally` 中强制 `setLoading(false)` |

| 事件 `type` | 含义 |
|-------------|------|
| `delta` | `analysis` / `codeExample` 增量 |
| `knowledgePoints` | 标签数组 |
| `done` | 流结束 |
| `error` | 错误信息 |

### 结构化输出

```json
{
  "analysis": "技术分析（2~5 句）",
  "knowledgePoints": ["知识点1", "知识点2"],
  "codeExample": "// 代码或空字符串"
}
```

## 切换模型

修改 `GEMINI_MODEL`（如 `gemini-2.5-pro`），重启 **Python 后端** 即可。

## 常见问题

- **`服务器未配置 GEMINI_API_KEY`**：根目录 `.env.local` 填 Key，重启前后端。  
- **`无法连接 AI 后端`**：确认 `backend` 在 `8000` 端口运行，或检查 `CHAT_BACKEND_URL`。  
- **一直「思考中」**：前端已对 SSE 做 30s 超时与 `finally` 复位；仍出现则查后端是否卡住或代理超时。  
- **记不住姓名/技术栈**：确认 Supabase 已建表、Key 正确，且同一浏览器 `session_id` 未变；日志应有 `loaded N history message(s)`。  
- **模型仍隐私拒答**：检查 `agent.py` 中 `HISTORY_PRIORITY_INSTRUCTION` 是否生效，并重启 Python。  
- **Pinecone 无结果**：执行 `npm run ingest`，索引维度 **768**。  
- **网络不通**：配置 `HTTPS_PROXY`；Python `httpx` 与 Node 均会读取。
