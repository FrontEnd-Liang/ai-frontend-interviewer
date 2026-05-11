import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { Pinecone } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { GeminiEmbeddings } from "@/lib/embeddings";

export const runtime = "nodejs";

// Node 18+ 的原生 fetch（undici）默认不读 HTTPS_PROXY/HTTP_PROXY，
// 在国内访问 Google API 必须显式注入代理，否则会 fetch failed / 超时。
const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;

declare global {
  // eslint-disable-next-line no-var
  var __proxyDispatcherConfigured: boolean | undefined;
}

if (proxyUrl && !globalThis.__proxyDispatcherConfigured) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  globalThis.__proxyDispatcherConfigured = true;
  console.log(`[/api/chat] using proxy: ${proxyUrl}`);
}

export interface InterviewAnswer {
  analysis: string;
  knowledgePoints: string[];
  codeExample: string;
}

const SYSTEM_PROMPT = `你是一名资深的"前端技术面试官"，擅长 JavaScript / TypeScript / React / Vue / 浏览器原理 / 工程化 / 性能优化等领域。

# 你的任务
针对用户提出的前端问题，给出一段精炼、专业、面试场景化的回答。

# 输出字段约束（强制）
- analysis: 对该前端问题的简短技术分析（2~5 句话，中文）
- knowledgePoints: 涉及的核心知识点，3~6 个，简短词组（字符串数组）
- codeExample: 相关的极简代码示例；若该问题不适合示例代码，则返回空字符串 ""

# 其它约束
- 字段名必须完全一致：analysis / knowledgePoints / codeExample。
- 不能输出多余字段。
- 若用户提问与前端无关，仍然以面试官身份礼貌引导回前端话题，但仍要返回上述结构化数据。`;

const answerSchema = {
  type: "object",
  title: "InterviewAnswer",
  description: "前端面试官的结构化回答",
  properties: {
    analysis: {
      type: "string",
      description: "对该前端问题的简短技术分析（2~5 句话，中文）",
    },
    knowledgePoints: {
      type: "array",
      description: "涉及的核心知识点，3~6 个，简短词组",
      items: { type: "string" },
    },
    codeExample: {
      type: "string",
      description: "相关的极简代码示例；若不适合代码示例则返回空字符串",
    },
  },
  required: ["analysis", "knowledgePoints", "codeExample"],
} as const;

export async function POST(req: NextRequest) {
  try {
    const { message } = (await req.json()) as { message?: string };

    if (!message || typeof message !== "string" || !message.trim()) {
      return NextResponse.json(
        { error: "请输入有效的问题内容" },
        { status: 400 }
      );
    }

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "服务器未配置 GEMINI_API_KEY，请检查 .env.local" },
        { status: 500 }
      );
    }
    if (!process.env.PINECONE_API_KEY) {
      return NextResponse.json(
        { error: "服务器未配置 PINECONE_API_KEY，请检查 .env.local" },
        { status: 500 }
      );
    }
    if (!process.env.PINECONE_INDEX) {
      return NextResponse.json(
        { error: "服务器未配置 PINECONE_INDEX，请检查 .env.local" },
        { status: 500 }
      );
    }

    // ============ RAG：向量检索召回背景知识 ============
    const embeddings = new GeminiEmbeddings({
      apiKey: process.env.GEMINI_API_KEY,
      model: "gemini-embedding-001",
      outputDimensionality: 768,
    });

    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX);
    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
      pineconeIndex,
    });

    const retrieved = await vectorStore.similaritySearch(message, 3);
    const context = retrieved.length
      ? retrieved
          .map((d, i) => `[片段${i + 1}]\n${d.pageContent.trim()}`)
          .join("\n\n")
      : "(无可用背景知识)";

    const systemPromptWithContext = `${SYSTEM_PROMPT}

# 背景知识（RAG 召回）
请优先参考以下提供的背景知识来分析问题和提取知识点：
${context}`;

    // ============ 生成结构化回答（保留原有强格式化逻辑） ============
    const model = new ChatGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      temperature: 0.3,
    });

    const structuredModel = model.withStructuredOutput<InterviewAnswer>(
      answerSchema,
      { name: "InterviewAnswer" }
    );

    const result = await structuredModel.invoke([
      new SystemMessage(systemPromptWithContext),
      new HumanMessage(message),
    ]);

    const safe: InterviewAnswer = {
      analysis: typeof result?.analysis === "string" ? result.analysis : "",
      knowledgePoints: Array.isArray(result?.knowledgePoints)
        ? result.knowledgePoints.filter((s) => typeof s === "string")
        : [],
      codeExample:
        typeof result?.codeExample === "string" ? result.codeExample : "",
    };

    return NextResponse.json(safe);
  } catch (err: unknown) {
    console.error("[/api/chat] error:", err);
    const message =
      err instanceof Error ? err.message : "服务器内部错误，请稍后再试";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
