import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { z } from "zod";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { tool } from "@langchain/core/tools";
import { SystemMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
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

// 阶段 B 使用：把任意自由文本 / 工具原始返回内容格式化为受约束的 JSON。
// 注意：刻意保持中立的"内容转换器"语气，**不引入任何身份/拒答倾向**，
// 否则模型会在用户问天气/股票时擅自插入"我是面试官，不答外部话题"的话术，
// 把阶段 A 拿到的真实工具结果全部覆盖掉。
const FORMATTER_SYSTEM_PROMPT = `你是一个内容到 JSON 的纯转换器。
将下方"已收集到的资料"忠实地折叠进以下 schema：

- analysis: 对原始问题的简短分析或答案（2~5 句话，中文）
- knowledgePoints: 涉及的核心知识点 / 关键词，3~6 个，简短词组（字符串数组）
- codeExample: 资料中最具代表性的极简代码示例；没有合适代码则返回空字符串 ""

硬约束：
- 字段名必须完全一致：analysis / knowledgePoints / codeExample
- 不允许输出多余字段
- 必须严格忠于资料，不要编造资料中未出现的事实
- **不要扮演任何角色、不要拒答、不要附加道德/范围提醒**，只做格式转换`;

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

function buildRouterSystemPrompt(hasInternet: boolean): string {
  // 获取当前北京时间的绝对坐标
  const today = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (!hasInternet) {
    return `你是一个无情的工具路由机器。
遇到 [闭包,React,原理,Fiber,事件循环,Vue,浏览器,工程化,性能,内存] → 必须调用 search_frontend_handbook。
禁止任何解释或闲聊，直接返回工具调用指令。`;
  }
  return `当前系统绝对时间：${today}。
你是一个无情的工具路由机器。
遇到 [天气,股票,新闻,最新,2025,2026] 必须调用 internet_search；
遇到 [闭包,React,原理] 必须调用 search_frontend_handbook。
禁止任何解释或闲聊，直接返回工具调用指令。`;
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
            "一个全能的互联网搜索引擎。当用户询问任何关于天气、股票、新闻、实时数据、2025/2026最新信息，或一切本地查不到的事实时，必须调用此工具。",
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
    // 阶段 A：原生 bindTools 路由 —— 单步 invoke + 手动派发
    // 不再使用 AgentExecutor / createToolCallingAgent：
    //   1. 不让模型进入"自我反思 → 二次总结"的多轮循环（慢 & 触发限流）
    //   2. 不让模型拿到工具结果后用自然语言"复述"，导致角色拒答覆盖真实数据
    //   3. 工具原始输出直接作为 rawAnswer，由阶段 B 折成 JSON
    // ============================================================
    const model = new ChatGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY,
      model: "gemini-2.5-flash",
      temperature: 0,
      maxRetries: 2,
    });

    console.log(
      "✅ 已经向大模型注册的真实工具清单:",
      tools.map((t) => t.name)
    );

    const modelWithTools = model.bindTools(tools);

    const aiMsg = await modelWithTools.invoke([
      new SystemMessage(buildRouterSystemPrompt(hasInternet)),
      new HumanMessage(message),
    ]);

    const toolCalls = Array.isArray(aiMsg.tool_calls) ? aiMsg.tool_calls : [];
    const calledTools: string[] = [];
    let rawAnswer: string;

    if (toolCalls.length > 0) {
      // 模型决定调用工具：在本地手动执行，**不**把工具结果再送回模型二次总结。
      const toolOutputs: string[] = [];
      for (const tc of toolCalls) {
        const matched = tools.find((t) => t.name === tc.name);
        if (!matched) {
          console.warn(`[/api/chat] 模型试图调用未注册的工具: ${tc.name}`);
          continue;
        }
        calledTools.push(tc.name);
        try {
          // 把完整 ToolCall 传进去（LangChain 会自动用 zod 校验 tc.args），
          // 返回值会被包成 ToolMessage —— 真正的字符串内容在 .content 上。
          const out = await matched.invoke(tc);
          const rawContent =
            out instanceof ToolMessage ? out.content : out;
          const outStr =
            typeof rawContent === "string"
              ? rawContent
              : JSON.stringify(rawContent);
          toolOutputs.push(
            `# 工具 [${tc.name}] · 入参 ${JSON.stringify(tc.args)}\n${outStr}`
          );
        } catch (toolErr) {
          const m = toolErr instanceof Error ? toolErr.message : String(toolErr);
          console.warn(`[/api/chat] 工具 ${tc.name} 调用失败: ${m}`);
          toolOutputs.push(`# 工具 [${tc.name}] 调用失败: ${m}`);
        }
      }
      rawAnswer = toolOutputs.join("\n\n---\n\n").trim();
    } else {
      // 模型没决定调用工具（通常是日常问候 / 模型自评不需要外部信息）
      rawAnswer =
        typeof aiMsg.content === "string"
          ? aiMsg.content
          : JSON.stringify(aiMsg.content);
    }

    console.log(
      `[/api/chat] 🛠 tools used: ${
        calledTools.length
          ? `[${calledTools.join(", ")}]`
          : "(none, 模型直接回答)"
      }`
    );

    // ============================================================
    // 阶段 B：把 Agent 的自由文本强制折成 { analysis, knowledgePoints, codeExample }
    // 注意：此处 **绝对不能** 把 catch 到的错误向上抛 —— 否则前端拿到 500，
    // 阶段 A 已经辛苦拿到的 rawAnswer 就全废了。所以本块独立 try/catch，
    // 任何失败（429 限流 / 网络抖动 / Schema 不合规 …）都走"降级兜底"。
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

    let safe: InterviewAnswer;
    try {
      const finalResult = await structuredModel.invoke([
        new SystemMessage(FORMATTER_SYSTEM_PROMPT),
        new HumanMessage(formatterUserContent),
      ]);

      safe = {
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

      // 双重保险：模型偶尔会返回 schema 合规但全空字符串。这种情况也走兜底。
      if (!safe.analysis && !safe.knowledgePoints.length && !safe.codeExample) {
        throw new Error("structured output 全字段为空");
      }
    } catch (formatterErr) {
      const errMsg =
        formatterErr instanceof Error
          ? formatterErr.message
          : String(formatterErr);
      const is429 = /429|rate.?limit|quota|too many|resource_exhausted/i.test(
        errMsg
      );
      console.warn(
        `[/api/chat] ⚠️ 阶段 B 格式化失败${
          is429 ? "（429 限流）" : ""
        }，启用降级兜底：${errMsg}`
      );

      const fallbackAnalysis =
        (rawAnswer ||
          "AI 在阶段 A 也未能产生有效回答，请稍后再试或换个问法。") +
        "\n\n(注：系统当前触发 API 限流，此为降级展示)";

      safe = {
        analysis: fallbackAnalysis,
        knowledgePoints: ["服务限流兜底"],
        codeExample: "",
      };
    }

    return NextResponse.json(safe);
  } catch (err: unknown) {
    console.error("[/api/chat] error:", err);
    const message =
      err instanceof Error ? err.message : "服务器内部错误，请稍后再试";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
