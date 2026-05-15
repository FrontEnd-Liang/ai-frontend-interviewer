"""
FastAPI entry: POST /chat → SSE stream (透传结构化回答的增量事件).
"""

import logging
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from agent import chat_sse
from config import get_settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Frontend Interviewer", version="1.0.0")

_settings = get_settings()
_origins = [o.strip() for o in _settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins if _origins else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/chat")
async def chat(request: Request) -> StreamingResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    message = body.get("message")

    async def body_bytes() -> AsyncIterator[bytes]:
        async for chunk in chat_sse(message):
            yield chunk.encode("utf-8")

    return StreamingResponse(
        body_bytes(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
