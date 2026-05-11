# 前端面试官 · AI 问答工具（第一阶段单点突破）

一个极简的 AI 问答 Demo：内置「前端技术面试官」System Prompt，强制大模型以 JSON 结构化输出，前端解析为卡片展示。

> **底层模型：Google Gemini（`gemini-2.5-flash`）**，通过 `@langchain/google-genai` 接入。

## 技术栈

- Next.js 14（App Router） + React 18 + TypeScript
- TailwindCSS
- LangChain.js（`@langchain/core` + `@langchain/google-genai`）

## 目录结构

```
app/
  api/chat/route.ts   # LangChain 后端：System Prompt + 结构化输出
  layout.tsx          # 根布局
  page.tsx            # 聊天 UI（用户气泡、AI 卡片、Loading）
  globals.css         # Tailwind 入口
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
```

> 在 [Google AI Studio](https://aistudio.google.com/app/apikey) 申请免费 API Key。

### 3. 启动开发服务器

```bash
npm run dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000) 即可使用。

## 核心实现

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
