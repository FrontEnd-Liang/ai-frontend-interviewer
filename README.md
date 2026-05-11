# 前端面试官 · AI 问答工具（第一阶段单点突破）

一个极简的 AI 问答 Demo：内置「前端技术面试官」System Prompt，强制大模型以 JSON 结构化输出，前端解析为卡片展示。

> **底层模型：Google Gemini（`gemini-2.5-flash`）**，通过 `@langchain/google-genai` 接入。

## 技术栈

- Next.js 14（App Router） + React 18 + TypeScript
- TailwindCSS
- LangChain.js：
  - `langchain` + `@langchain/core`（`createToolCallingAgent` + `AgentExecutor`）
  - `@langchain/google-genai`（Gemini 模型）
  - `@langchain/pinecone` + `@langchain/textsplitters`（向量检索）
  - `@langchain/community`（Tavily 搜索工具）
- Pinecone（向量数据库，存储手册 embedding）
- Tavily（互联网搜索引擎，可选）

## 目录结构

```
app/
  api/chat/route.ts        # LangChain 后端：RAG 检索 + System Prompt + 结构化输出
  layout.tsx               # 根布局
  page.tsx                 # 聊天 UI（用户气泡、AI 卡片、Loading）
  globals.css              # Tailwind 入口
docs/
  frontend-handbook.md     # RAG 知识库源文件
scripts/
  ingest.ts                # 把手册切分、向量化并写入 Pinecone
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.local.example` 为 `.env.local` 并填写：

```env
# 必填
GEMINI_API_KEY=AIxxxxxxxxxxxxxxxxxxxx

# 可选，默认 gemini-2.5-flash
# GEMINI_MODEL=gemini-2.5-flash

# 国内访问 Google API 必填
HTTPS_PROXY=http://127.0.0.1:7890

# Pinecone（RAG 必填）
PINECONE_API_KEY=pcsk_xxxxxxxx
PINECONE_INDEX=ai-interviewer

# Tavily（互联网搜索，可选；留空则 Agent 只用本地手册一个工具）
# TAVILY_API_KEY=tvly-xxxxxxxx
```

> - Gemini Key：[Google AI Studio](https://aistudio.google.com/app/apikey) 免费申请。
> - Pinecone：[app.pinecone.io](https://app.pinecone.io) 注册 → 创建 Serverless 索引，**维度 768、metric cosine**（与 `gemini-embedding-001` 截断到 768 维后对齐）。
> - Tavily：[app.tavily.com](https://app.tavily.com) 免费层每月 1000 次搜索。

### 3. 向量入库（首次必须执行一次）

```bash
npm run ingest
```

该脚本会读取 `docs/frontend-handbook.md`，按 500 字符 / 50 重叠切分，用 `text-embedding-004` 生成向量，覆盖写入 `PINECONE_INDEX` 索引。修改手册后重跑即可同步。

### 4. 启动开发服务器

```bash
npm run dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000) 即可使用。

## 核心实现

### Agentic Workflow（多工具自主路由）

```
用户问题
   │
   ▼
┌──────────────────────────────────────────────┐
│ 阶段 A：Tool-Calling Agent (gemini-2.5-flash) │
│ ─────────────────────────────────────────────│
│ 自主选择 ▼                                    │
│ ┌──────────────────┐   ┌──────────────────┐  │
│ │search_frontend_  │   │internet_search   │  │
│ │handbook (Pinecone)│   │(Tavily, 可选)   │  │
│ └────────┬─────────┘   └────────┬─────────┘  │
│          └────────┬─────────────┘            │
│                   ▼                          │
│        Agent 综合后产出自由文本回答          │
└──────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│ 阶段 B：JSON 强格式化（withStructuredOutput）│
│ → { analysis, knowledgePoints, codeExample } │
└──────────────────────────────────────────────┘
                   │
                   ▼
            前端卡片渲染
```

1. **入库**（`npm run ingest`）：`frontend-handbook.md` → `RecursiveCharacterTextSplitter`（chunkSize 500 / overlap 50）→ `gemini-embedding-001` 截断到 768 维 → 覆盖写入 Pinecone。
2. **Agent**（`app/api/chat/route.ts`）：基于 `createToolCallingAgent` + `AgentExecutor` 实现两个工具：
   - `search_frontend_handbook` — 本地手册 Pinecone topK=3 检索
   - `internet_search` — Tavily 互联网搜索（仅在 `TAVILY_API_KEY` 配置时启用）
   - System Prompt 中详细告知工具用途与调用边界，由 Gemini 自主决定走哪一条
3. **JSON 收敛**：Agent 输出的自由文本 + 原问题 → 再走一次 `gemini-2.5-flash.withStructuredOutput(schema)`，强制返回 `{ analysis, knowledgePoints, codeExample }` 三字段。

> 此设计保证：**前端 `page.tsx` 对返回结构的解析不需要任何修改**。

### 强制结构化输出（阶段 B）

使用 LangChain 的 **`.withStructuredOutput(schema)`** 把 Gemini 的输出绑定到 JSON Schema 上：

```ts
{
  analysis: string;          // 技术分析
  knowledgePoints: string[]; // 核心知识点
  codeExample: string;       // 极简代码示例
}
```

`withStructuredOutput` 底层调用 Gemini 的 **Function Calling / Response Schema** 能力，比单纯 Prompt 约束更稳定。同时服务端再做一次字段类型兜底校验，避免脏数据打挂前端。

### UI 卡片渲染

前端 `app/page.tsx` 不会展示原始 JSON，而是将三个字段以「技术分析 / 核心知识点（Tag）/ 代码示例（代码块）」卡片化渲染。

## 切换模型

只想换 Gemini 系列模型（如 `gemini-2.5-pro`、`gemini-2.0-flash`），改环境变量 `GEMINI_MODEL` 即可，**不需要改任何代码**。

## 常见问题

- **报错 `服务器未配置 GEMINI_API_KEY`**：在项目根目录创建 `.env.local` 并填入 Key，然后重启 `npm run dev`。
- **网络不通**：Gemini API 域名为 `generativelanguage.googleapis.com`，部分网络环境需要代理。
