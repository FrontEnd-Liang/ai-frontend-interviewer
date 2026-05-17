"""
Interview agent: Gemini + Pinecone handbook + optional Tavily,
ported from app/api/chat/route.ts (stage A tool routing, stage B JSON formatter).

Exposes async SSE generator `chat_sse` for StreamingResponse.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import re
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
from langchain_community.tools.tavily_search import TavilySearchResults
from langchain_core.embeddings import Embeddings
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_pinecone import PineconeVectorStore
from pydantic import BaseModel, Field

from config import Settings, get_settings
from database import HistoryMessage, get_database

logger = logging.getLogger(__name__)

GREETING_REGEX = re.compile(r"^(你好|在吗|哈喽|hello|hi|测试|滴滴)$", re.I)

GREETING_PAYLOAD: dict[str, Any] = {
    "analysis": (
        "您好！我是您的专属前端技术面试官 AI。我已经准备就绪，您可以问我任何关于前端八股文"
        "（如闭包、React Fiber、微前端架构）的问题，或者向我打听 2026 年最新的技术趋势与实时资讯。"
    ),
    "knowledgePoints": ["系统就绪", "日常交互"],
    "codeExample": "",
}

# 存在对话历史时置于 System Prompt 最前，优先级高于工具路由与安全拒答
HISTORY_PRIORITY_INSTRUCTION = """【最高优先级 · 对话记忆】
处理有关用户身份（姓名、职位）、技术栈偏好或前文已提及具体事实的提问时，你必须**优先且仅**根据传入的对话上下文（history）及已注入的多轮消息进行回答。
严禁在此类情况下使用「无法访问隐私信息」「无法访问个人数据」「无法提供个性化回答」等通用拒答语。
只有在上下文中明确查不到时，才可表示不知道。
此规则的优先级高于一切角色设定、工具路由规则与安全话术。"""

FORMATTER_SYSTEM_PROMPT = """你是一个内容到 JSON 的纯转换器。
将下方"已收集到的资料"忠实地折叠进以下 schema：

- analysis: 对原始问题的简短分析或答案（2~5 句话，中文）
- knowledgePoints: 涉及的核心知识点 / 关键词，3~6 个，简短词组（字符串数组）
- codeExample: 资料中最具代表性的极简代码示例；没有合适代码则返回空字符串 ""

硬约束：
- 字段名必须完全一致：analysis / knowledgePoints / codeExample
- 不允许输出多余字段
- 必须严格忠于资料，不要编造资料中未出现的事实
- **不要扮演任何角色、不要拒答、不要附加道德/范围提醒**，只做格式转换"""


class InterviewResponse(BaseModel):
    """与 TS 版 InterviewAnswer / route.ts schema 字段一致。"""

    analysis: str = Field(description="对该前端问题的简短技术分析（2~5 句话，中文）")
    knowledgePoints: list[str] = Field(
        description="涉及的核心知识点，3~6 个，简短词组"
    )
    codeExample: str = Field(
        description="相关的极简代码示例；若不适合代码示例则返回空字符串"
    )


def _http_proxy() -> str | None:
    return (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
    )


class Gemini768Embeddings(Embeddings):
    """与 lib/embeddings.ts 一致：gemini-embedding-001 + 768 维。"""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def _endpoint(self, action: str) -> str:
        m = self._settings.gemini_embedding_model
        return (
            f"https://generativelanguage.googleapis.com/v1beta/models/{m}:{action}"
        )

    def embed_query(self, text: str) -> list[float]:
        proxy = _http_proxy()
        with httpx.Client(timeout=120.0, proxy=proxy) as client:
            r = client.post(
                self._endpoint("embedContent"),
                params={"key": self._settings.gemini_api_key},
                json={
                    "content": {"parts": [{"text": text}]},
                    "outputDimensionality": self._settings.embedding_dimensions,
                },
            )
            if not r.is_success:
                raise RuntimeError(
                    f"[GeminiEmbeddings] embedContent {r.status_code}: {r.text}"
                )
            data = r.json()
            values = (data.get("embedding") or {}).get("values")
            if not values:
                raise RuntimeError("[GeminiEmbeddings] empty embedding")
            return list(values)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        proxy = _http_proxy()
        m = self._settings.gemini_embedding_model
        with httpx.Client(timeout=120.0, proxy=proxy) as client:
            r = client.post(
                self._endpoint("batchEmbedContents"),
                params={"key": self._settings.gemini_api_key},
                json={
                    "requests": [
                        {
                            "model": f"models/{m}",
                            "content": {"parts": [{"text": t}]},
                            "outputDimensionality": self._settings.embedding_dimensions,
                        }
                        for t in texts
                    ]
                },
            )
            if not r.is_success:
                raise RuntimeError(
                    f"[GeminiEmbeddings] batchEmbedContents {r.status_code}: {r.text}"
                )
            data = r.json()
            embs = data.get("embeddings") or []
            vecs = [list(e.get("values") or []) for e in embs]
            if len(vecs) != len(texts) or any(not v for v in vecs):
                raise RuntimeError("[GeminiEmbeddings] malformed batch response")
            return vecs


def build_router_system_prompt(has_internet: bool, *, has_history: bool = False) -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    today = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y/%m/%d %H:%M:%S")
    if not has_internet:
        router_rules = (
            "你是一个无情的工具路由机器。\n"
            "遇到 [闭包,React,原理,Fiber,事件循环,Vue,浏览器,工程化,性能,内存] → 必须调用 search_frontend_handbook。\n"
            "禁止任何解释或闲聊，直接返回工具调用指令。"
        )
    else:
        router_rules = (
            f"当前系统绝对时间：{today}。\n"
            "你是一个无情的工具路由机器。\n"
            "遇到 [天气,股票,新闻,最新,2025,2026] 必须调用 internet_search；\n"
            "遇到 [闭包,React,原理] 必须调用 search_frontend_handbook。\n"
            "禁止任何解释或闲聊，直接返回工具调用指令。"
        )

    if not has_history:
        return router_rules

    memory_router_addon = (
        "【记忆问答例外 · 高于工具路由】\n"
        "若当前问题仅能从对话历史回答（如候选人姓名、擅长框架、职位、前文已陈述的事实），"
        "请直接依据 history 用简洁中文作答，不要调用任何工具，不要使用隐私/安全类拒答话术。"
    )
    return f"{HISTORY_PRIORITY_INSTRUCTION}\n\n{memory_router_addon}\n\n{router_rules}"


def _tool_call_name(tc: Any) -> str:
    if isinstance(tc, dict):
        return str(tc.get("name", ""))
    return str(getattr(tc, "name", "") or "")


def _tool_call_args(tc: Any) -> dict[str, Any]:
    if isinstance(tc, dict):
        return dict(tc.get("args") or {})
    args = getattr(tc, "args", None)
    return dict(args) if isinstance(args, dict) else {}


def _normalize_ai_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False)


def _assistant_content_for_context(raw: str) -> str:
    """Flatten stored assistant JSON into readable text for prompts."""
    text = raw.strip()
    if not text:
        return text
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            parts: list[str] = []
            if obj.get("analysis"):
                parts.append(str(obj["analysis"]))
            kps = obj.get("knowledgePoints")
            if isinstance(kps, list) and kps:
                parts.append("知识点: " + ", ".join(str(k) for k in kps))
            if obj.get("codeExample"):
                parts.append(str(obj["codeExample"]))
            if parts:
                return "\n".join(parts)
    except (json.JSONDecodeError, TypeError):
        pass
    return text


def _format_history_block(history: list[HistoryMessage] | None) -> str:
    """Human-readable history block for stage B formatter."""
    if not history:
        return ""
    lines: list[str] = ["# 对话历史（回答身份/偏好/前文事实时必须优先采信，禁止隐私拒答）"]
    for h in history:
        label = "用户" if h.role == "user" else "助手"
        body = (
            h.content
            if h.role == "user"
            else _assistant_content_for_context(h.content)
        )
        lines.append(f"- {label}: {body.strip()}")
    return "\n".join(lines) + "\n\n"


def _history_to_langchain(history: list[HistoryMessage] | None) -> list[HumanMessage | AIMessage]:
    """Map stored turns to LangChain messages (chronological)."""
    out: list[HumanMessage | AIMessage] = []
    for h in history or []:
        if h.role == "user":
            out.append(HumanMessage(h.content))
        elif h.role == "assistant":
            out.append(AIMessage(_assistant_content_for_context(h.content)))
    return out


def _interview_to_dict(obj: InterviewResponse | dict[str, Any]) -> dict[str, Any]:
    if isinstance(obj, InterviewResponse):
        return obj.model_dump()
    return {
        "analysis": str(obj.get("analysis", "") or ""),
        "knowledgePoints": [
            s for s in (obj.get("knowledgePoints") or []) if isinstance(s, str)
        ],
        "codeExample": str(obj.get("codeExample", "") or ""),
    }


_TOOL_THINKING_LABELS: dict[str, str] = {
    "search_frontend_handbook": "正在检索本地 React / 前端手册…",
    "internet_search": "正在联网检索实时资讯（Tavily）…",
}


def _emit_thinking(
    emit: Callable[[str], None] | None,
    message: str,
) -> None:
    if emit is not None:
        emit(message)


def run_phases_sync(
    message: str,
    settings: Settings,
    history: list[HistoryMessage] | None = None,
    *,
    on_thinking: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Blocking: stage A (tools) + stage B (structured JSON). Returns camelCase dict."""
    embeddings = Gemini768Embeddings(settings)
    vector_store = PineconeVectorStore.from_existing_index(
        settings.pinecone_index,
        embeddings,
    )

    @tool
    def search_frontend_handbook(query: str) -> str:
        """当你需要查询 React 原理、闭包陷阱、前端工程化、浏览器机制等本地手册知识时，调用此工具。"""
        docs = vector_store.similarity_search(query, 3)
        if not docs:
            return "本地手册中暂无相关内容。"
        parts = [f"[片段{i + 1}]\n{d.page_content.strip()}" for i, d in enumerate(docs)]
        return "\n\n".join(parts)

    tools: list[Any] = [search_frontend_handbook]
    has_internet = settings.has_tavily
    if has_internet:
        tavily = TavilySearchResults(
            api_key=settings.tavily_api_key,
            max_results=3,
        )

        @tool
        def internet_search(query: str) -> str:
            """当用户询问天气、股票、新闻、实时数据、2025/2026最新信息，或一切本地查不到的事实时，必须调用此工具。"""
            raw = tavily.invoke(query)
            return raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)

        tools.append(internet_search)
    else:
        logger.warning(
            "[/chat] TAVILY_API_KEY 未配置，internet_search 已禁用，本次仅可使用本地手册。"
        )

    model = ChatGoogleGenerativeAI(
        model=settings.gemini_model,
        google_api_key=settings.gemini_api_key,
        temperature=0,
        max_retries=2,
    )

    logger.info(
        "✅ 已经向大模型注册的真实工具清单: %s",
        [getattr(t, "name", "?") for t in tools],
    )

    has_history = bool(history)
    model_with_tools = model.bind_tools(tools)
    router_messages: list[SystemMessage | HumanMessage | AIMessage] = [
        SystemMessage(build_router_system_prompt(has_internet, has_history=has_history)),
        *_history_to_langchain(history),
        HumanMessage(message),
    ]
    if history:
        logger.info("[/chat] injected %s history message(s) into router context", len(history))
    _emit_thinking(on_thinking, "正在调用大模型分析意图与工具路由…")
    ai_msg: AIMessage = model_with_tools.invoke(router_messages)

    tool_calls = getattr(ai_msg, "tool_calls", None) or []
    called_tools: list[str] = []
    raw_answer: str

    if tool_calls:
        tool_outputs: list[str] = []
        tools_by_name = {t.name: t for t in tools}
        for tc in tool_calls:
            name = _tool_call_name(tc)
            matched = tools_by_name.get(name)
            if not matched:
                logger.warning("[/chat] 模型试图调用未注册的工具: %s", name)
                continue
            called_tools.append(name)
            args = _tool_call_args(tc)
            tool_label = _TOOL_THINKING_LABELS.get(name)
            if tool_label:
                _emit_thinking(on_thinking, tool_label)
            else:
                _emit_thinking(on_thinking, f"正在执行工具 {name}…")
            try:
                out = matched.invoke(args)
                raw_content = out.content if isinstance(out, ToolMessage) else out
                out_str = (
                    raw_content
                    if isinstance(raw_content, str)
                    else json.dumps(raw_content, ensure_ascii=False)
                )
                tool_outputs.append(
                    f"# 工具 [{name}] · 入参 {json.dumps(args, ensure_ascii=False)}\n{out_str}"
                )
            except Exception as tool_err:
                m = str(tool_err)
                logger.warning("[/chat] 工具 %s 调用失败: %s", name, m)
                tool_outputs.append(f"# 工具 [{name}] 调用失败: {m}")
        raw_answer = "\n\n---\n\n".join(tool_outputs).strip()
    else:
        raw_answer = _normalize_ai_content(ai_msg.content)

    logger.info(
        "[/chat] 🛠 tools used: %s",
        f"[{', '.join(called_tools)}]" if called_tools else "(none, 模型直接回答)",
    )

    structured_model = model.with_structured_output(InterviewResponse)
    history_block = _format_history_block(history)
    formatter_user_content = (
        f"{history_block}"
        f"# 原始问题\n{message}\n\n"
        f"# 已收集到的资料（Agent 已自主调用工具检索整理）\n"
        f"{raw_answer or '(Agent 未提供文字回答，请基于对话历史或前端知识回答原始问题。)'}\n\n"
        "请基于以上资料，严格按字段约束输出结构化 JSON。"
        "若原始问题涉及姓名、技术栈或前文事实，必须优先从「对话历史」提取答案写入 analysis，禁止隐私拒答。"
    )

    formatter_system = FORMATTER_SYSTEM_PROMPT
    if has_history:
        formatter_system = f"{HISTORY_PRIORITY_INSTRUCTION}\n\n{FORMATTER_SYSTEM_PROMPT}"

    _emit_thinking(on_thinking, "正在整理检索结果并生成结构化回答…")
    try:
        final_result = structured_model.invoke(
            [
                SystemMessage(formatter_system),
                HumanMessage(formatter_user_content),
            ]
        )
        safe = _interview_to_dict(final_result)
        if not safe["analysis"] and not safe["knowledgePoints"] and not safe.get(
            "codeExample"
        ):
            raise RuntimeError("structured output 全字段为空")
    except Exception as formatter_err:
        err_msg = str(formatter_err)
        is429 = bool(
            re.search(r"429|rate.?limit|quota|too many|resource_exhausted", err_msg, re.I)
        )
        logger.warning(
            "[/chat] ⚠️ 阶段 B 格式化失败%s，启用降级兜底：%s",
            "（429 限流）" if is429 else "",
            err_msg,
        )
        suffix = "\n\n(注：系统当前触发 API 限流，此为降级展示)" if is429 else ""
        safe = {
            "analysis": (raw_answer or "AI 在阶段 A 也未能产生有效回答，请稍后再试或换个问法。")
            + suffix,
            "knowledgePoints": ["服务限流兜底"],
            "codeExample": "",
        }

    return safe


async def _run_phases_with_thinking_stream(
    message: str,
    settings: Settings,
    history: list[HistoryMessage],
) -> AsyncIterator[str | dict[str, Any]]:
    """
    Run blocking phases in a thread; yield thinking SSE lines from a queue,
    then yield the final payload dict once.
    """
    thinking_q: queue.Queue[str] = queue.Queue()

    def on_thinking(msg: str) -> None:
        thinking_q.put(msg)

    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(
        None,
        lambda: run_phases_sync(
            message, settings, history, on_thinking=on_thinking
        ),
    )

    while not future.done():
        while True:
            try:
                msg = thinking_q.get_nowait()
            except queue.Empty:
                break
            yield _sse({"type": "thinking", "message": msg})
        await asyncio.sleep(0.03)

    while True:
        try:
            msg = thinking_q.get_nowait()
        except queue.Empty:
            break
        yield _sse({"type": "thinking", "message": msg})

    yield await future


def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _iter_text_chunks(text: str, size: int = 2) -> Any:
    for i in range(0, len(text), size):
        yield text[i : i + size]


async def _stream_answer_payload(payload: dict[str, Any]) -> AsyncIterator[str]:
    """SSE：按字段增量推送，供前端打字机。"""
    analysis = str(payload.get("analysis") or "")
    kps = payload.get("knowledgePoints") or []
    code = str(payload.get("codeExample") or "")

    for chunk in _iter_text_chunks(analysis, 2):
        yield _sse({"type": "delta", "field": "analysis", "text": chunk})
        await asyncio.sleep(0.02)

    if isinstance(kps, list) and kps:
        yield _sse({"type": "knowledgePoints", "items": [str(x) for x in kps]})

    for chunk in _iter_text_chunks(code, 2):
        yield _sse({"type": "delta", "field": "codeExample", "text": chunk})
        await asyncio.sleep(0.02)

    yield _sse({"type": "done"})


def validate_settings(settings: Settings) -> str | None:
    if not settings.gemini_api_key.strip():
        return "服务器未配置 GEMINI_API_KEY，请检查 .env.local 或 backend/.env"
    if not settings.pinecone_api_key.strip():
        return "服务器未配置 PINECONE_API_KEY，请检查 .env.local 或 backend/.env"
    if not settings.pinecone_index.strip():
        return "服务器未配置 PINECONE_INDEX，请检查 .env.local 或 backend/.env"
    return None


async def _persist_turn_background(
    session_id: str,
    user_id: str | None,
    user_text: str,
    assistant_payload: dict[str, Any],
) -> None:
    try:
        await asyncio.to_thread(
            get_database().persist_turn,
            session_id,
            user_id,
            user_text,
            assistant_payload,
        )
    except Exception as e:
        logger.warning("[/chat] async persist_turn failed: %s", e)


async def chat_sse(
    raw_message: str | None,
    *,
    session_id: str | None = None,
    user_id: str | None = None,
) -> AsyncIterator[str]:
    """
    Async generator of SSE lines (`data: {...}\\n\\n`).
    错误也以 SSE 事件返回，便于 BFF 原样透传。
    """
    settings = get_settings()
    message = (raw_message or "").strip()
    sid = (session_id or "").strip() or None
    uid = (user_id or "").strip() or None

    if not message:
        yield _sse({"type": "error", "message": "请输入有效的问题内容"})
        return

    if GREETING_REGEX.match(message):
        async for line in _stream_answer_payload(GREETING_PAYLOAD):
            yield line
        if sid and get_database().enabled:
            asyncio.create_task(
                _persist_turn_background(sid, uid, message, GREETING_PAYLOAD)
            )
        return

    err = validate_settings(settings)
    if err:
        yield _sse({"type": "error", "message": err})
        return

    db = get_database()
    history: list[HistoryMessage] = []
    if sid and db.enabled:
        history = await asyncio.to_thread(db.fetch_recent_messages, sid)

    try:
        yield _sse(
            {
                "type": "thinking",
                "message": "正在分析问题意图并规划检索路由…",
            }
        )
        safe: dict[str, Any] | None = None
        async for item in _run_phases_with_thinking_stream(message, settings, history):
            if isinstance(item, str):
                yield item
            else:
                safe = item
        if safe is None:
            raise RuntimeError("run_phases_sync 未返回有效结果")
    except Exception as e:
        logger.exception("[/chat] error")
        yield _sse(
            {
                "type": "error",
                "message": str(e) or "服务器内部错误，请稍后再试",
            }
        )
        return

    async for line in _stream_answer_payload(safe):
        yield line

    if sid and db.enabled:
        asyncio.create_task(_persist_turn_background(sid, uid, message, safe))
