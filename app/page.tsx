"use client";

import { useEffect, useRef, useState, FormEvent } from "react";

interface InterviewAnswer {
  analysis: string;
  knowledgePoints: string[];
  codeExample: string;
}

type Message =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "ai"; content: InterviewAnswer }
  | { id: string; role: "error"; content: string };

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function HomePage() {
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    const userMsg: Message = { id: uid(), role: "user", content: question };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || `请求失败 (${res.status})`);
      }

      const aiMsg: Message = {
        id: uid(),
        role: "ai",
        content: data as InterviewAnswer,
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      const errorMsg: Message = {
        id: uid(),
        role: "error",
        content: err instanceof Error ? err.message : "未知错误",
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
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
          {messages.length === 0 && !loading && <EmptyState />}

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

function EmptyState() {
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
          <div
            key={q}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-left text-sm text-gray-700"
          >
            {q}
          </div>
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
