# 前端面试官 · AI 智能体架构 (Agentic Workflow)

## 📺 项目演示 (Demo)

<div align="center">
  <video src="https://github.com/user-attachments/assets/dea2dc8c-7008-47c9-a3c0-39f2ece4af31" width="100%" controls autoplay loop muted>
    您的浏览器不支持 HTML5 视频，请点击<a href="https://github.com/user-attachments/assets/dea2dc8c-7008-47c9-a3c0-39f2ece4af31">此处</a>查看演示。
  </video>
</div>

> **注：** 右侧终端实时展示了 Agent 的路由决策逻辑（如 `internet_search` 调用及物理层拦截日志）。

一个基于现代化多智能体协作流（Agentic Workflow）的前端技术问答平台。系统摒弃了传统的线性问答，利用原生 Tool Calling 能力，实现了本地私有知识库（RAG）与实时互联网数据的混合检索与精准路由。

> **底层驱动：Google Gemini（推荐 `gemini-2.5-flash`）**，通过 LangChain 接入。

## 🏗 架构概览

采用 **Next.js（前端 + BFF）+ FastAPI（AI 核心后端）** 混合架构：

```
浏览器 (page.tsx)
    │  POST /api/chat  (SSE)
    ▼
Next.js BFF  app/api/chat/route.ts   ← 仅做代理，透传流式响应
    │  POST http://127.0.0.1:8000/chat
    ▼
FastAPI      backend/main.py
    │  agent.py：Gemini + Pinecone + Tavily + 结构化输出
    ▼
SSE 事件流 → 前端打字机效果（analysis / knowledgePoints / codeExample）
```

| 层级 | 职责 |
|------|------|
| **Next.js** | UI、SSE 消费与结构化卡片渲染；`/api/chat` 转发至 Python |
| **FastAPI** | Agent 路由、工具调用、Pinecone 检索、JSON 收敛与降级兜底 |
| **scripts/ingest.ts** | 仍由 Node 执行，向 Pinecone 写入向量（与后端共用同一索引） |

## 🛠 技术栈与核心基建

- **前端 / BFF**：Next.js 14（App Router） + React 18 + TypeScript + TailwindCSS
- **AI 核心后端**：Python 3.11+ · FastAPI · Uvicorn
- **AI 编排引擎**：
  - **Node**（入库）：`@langchain/core`、`@langchain/textsplitters` + 自研 `GeminiEmbeddings`（768 维）
  - **Python**（对话）：`langchain-google-genai`、`langchain-pinecone`、`langchain-community`（Tavily）
- **基础设施**：
  - **Pinecone**：Serverless 向量数据库（本地手册 RAG）
  - **Tavily**：实时互联网搜索（可选，配置 `TAVILY_API_KEY` 后启用）

## 📂 目录结构

```text
app/
  api/chat/route.ts        # BFF：转发请求至 FastAPI，透传 SSE
  layout.tsx
  page.tsx                 # 聊天 UI（SSE 打字机 + 结构化卡片）
backend/
  main.py                  # FastAPI 入口，POST /chat → StreamingResponse
  agent.py                 # Agent 大脑：Tool Calling + 结构化输出 + SSE
  config.py                # 环境变量（兼容根目录 .env.local）
  requirements.txt
  .env.example
docs/
  frontend-handbook.md     # RAG 私有知识库源文件
lib/
  embeddings.ts            # 入库脚本使用的 Gemini 768 维 Embedding
scripts/
  ingest.ts                # 向量化并写入 Pinecone
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
# Windows
venv\Scripts\activate
# macOS / Linux
# source venv/bin/activate

pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `.env.local.example` 为 `.env.local` 并填写（**Next 与 Python 共用同一文件**，`backend/config.py` 会自动加载）：

```env
# 必填
GEMINI_API_KEY=AIxxxxxxxxxxxxxxxxxxxx

# 可选，默认 gemini-2.5-flash
# GEMINI_MODEL=gemini-2.5-flash

# 国内访问 Google API 建议配置
HTTPS_PROXY=http://127.0.0.1:7890

# Pinecone（RAG 必填）
PINECONE_API_KEY=pcsk_xxxxxxxx
PINECONE_INDEX=ai-interviewer

# Tavily（互联网搜索，可选；留空则 Agent 只用本地手册）
# TAVILY_API_KEY=tvly-xxxxxxxx

# 可选：FastAPI 地址（Next BFF 代理目标，默认 http://127.0.0.1:8000）
# CHAT_BACKEND_URL=http://127.0.0.1:8000
```

也可在 `backend/` 下复制 `.env.example` 为 `backend/.env`；根目录 `.env.local` 会与之合并加载。

> - Gemini Key：[Google AI Studio](https://aistudio.google.com/app/apikey)
> - Pinecone：[app.pinecone.io](https://app.pinecone.io) → 索引 **维度 768、metric cosine**（与 `gemini-embedding-001` 对齐）
> - Tavily：[app.tavily.com](https://app.tavily.com) 免费层每月 1000 次搜索

### 3. 向量入库（首次必须执行一次）

```bash
npm run ingest
```

该脚本读取 `docs/frontend-handbook.md`，按 500 字符 / 50 重叠切分，用 `gemini-embedding-001`（768 维）写入 `PINECONE_INDEX`。修改手册后重跑即可同步。

### 4. 启动服务（需同时运行两个进程）

**终端 1 — Python AI 后端：**

```bash
cd backend
# 若已创建 venv，先 activate
python main.py
# 或：uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

健康检查：[http://127.0.0.1:8000/health](http://127.0.0.1:8000/health)

**终端 2 — Next.js 前端：**

```bash
npm run dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000) 即可使用。

## 核心实现

### Agentic Workflow（多工具自主路由）

```
[用户提问]
   │
   ├─► 物理层正则拦截 (如"你好") ──(短路返回)──► [SSE 流式 JSON] ⚡ 极速 0 成本
   │
   ▼
┌────────────────────────────────────────────────────────┐
│ 阶段 A：Native Tool-Calling Router (大模型原生意图分发)│
│ (注入系统绝对时间戳，消除大模型"时间盲视"预测幻觉)     │
│ ───────────────────────────────────────────────────────│
│ 动态绑定 ▼                                             │
│ ┌──────────────────┐   ┌──────────────────┐          │
│ │search_frontend_  │   │internet_search   │          │
│ │handbook(Pinecone)│   │(Tavily 泛搜索)   │          │
│ └────────┬─────────┘   └────────┬─────────┘          │
│          └──────────────┬───────┘                      │
│                         ▼                              │
│       Python 后端手动执行工具，获取 Raw Text           │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│ 阶段 B：Format 强制收敛 (withStructuredOutput)         │
│ ───────────────────────────────────────────────────────│
│ 将杂乱的工具返回值/自由文本，严格折叠为前端可用 UI 字段│
│ { analysis, knowledgePoints, codeExample }             │
│                                                        │
│ 🛡️ 容灾兜底 (Fallback)：                               │
│ 若触发 429 额度限流或 API 宕机，拦截 500 报错，        │
│ 强行组装降级 JSON，保障 C 端前端页面永不崩溃。         │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼
              SSE 增量推送 (text/event-stream)
              delta → knowledgePoints → done
```

1. **入库**（`npm run ingest`）：`frontend-handbook.md` → 切分 → `gemini-embedding-001`（768 维）→ 覆盖写入 Pinecone。
2. **Agent**（`backend/agent.py`）：`ChatGoogleGenerativeAI` + `bind_tools`，两个工具：
   - `search_frontend_handbook` — Pinecone topK=3
   - `internet_search` — Tavily（仅配置 `TAVILY_API_KEY` 时启用）
3. **JSON 收敛**：阶段 B `with_structured_output(InterviewResponse)`，字段 `{ analysis, knowledgePoints, codeExample }`。
4. **流式输出**：完成后按字段切片经 SSE 推送到前端，实现打字机效果。

### SSE 事件格式（`backend/agent.py` → `app/page.tsx`）

| 事件 `type` | 含义 |
|-------------|------|
| `delta` | `field: analysis \| codeExample`，`text` 为增量片段 |
| `knowledgePoints` | `items: string[]`，一次性下发标签列表 |
| `done` | 流结束 |
| `error` | `message`，BFF 与前端展示错误 |

### 强制结构化输出（阶段 B）

Pydantic / LangChain 将 Gemini 输出绑定到：

```json
{
  "analysis": "技术分析（2~5 句）",
  "knowledgePoints": ["知识点1", "知识点2"],
  "codeExample": "// 极简代码或空字符串"
}
```

服务端再做字段类型兜底；限流时降级为纯文本 `analysis` + 占位标签。

### UI 卡片渲染

`app/page.tsx` 消费 SSE，将三个字段以「技术分析 / 核心知识点（Tag）/ 代码示例（代码块）」卡片化渲染，流式过程中逐字更新 `analysis` 与 `codeExample`。

## 切换模型

修改环境变量 `GEMINI_MODEL`（如 `gemini-2.5-pro`），重启 **Python 后端** 即可，无需改代码。

## 常见问题

- **报错 `服务器未配置 GEMINI_API_KEY`**：在根目录 `.env.local` 填入 Key，重启 `npm run dev` 与 Python 后端。
- **报错 `无法连接 AI 后端`**：确认 `backend` 已启动且监听 `8000`；或检查 `CHAT_BACKEND_URL`。
- **网络不通**：Gemini 域名为 `generativelanguage.googleapis.com`；Node 与 Python 均可通过 `HTTPS_PROXY` 走代理（Python 侧 `httpx` 会读取该变量）。
- **Pinecone 无结果**：先执行 `npm run ingest`，并确认索引维度为 **768**。
