"use client";

import { useEffect, useRef, useState, FormEvent } from "react";

interface InterviewAnswer {
  analysis: string;
  knowledgePoints: string[];
  codeExample: string;
}

/** 与 backend/agent.py SSE 事件对齐 */
type SsePayload =
  | { type: "delta"; field: "analysis" | "codeExample"; text: string }
  | { type: "knowledgePoints"; items: string[] }
  | { type: "done" }
  | { type: "error"; message?: string };

type Message =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "ai"; content: InterviewAnswer }
  | { id: string; role: "error"; content: string };

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const SESSION_STORAGE_KEY = "interview_session_id";
/** 整次 /chat 请求（含 SSE 流）最长等待时间 */
const CHAT_TIMEOUT_MS = 30_000;

const EMPTY_ANSWER: InterviewAnswer = {
  analysis: "",
  knowledgePoints: [],
  codeExample: "",
};

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, id);
  }
  return id;
}

function parseSseDataLine(rawBlock: string): SsePayload | null {
  const line = rawBlock
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  if (!line) return null;
  const jsonStr = line.replace(/^data:\s*/i, "").trim();
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr) as SsePayload;
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      return parsed;
    }
  } catch {
    /* 非预期数据包：跳过本条，不中断整流 */
  }
  return null;
}

type SseConsumeResult = {
  answer: InterviewAnswer;
  sawDone: boolean;
};

/**
 * 消费 SSE 响应体；无论成功/失败/中断，调用方须在 finally 中 setLoading(false)。
 * 等价于对 EventSource 的 onmessage + onerror + onclose 做统一收尾。
 */
async function consumeChatSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onPartial: (answer: InterviewAnswer) => void
): Promise<SseConsumeResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let acc: InterviewAnswer = { ...EMPTY_ANSWER };
  let sawDone = false;

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort);

  try {
    while (!signal.aborted) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (readErr) {
        if (signal.aborted) {
          throw new DOMException("请求已取消或超时", "AbortError");
        }
        throw readErr;
      }

      const { done, value } = chunk;
      if (done) break;

      carry += decoder.decode(value, { stream: true });
      const blocks = carry.split("\n\n");
      carry = blocks.pop() ?? "";

      for (const raw of blocks) {
        const payload = parseSseDataLine(raw);
        if (!payload) continue;

        if (payload.type === "error") {
          throw new Error(payload.message || "流式响应错误");
        }
        if (payload.type === "done") {
          sawDone = true;
          continue;
        }
        if (payload.type === "delta" && payload.field && payload.text) {
          if (payload.field === "analysis") {
            acc = { ...acc, analysis: acc.analysis + payload.text };
          } else if (payload.field === "codeExample") {
            acc = { ...acc, codeExample: acc.codeExample + payload.text };
          }
        }
        if (payload.type === "knowledgePoints" && Array.isArray(payload.items)) {
          acc = {
            ...acc,
            knowledgePoints: payload.items.filter(
              (x): x is string => typeof x === "string"
            ),
          };
        }
        onPartial({ ...acc });
      }
    }

    if (signal.aborted) {
      throw new DOMException("请求已取消或超时", "AbortError");
    }

    if (carry.trim()) {
      const tail = parseSseDataLine(carry);
      if (tail) {
        if (tail.type === "error") {
          throw new Error(tail.message || "流式响应错误");
        }
        if (tail.type === "done") sawDone = true;
        if (tail.type === "delta" && tail.field && tail.text) {
          if (tail.field === "analysis") {
            acc = { ...acc, analysis: acc.analysis + tail.text };
          } else if (tail.field === "codeExample") {
            acc = { ...acc, codeExample: acc.codeExample + tail.text };
          }
        }
        if (tail.type === "knowledgePoints" && Array.isArray(tail.items)) {
          acc = {
            ...acc,
            knowledgePoints: tail.items.filter(
              (x): x is string => typeof x === "string"
            ),
          };
        }
        onPartial({ ...acc });
      }
    }

    return { answer: acc, sawDone };
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* 已释放或已取消 */
    }
    void reader.cancel().catch(() => undefined);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === "AbortError"
  );
}

function toUserFacingError(err: unknown): string {
  if (isAbortError(err)) {
    return `请求超时（${CHAT_TIMEOUT_MS / 1000} 秒），请稍后重试`;
  }
  if (err instanceof Error) return err.message;
  return "未知错误";
}

export default function HomePage() {
  const [sessionId] = useState(getOrCreateSessionId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  async function sendQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = { id: uid(), role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    let streamingAiId: string | null = null;
    const abortController = new AbortController();
    const timeoutId = window.setTimeout(() => {
      abortController.abort();
    }, CHAT_TIMEOUT_MS);

    const finishLoading = () => {
      window.clearTimeout(timeoutId);
      setLoading(false);
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          message: trimmed,
          session_id: sessionId || undefined,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody?.error || `请求失败 (${res.status})`);
      }

      const ct = res.headers.get("content-type") || "";

      if (ct.includes("text/event-stream") && res.body) {
        const aiId = uid();
        streamingAiId = aiId;
        setMessages((prev) => [
          ...prev,
          { id: aiId, role: "ai", content: { ...EMPTY_ANSWER } },
        ]);

        const updateAiBubble = (answer: InterviewAnswer) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiId && m.role === "ai"
                ? { ...m, content: { ...answer } }
                : m
            )
          );
        };

        /* onerror → 抛至外层 catch；onclose → consume 内部 reader 释放 */
        const streamResult = await consumeChatSseStream(
          res.body,
          abortController.signal,
          updateAiBubble
        );

        const { answer, sawDone } = streamResult;
        updateAiBubble(answer);
        const hasContent =
          Boolean(answer.analysis?.trim()) ||
          answer.knowledgePoints.length > 0 ||
          Boolean(answer.codeExample?.trim());

        if (!sawDone && !hasContent) {
          throw new Error("响应未完成或数据异常，请重试");
        }

        updateAiBubble(answer);
      } else {
        const data = (await res.json()) as InterviewAnswer & { error?: string };
        if ("error" in data && data.error) {
          throw new Error(String(data.error));
        }
        const aiMsg: Message = {
          id: uid(),
          role: "ai",
          content: data as InterviewAnswer,
        };
        setMessages((prev) => [...prev, aiMsg]);
      }
    } catch (err) {
      const errorMsg: Message = {
        id: uid(),
        role: "error",
        content: toUserFacingError(err),
      };
      setMessages((prev) => {
        const base = streamingAiId
          ? prev.filter((m) => m.id !== streamingAiId)
          : prev;
        return [...base, errorMsg];
      });
    } finally {
      finishLoading();
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void sendQuestion(input);
  }

  return (
    <main className="flex h-screen flex-col items-center bg-[#f7f7f8]">
      <header className="w-full border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-black text-white">
              <span className="text-sm font-semibold">FE</span>
            </div>
            <div>
              <h1 className="text-sm font-semibold text-gray-900">
                前端技术面试官
              </h1>
              <p className="text-xs text-gray-500">AI · 结构化回答</p>
            </div>
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="w-full flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
          {messages.length === 0 && !loading && (
            <EmptyState onSelect={sendQuestion} />
          )}

          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}

          {loading && <LoadingBubble />}
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="w-full border-t border-gray-200 bg-white"
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2 px-4 py-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as FormEvent);
              }
            }}
            placeholder="问一个前端面试题，例如：闭包是什么？事件循环原理？React Fiber？"
            rows={1}
            className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-2 focus:ring-gray-900/10"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="h-11 shrink-0 rounded-xl bg-gray-900 px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? "思考中…" : "发送"}
          </button>
        </div>
        <p className="pb-3 text-center text-[11px] text-gray-400">
          Enter 发送 · Shift + Enter 换行
        </p>
      </form>
    </main>
  );
}

function EmptyState({ onSelect }: { onSelect: (q: string) => void }) {
  const examples = [
    "什么是闭包？请举一个常见使用场景。",
    "讲一下浏览器事件循环（Event Loop）。",
    "React 中 useMemo 和 useCallback 的区别？",
    "如何排查首屏白屏问题？",
  ];
  return (
    <div className="mt-10 flex flex-col items-center text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-black text-white">
        <span className="text-sm font-semibold">FE</span>
      </div>
      <h2 className="text-lg font-semibold text-gray-900">
        你好，我是你的前端面试官
      </h2>
      <p className="mt-1 text-sm text-gray-500">
        提一个前端问题，我会输出结构化的分析、知识点与代码示例。
      </p>
      <div className="mt-6 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {examples.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onSelect(q)}
            className="cursor-pointer rounded-xl border border-gray-200 bg-white px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900/20"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-gray-900 px-4 py-2.5 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "error") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {message.content}
        </div>
      </div>
    );
  }

  return <AnswerCard answer={message.content} />;
}

function AnswerCard({ answer }: { answer: InterviewAnswer }) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[92%] space-y-3 rounded-2xl rounded-bl-sm border border-gray-200 bg-white p-4 shadow-sm">
        <Section title="技术分析" icon="A">
          <p className="text-sm leading-relaxed text-gray-800">
            {answer.analysis || "（无）"}
          </p>
        </Section>

        <Section title="核心知识点" icon="K">
          {answer.knowledgePoints.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {answer.knowledgePoints.map((kp, i) => (
                <span
                  key={i}
                  className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs text-gray-700"
                >
                  {kp}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">（无）</p>
          )}
        </Section>

        <Section title="代码示例" icon="C">
          {answer.codeExample?.trim() ? (
            <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 text-xs leading-relaxed text-gray-100">
              <code>{answer.codeExample}</code>
            </pre>
          ) : (
            <p className="text-sm text-gray-400">（本题无需代码示例）</p>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gray-900 text-[10px] font-semibold text-white">
          {icon}
        </span>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

function LoadingBubble() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-gray-200 bg-white px-4 py-2.5">
        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400" />
        <span className="ml-1 text-xs text-gray-500">面试官正在组织答案…</span>
      </div>
    </div>
  );
}
