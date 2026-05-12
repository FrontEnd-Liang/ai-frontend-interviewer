# 前端面试官 · AI 智能体架构 (Agentic Workflow)

## 📺 项目演示 (Demo)

<div align="center">
  <video src="https://github.com/user-attachments/assets/dea2dc8c-7008-47c9-a3c0-39f2ece4af31" width="100%" controls autoplay loop muted>
    您的浏览器不支持 HTML5 视频，请点击<a href="https://github.com/user-attachments/assets/dea2dc8c-7008-47c9-a3c0-39f2ece4af31">此处</a>查看演示。
  </video>
</div>

> **注：** 右侧终端实时展示了 Agent 的路由决策逻辑（如 `internet_search` 调用及物理层拦截日志）。

一个基于现代化多智能体协作流（Agentic Workflow）的前端技术问答平台。系统摒弃了传统的线性问答，利用原生 Tool Calling 能力，实现了本地私有知识库（RAG）与实时互联网数据的混合检索与精准路由。

> **底层驱动：Google Gemini（推荐 `gemini-1.5-flash`）**，通过 `@langchain/google-genai` 原生接入。

## 🛠 技术栈与核心基建

- **前端框架**：Next.js 14（App Router） + React 18 + TypeScript + TailwindCSS
- **AI 编排引擎**：LangChain.js
  - 核心调度：`@langchain/core`（使用原生 `bindTools` 实现零冗余单步路由）
  - 模型接入：`@langchain/google-genai`
  - 向量切分：`@langchain/textsplitters`
- **基础设施**：
  - **Pinecone**：Serverless 向量数据库（用于存储与检索前端底层原理）
  - **Tavily**：实时互联网搜索引擎（用于获取 2026 年最新前沿技术与实时物理数据）

## 📂 目录结构

```text
app/
  api/chat/route.ts        # Agent 核心大脑：意图拦截 + 原生 Tool Calling + 降级兜底
  layout.tsx               # 根布局
  page.tsx                 # 聊天 UI（流式无缝渲染、结构化卡片展示）
docs/
  frontend-handbook.md     # RAG 私有知识库源文件
scripts/
  ingest.ts                # 自动化数据向量化与 Pinecone 写入脚本
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
[用户提问]
   │
   ├─► 物理层正则拦截 (如"你好") ──(短路返回)──► [响应 JSON] ⚡ 极速 0 成本
   │
   ▼
┌────────────────────────────────────────────────────────┐
│ 阶段 A：Native Tool-Calling Router (大模型原生意图分发)│
│ (注入系统绝对时间戳，消除大模型"时间盲视"预测幻觉)     │
│ ───────────────────────────────────────────────────────│
│ 动态绑定 ▼                                             │
│ ┌──────────────────┐   ┌──────────────────┐            │
│ │search_frontend_  │   │internet_search   │            │
│ │handbook(Pinecone)│   │(Tavily 泛搜索)   │            │
│ └────────┬─────────┘   └────────┬─────────┘            │
│          └──────────────┬───────┘                      │
│                         ▼                              │
│       Node.js 后端手动执行工具，获取 Raw Text          │
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
└────────────────────────────────────────────────────────┘
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
