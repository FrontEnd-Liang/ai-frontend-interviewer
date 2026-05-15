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
import re
from collections.abc import AsyncIterator
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


def build_router_system_prompt(has_internet: bool) -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    today = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y/%m/%d %H:%M:%S")
    if not has_internet:
        return (
            "你是一个无情的工具路由机器。\n"
            "遇到 [闭包,React,原理,Fiber,事件循环,Vue,浏览器,工程化,性能,内存] → 必须调用 search_frontend_handbook。\n"
            "禁止任何解释或闲聊，直接返回工具调用指令。"
        )
    return (
        f"当前系统绝对时间：{today}。\n"
        "你是一个无情的工具路由机器。\n"
        "遇到 [天气,股票,新闻,最新,2025,2026] 必须调用 internet_search；\n"
        "遇到 [闭包,React,原理] 必须调用 search_frontend_handbook。\n"
        "禁止任何解释或闲聊，直接返回工具调用指令。"
    )


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


def run_phases_sync(message: str, settings: Settings) -> dict[str, Any]:
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

    model_with_tools = model.bind_tools(tools)
    ai_msg: AIMessage = model_with_tools.invoke(
        [
            SystemMessage(build_router_system_prompt(has_internet)),
            HumanMessage(message),
        ]
    )

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
    formatter_user_content = (
        f"# 原始问题\n{message}\n\n"
        f"# 已收集到的资料（Agent 已自主调用工具检索整理）\n"
        f"{raw_answer or '(Agent 未提供文字回答，请基于你已有的前端知识回答原始问题。)'}\n\n"
        "请基于以上资料，严格按字段约束输出结构化 JSON。"
    )

    try:
        final_result = structured_model.invoke(
            [
                SystemMessage(FORMATTER_SYSTEM_PROMPT),
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
        await asyncio.sleep(0)

    if isinstance(kps, list) and kps:
        yield _sse({"type": "knowledgePoints", "items": [str(x) for x in kps]})

    for chunk in _iter_text_chunks(code, 2):
        yield _sse({"type": "delta", "field": "codeExample", "text": chunk})
        await asyncio.sleep(0)

    yield _sse({"type": "done"})


def validate_settings(settings: Settings) -> str | None:
    if not settings.gemini_api_key.strip():
        return "服务器未配置 GEMINI_API_KEY，请检查 .env.local 或 backend/.env"
    if not settings.pinecone_api_key.strip():
        return "服务器未配置 PINECONE_API_KEY，请检查 .env.local 或 backend/.env"
    if not settings.pinecone_index.strip():
        return "服务器未配置 PINECONE_INDEX，请检查 .env.local 或 backend/.env"
    return None


async def chat_sse(raw_message: str | None) -> AsyncIterator[str]:
    """
    Async generator of SSE lines (`data: {...}\\n\\n`).
    错误也以 SSE 事件返回，便于 BFF 原样透传。
    """
    settings = get_settings()
    message = (raw_message or "").strip()

    if not message:
        yield _sse({"type": "error", "message": "请输入有效的问题内容"})
        return

    if GREETING_REGEX.match(message):
        async for line in _stream_answer_payload(GREETING_PAYLOAD):
            yield line
        return

    err = validate_settings(settings)
    if err:
        yield _sse({"type": "error", "message": err})
        return

    try:
        safe = await asyncio.to_thread(run_phases_sync, message, settings)
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
