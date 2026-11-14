import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentState, ChatMessage, Health, TelemetryEvent } from "./types.ts";
import { getHealth, streamChat } from "./lib/agentClient.ts";
import { SCENARIOS, type Scenario } from "./lib/scenarios.ts";
import { VoiceClient, type VoiceStatus } from "./lib/voiceClient.ts";
import { Chat } from "./components/Chat.tsx";
import { Inspector, StatePill } from "./components/Inspector.tsx";

export function App() {
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [agentState, setAgentState] = useState<AgentState>("AUTHENTICATING");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const runningRef = useRef(false);

  // Voice mode
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const voiceRef = useRef<VoiceClient | null>(null);
  const voiceAsstIdRef = useRef<string | null>(null);

  useEffect(() => {
    getHealth().then(setHealth);
  }, []);

  const sendInternal = useCallback(
    async (text: string, sid: string) => {
      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text },
        { id: assistantId, role: "assistant", text: "", streaming: true },
      ]);
      setBusy(true);
      try {
        const result = await streamChat(sid, text, (e) => {
          setEvents((prev) => [...prev, e]);
          if (e.type === "token") {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + e.delta } : m)));
          } else if (e.type === "state_change") {
            setAgentState(e.to);
          }
        });
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false, text: m.text || result.reply } : m)));
        setAgentState(result.state as AgentState);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false, text: m.text || `⚠️ ${message}` } : m)));
        setEvents((prev) => [...prev, { type: "error", message }]);
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const onSend = useCallback(
    (text: string) => {
      if (runningRef.current) return;
      runningRef.current = true;
      void sendInternal(text, sessionId).finally(() => {
        runningRef.current = false;
      });
    },
    [sendInternal, sessionId]
  );

  const reset = useCallback(() => {
    if (runningRef.current) return;
    setSessionId(crypto.randomUUID());
    setMessages([]);
    setEvents([]);
    setAgentState("AUTHENTICATING");
  }, []);

  const runScenario = useCallback(
    async (s: Scenario) => {
      if (runningRef.current) return;
      runningRef.current = true;
      const sid = crypto.randomUUID();
      setSessionId(sid);
      setMessages([]);
      setEvents([]);
      setAgentState("AUTHENTICATING");
      try {
        for (const msg of s.messages) {
          // eslint-disable-next-line no-await-in-loop
          await sendInternal(msg, sid);
        }
      } finally {
        runningRef.current = false;
      }
    },
    [sendInternal]
  );

  const stopVoice = useCallback(() => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    voiceAsstIdRef.current = null;
    setVoiceActive(false);
    setVoiceStatus("idle");
  }, []);

  const startVoice = useCallback(async () => {
    if (runningRef.current || voiceActive) return;
    setMessages([]);
    setEvents([]);
    setAgentState("AUTHENTICATING");
    setVoiceActive(true);
    const client = new VoiceClient({
      onStatus: (s) => setVoiceStatus(s),
      onUserTranscript: (text) => setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text }]),
      onAssistantDelta: (delta) => {
        if (!voiceAsstIdRef.current) {
          const id = crypto.randomUUID();
          voiceAsstIdRef.current = id;
          setMessages((prev) => [...prev, { id, role: "assistant", text: delta, streaming: true }]);
        } else {
          const id = voiceAsstIdRef.current;
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m)));
        }
      },
      onAssistantDone: (text) => {
        const id = voiceAsstIdRef.current;
        if (id) setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, streaming: false, text: text || m.text } : m)));
        voiceAsstIdRef.current = null;
      },
      onTelemetry: (evs, state) => {
        setEvents((prev) => [...prev, ...evs]);
        if (state) setAgentState(state as AgentState);
      },
      onError: (msg) => setEvents((prev) => [...prev, { type: "error", message: msg }]),
    });
    voiceRef.current = client;
    try {
      await client.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEvents((prev) => [...prev, { type: "error", message: `voice: ${message}` }]);
      stopVoice();
    }
  }, [voiceActive, stopVoice]);

  return (
    <div className="ucl-backdrop flex h-full flex-col text-slate-100">
      <div className="ucl-ribbon h-1 w-full shrink-0" />
      {/* Header */}
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-[#0a1442] text-lg shadow-[0_0_20px_rgba(43,92,255,0.5)] ring-1 ring-[#2b5cff]/50">⚽</div>
          <div>
            <h1 className="ucl-gradient-text text-sm font-extrabold tracking-tight">UCL Matchday Concierge</h1>
            <p className="text-[11px] text-slate-400">Forward-Deployed Agent console · defense-in-depth runtime</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatePill state={agentState} />
          <div className="hidden text-right text-[11px] text-slate-400 sm:block">
            <div>model {health?.model ?? "…"}</div>
            <div>
              RAG {health?.ragReady ? "on" : "off"} · {health ? (health.hasApiKey ? "key ✓" : "no key") : "…"}
            </div>
          </div>
          <button onClick={reset} disabled={busy || voiceActive} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-40">
            New session
          </button>
          <button
            onClick={() => (voiceActive ? stopVoice() : void startVoice())}
            disabled={busy || !health?.hasApiKey}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40 ${
              voiceActive ? "bg-rose-600 text-white hover:bg-rose-500" : "bg-emerald-600 text-white hover:bg-emerald-500"
            }`}
          >
            {voiceActive ? "■ End voice" : "🎙 Voice"}
          </button>
        </div>
      </header>

      {voiceActive && (
        <div className="flex items-center justify-center gap-2 bg-emerald-950/50 px-5 py-1.5 text-xs text-emerald-300">
          <span className={`h-2 w-2 rounded-full bg-emerald-400 ${voiceStatus === "listening" || voiceStatus === "speaking" ? "live-dot" : ""}`} />
          Voice {voiceStatus === "speaking" ? "— concierge speaking…" : voiceStatus === "listening" ? "— listening, go ahead" : `— ${voiceStatus}`}
          <span className="text-emerald-600">· tool calls run through the same guardrail gate</span>
        </div>
      )}

      {!health?.hasApiKey && health !== null && (
        <div className="bg-amber-950/60 px-5 py-1.5 text-center text-xs text-amber-300">
          The API has no OPENAI_API_KEY set — start it with <code className="font-mono">npm run dev</code> after adding your key to <code className="font-mono">.env</code>.
        </div>
      )}

      {/* Scenario bar */}
      <div className="flex flex-wrap gap-2 border-b border-white/10 bg-black/20 px-5 py-3">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            onClick={() => runScenario(s)}
            disabled={busy || voiceActive}
            title={s.blurb}
            className="group rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-100 transition hover:border-white/30 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderLeft: `3px solid ${s.accent}` }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Split: chat | inspector */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_minmax(360px,460px)]">
        <section className="min-h-0 border-r border-white/10">
          <Chat messages={messages} busy={busy || voiceActive} onSend={onSend} />
        </section>
        <aside className="min-h-0 bg-black/20">
          <Inspector events={events} busy={busy} />
        </aside>
      </div>
    </div>
  );
}
