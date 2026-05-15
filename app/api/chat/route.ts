import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const CHAT_BACKEND_URL =
  process.env.CHAT_BACKEND_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:8000";

/**
 * BFF：将对话请求转发到 FastAPI 核心服务，并透传 SSE（text/event-stream）。
 * Agent 逻辑已迁移至 backend/（Python）。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.text();

    let upstream: Response;
    try {
      upstream = await fetch(`${CHAT_BACKEND_URL}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": req.headers.get("content-type") ?? "application/json",
          Accept: "text/event-stream",
        },
        body,
      });
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "无法连接 AI 后端，请确认已启动 uvicorn (8000)";
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") ?? "";

    if (
      !upstream.ok &&
      contentType.includes("application/json")
    ) {
      try {
        const errJson = (await upstream.json()) as { error?: string };
        return NextResponse.json(
          { error: errJson?.error ?? upstream.statusText },
          { status: upstream.status }
        );
      } catch {
        return NextResponse.json(
          { error: upstream.statusText || "上游错误" },
          { status: upstream.status }
        );
      }
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType.includes("text/event-stream")
          ? "text/event-stream"
          : contentType || "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err: unknown) {
    console.error("[/api/chat] proxy error:", err);
    const message =
      err instanceof Error ? err.message : "服务器内部错误，请稍后再试";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
