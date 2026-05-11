# 前端面试官 · AI 问答工具（第一阶段单点突破）

一个极简的 AI 问答 Demo：内置「前端技术面试官」System Prompt，强制大模型以 JSON 结构化输出，前端解析为卡片展示。

> **底层模型：Google Gemini（`gemini-2.5-flash`）**，通过 `@langchain/google-genai` 接入。

## 技术栈

- Next.js 14（App Router） + React 18 + TypeScript
- TailwindCSS
- LangChain.js（`@langchain/core` + `@langchain/google-genai` + `@langchain/pinecone` + `@langchain/textsplitters`）
- Pinecone（向量数据库，用于 RAG 检索）

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
```

> - Gemini Key：[Google AI Studio](https://aistudio.google.com/app/apikey) 免费申请。
> - Pinecone：[app.pinecone.io](https://app.pinecone.io) 注册 → 创建 Serverless 索引，**维度 768、metric cosine**（必须，因为 `text-embedding-004` 输出 768 维）。

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

### RAG 流程

1. **入库**（`scripts/ingest.ts`）：`frontend-handbook.md` → `RecursiveCharacterTextSplitter` 切块 → Gemini `text-embedding-004` 向量化 → `PineconeStore.fromDocuments` 写入索引。
2. **检索**（`app/api/chat/route.ts`）：用户问题 → 用同一个 embedding 模型向量化 → `vectorStore.similaritySearch(q, 3)` 召回 Top 3 → 拼成 `[片段1] ... [片段2] ... [片段3]` 注入 System Prompt。
3. **生成**：把带 Context 的 System Prompt + 用户原问题喂给 `gemini-2.5-flash` 的 `withStructuredOutput`，仍然产出 `{ analysis, knowledgePoints, codeExample }`。

> RAG 只影响 System Prompt 的内容，**完全不改动原有的 JSON Schema 输出约束**。

### 强制结构化输出

在 `app/api/chat/route.ts` 中通过 `ChatPromptTemplate` 注入面试官人设，并使用 LangChain 的 **`.withStructuredOutput(schema)`** 把 Gemini 的输出绑定到 JSON Schema 上：

```ts
{
  analysis: string;          // 技术分析
  knowledgePoints: string[]; // 核心知识点
  codeExample: string;       // 极简代码示例
}
```

`withStructuredOutput` 底层会调用 Gemini 的 **Function Calling / Response Schema** 能力，比单纯 Prompt 约束更稳定。同时服务端再做一次字段类型兜底校验，避免脏数据打挂前端。

### UI 卡片渲染

前端 `app/page.tsx` 不会展示原始 JSON，而是将三个字段以「技术分析 / 核心知识点（Tag）/ 代码示例（代码块）」卡片化渲染。

## 切换模型

只想换 Gemini 系列模型（如 `gemini-2.5-pro`、`gemini-2.0-flash`），改环境变量 `GEMINI_MODEL` 即可，**不需要改任何代码**。

## 常见问题

- **报错 `服务器未配置 GEMINI_API_KEY`**：在项目根目录创建 `.env.local` 并填入 Key，然后重启 `npm run dev`。
- **网络不通**：Gemini API 域名为 `generativelanguage.googleapis.com`，部分网络环境需要代理。
