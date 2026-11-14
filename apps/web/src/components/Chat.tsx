import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types.ts";

export function Chat({
  messages,
  busy,
  onSend,
}: {
  messages: ChatMessage[];
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submit = () => {
    const t = draft.trim();
    if (!t || busy) return;
    onSend(t);
    setDraft("");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <div className="mt-16 text-center text-slate-600">
            <div className="text-4xl">⚽</div>
            <div className="mt-3 text-sm">Pick a scenario above, or say hello.</div>
            <div className="mt-1 text-xs text-slate-700">Demo supporter — UEFA-88412 · PIN 4417</div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {messages.map((m) => (
              <Bubble key={m.id} msg={m} />
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-white/10 bg-black/30 p-3">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={busy ? "Agent is working…" : "Message the concierge…  (Enter to send)"}
            disabled={busy}
            className="max-h-32 flex-1 resize-none rounded-xl border border-white/15 bg-white/5 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#2b5cff] focus:outline-none focus:ring-1 focus:ring-[#2b5cff]/50 disabled:opacity-60"
          />
          <button
            onClick={submit}
            disabled={busy || !draft.trim()}
            className="rounded-xl bg-[#2b5cff] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_0_18px_rgba(43,92,255,0.45)] transition hover:bg-[#3b6bff] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-gradient-to-br from-[#2b5cff] to-[#3a2bff] text-white shadow-[0_0_16px_rgba(43,92,255,0.35)]"
            : "border border-white/10 bg-white/[0.07] text-slate-100"
        }`}
      >
        {msg.text || (msg.streaming ? <span className="text-slate-400">…</span> : "")}
        {msg.streaming && msg.text && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-[#7fe7ff]" />}
      </div>
    </div>
  );
}
