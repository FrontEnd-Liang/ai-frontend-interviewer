import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { z } from "zod";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { tool } from "@langchain/core/tools";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { TavilySearchResults } from "@langchain/community/tools/tavily_search";
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

// 阶段 B 使用：把任意自由文本格式化为受约束的 JSON
const FORMATTER_SYSTEM_PROMPT = `你是一名资深的"前端技术面试官"，现在的任务是把已经整理好的回答格式化为结构化 JSON 输出。

# 输出字段约束（强制）
- analysis: 对该前端问题的简短技术分析（2~5 句话，中文）
- knowledgePoints: 涉及的核心知识点，3~6 个，简短词组（字符串数组）
- codeExample: 相关的极简代码示例；若该问题不适合示例代码，则返回空字符串 ""

# 其它约束
- 字段名必须完全一致：analysis / knowledgePoints / codeExample。
- 不能输出多余字段。
- 必须严格忠于"已收集到的资料"，不要凭空编造或加入未提及的事实。
- 若资料中包含代码片段，提炼一段最具代表性的放入 codeExample。
- 若用户提问与前端无关，仍以面试官身份引导回前端话题，但仍按上述结构输出。`;

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

function buildAgentSystemPrompt(hasInternet: boolean): string {
  const toolMenu = hasInternet
    ? `- search_frontend_handbook：本地手册（React Fiber、浏览器事件循环、闭包陷阱等已沉淀的核心知识点）。优先调用。
- internet_search：互联网搜索。仅当问题涉及最新框架版本、近期新闻、本地手册查不到的话题时调用。`
    : `- search_frontend_handbook：本地手册（React Fiber、浏览器事件循环、闭包陷阱等已沉淀的核心知识点）。
- （互联网搜索工具未启用，本次只能基于本地手册回答）`;

  return `你是一名资深的前端面试官，具备工具调度能力。

# 可用工具
${toolMenu}

# 工作流程
1. 先分析用户的问题属于哪一类，自主选择是否调用工具、调用哪些工具。
2. 可以串行调用多个工具组合信息；信息已足够时直接回答。
3. 输出一段简洁、有条理、含必要技术细节的自由文本（无需 JSON 格式，后续会有专门步骤把你的回答结构化）。`;
}

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

    // ============================================================
    // 共享资源：Embeddings + Pinecone 向量库
    // ============================================================
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

    // ============================================================
    // Tool 1：本地手册检索（Pinecone topK=3）
    // ============================================================
    const handbookTool = tool(
      async ({ query }) => {
        const docs = await vectorStore.similaritySearch(query, 3);
        if (!docs.length) return "本地手册中暂无相关内容。";
        return docs
          .map((d, i) => `[片段${i + 1}]\n${d.pageContent.trim()}`)
          .join("\n\n");
      },
      {
        name: "search_frontend_handbook",
        description:
          "当你需要查询 React 原理、闭包陷阱、前端工程化、浏览器机制等本地手册知识时，调用此工具。",
        schema: z.object({
          query: z.string().describe("要在本地手册中检索的关键词或前端技术问题"),
        }),
      }
    );

    // ============================================================
    // Tool 2：Tavily 互联网搜索（仅在 TAVILY_API_KEY 配置时启用）
    // ============================================================
    const tools: Array<typeof handbookTool> = [handbookTool];

    const hasInternet = Boolean(process.env.TAVILY_API_KEY?.trim());
    if (hasInternet) {
      const tavily = new TavilySearchResults({
        apiKey: process.env.TAVILY_API_KEY,
        maxResults: 3,
      });
      const internetTool = tool(
        async ({ query }) => {
          const raw = await tavily.invoke(query);
          return typeof raw === "string" ? raw : JSON.stringify(raw);
        },
        {
          name: "internet_search",
          description:
            "当用户询问最新的前端技术趋势（如 2026 年最新框架）、外部新闻，或本地手册查不到的内容时，调用此工具。",
          schema: z.object({
            query: z.string().describe("要在互联网上搜索的关键词或问题"),
          }),
        }
      );
      tools.push(internetTool);
    } else {
      console.warn(
        "[/api/chat] TAVILY_API_KEY 未配置，internet_search 已禁用，本次仅可使用本地手册。"
      );
    }

    // ============================================================
    // 阶段 A：Agent 自主调度工具，产出自由文本回答
    // ============================================================
    const model = new ChatGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      temperature: 0.3,
    });

    const agentPrompt = ChatPromptTemplate.fromMessages([
      ["system", buildAgentSystemPrompt(hasInternet)],
      ["human", "{input}"],
      ["placeholder", "{agent_scratchpad}"],
    ]);

    const agent = await createToolCallingAgent({
      llm: model,
      tools,
      prompt: agentPrompt,
    });
    const executor = new AgentExecutor({
      agent,
      tools,
      maxIterations: 5,
      returnIntermediateSteps: true,
    });

    const agentResult = await executor.invoke({ input: message });
    const rawAnswer = String(agentResult?.output ?? "").trim();

    // 把 Agent 调用了哪些工具打印到服务器日志，便于验证路由
    const calledTools: string[] = Array.isArray(agentResult?.intermediateSteps)
      ? agentResult.intermediateSteps
          .map(
            (step: { action?: { tool?: string } }) => step?.action?.tool ?? ""
          )
          .filter((name: string) => name.length > 0)
      : [];
    console.log(
      `[/api/chat] 🛠 tools used:`,
      calledTools.length ? calledTools : "(none, 模型直接回答)"
    );

    // ============================================================
    // 阶段 B：把 Agent 的自由文本强制折成 { analysis, knowledgePoints, codeExample }
    // ============================================================
    const structuredModel = model.withStructuredOutput<InterviewAnswer>(
      answerSchema,
      { name: "InterviewAnswer" }
    );

    const formatterUserContent = `# 原始问题
${message}

# 已收集到的资料（Agent 已自主调用工具检索整理）
${rawAnswer || "(Agent 未提供文字回答，请基于你已有的前端知识回答原始问题。)"}

请基于以上资料，严格按字段约束输出结构化 JSON。`;

    const finalResult = await structuredModel.invoke([
      new SystemMessage(FORMATTER_SYSTEM_PROMPT),
      new HumanMessage(formatterUserContent),
    ]);

    const safe: InterviewAnswer = {
      analysis:
        typeof finalResult?.analysis === "string" ? finalResult.analysis : "",
      knowledgePoints: Array.isArray(finalResult?.knowledgePoints)
        ? finalResult.knowledgePoints.filter((s) => typeof s === "string")
        : [],
      codeExample:
        typeof finalResult?.codeExample === "string"
          ? finalResult.codeExample
          : "",
    };

    return NextResponse.json(safe);
  } catch (err: unknown) {
    console.error("[/api/chat] error:", err);
    const message =
      err instanceof Error ? err.message : "服务器内部错误，请稍后再试";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
