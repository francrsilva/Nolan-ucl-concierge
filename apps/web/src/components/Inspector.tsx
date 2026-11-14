import type { TelemetryEvent, AgentState } from "../types.ts";

const STATE_STYLE: Record<AgentState, string> = {
  AUTHENTICATING: "bg-slate-700 text-slate-200",
  TRIAGE_READY: "bg-emerald-900/60 text-emerald-300 ring-1 ring-emerald-700/50",
  AWAITING_CONFIRMATION: "bg-amber-900/60 text-amber-300 ring-1 ring-amber-700/50",
  EXECUTING_MUTATION: "bg-sky-900/60 text-sky-300 ring-1 ring-sky-700/50",
  ESCALATION_PREP: "bg-orange-900/60 text-orange-300 ring-1 ring-orange-700/50",
  HUMAN_HANDOFF: "bg-rose-900/60 text-rose-300 ring-1 ring-rose-700/50",
};

export function StatePill({ state }: { state: AgentState }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide ${STATE_STYLE[state]}`}>
      {state.replace(/_/g, " ")}
    </span>
  );
}

function Row({ accent, icon, title, children }: { accent: string; icon: string; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 py-1.5">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-sm" style={{ color: accent }}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-tight text-slate-200">{title}</div>
        {children && <div className="mt-1 text-[12px] leading-snug text-slate-400">{children}</div>}
      </div>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "ok" | "bad" | "muted" }) {
  const c = tone === "ok" ? "bg-emerald-900/50 text-emerald-300" : tone === "bad" ? "bg-rose-900/50 text-rose-300" : "bg-slate-800 text-slate-400";
  return <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${c}`}>{children}</span>;
}

function EventRow({ e }: { e: TelemetryEvent }) {
  switch (e.type) {
    case "state_change":
      return (
        <Row accent="#94a3b8" icon="↹" title={<span>state <span className="text-slate-400">{e.from.replace(/_/g, " ")}</span> → <span className="font-semibold text-slate-100">{e.to.replace(/_/g, " ")}</span></span>} />
      );
    case "tool_proposed":
      return (
        <Row accent={e.kind === "WRITE" ? "#fbbf24" : "#60a5fa"} icon="→" title={<span>proposed <span className="font-mono text-slate-100">{e.tool}</span> <Badge tone="muted">{e.kind}</Badge></span>}>
          <pre className="overflow-x-auto rounded bg-black/40 p-2 font-mono text-[11px] text-slate-400">{safeArgs(e.args)}</pre>
        </Row>
      );
    case "guardrail_check":
      return e.allowed ? (
        <Row accent="#4ade80" icon="✓" title={<span>guardrail <span className="font-mono">{e.tool}</span> <Badge tone="ok">ALLOW</Badge></span>} />
      ) : (
        <Row accent="#f87171" icon="⛔" title={<span>guardrail <span className="font-mono">{e.tool}</span> <Badge tone="bad">BLOCK {e.code}</Badge></span>}>
          {e.reason}
        </Row>
      );
    case "rag_retrieval":
      return (
        <Row accent="#38bdf8" icon="🔎" title={<span>policy search <Badge tone="muted">{e.venue}</Badge> <span className="text-slate-500">· {e.latencyMs}ms</span></span>}>
          <div className="flex flex-col gap-0.5">
            {e.chunks.map((c, i) => (
              <div key={i} className="truncate">
                <span className="text-slate-300">{c.heading}</span> <span className="text-slate-600">· {c.score}</span>
              </div>
            ))}
          </div>
        </Row>
      );
    case "tool_result":
      return (
        <Row accent={e.ok ? "#4ade80" : "#f87171"} icon={e.ok ? "✓" : "✕"} title={<span>result <span className="font-mono">{e.tool}</span> <span className="text-slate-500">· {e.latencyMs}ms</span></span>}>
          {e.preview}
        </Row>
      );
    case "confirmation_required":
      return <Row accent="#fbbf24" icon="⏸" title={<span>confirmation required</span>}>{e.summary}</Row>;
    case "escalation":
      return <Row accent="#fb923c" icon="🚨" title={<span>escalated to human <Badge tone="muted">{e.escalationId}</Badge> <Badge tone="muted">{e.urgency}</Badge></span>} />;
    case "turn_complete":
      return (
        <div className="my-1.5 flex items-center gap-2 text-[11px] text-slate-600">
          <div className="h-px flex-1 bg-slate-800" />
          turn complete · {e.totalLatencyMs}ms
          <div className="h-px flex-1 bg-slate-800" />
        </div>
      );
    case "error":
      return <Row accent="#f87171" icon="✕" title={<span className="text-rose-300">error</span>}>{e.message}</Row>;
    default:
      return null;
  }
}

function safeArgs(args: unknown): string {
  try {
    const obj = typeof args === "object" && args ? { ...(args as Record<string, unknown>) } : args;
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(args);
  }
}

export function Inspector({ events, busy }: { events: TelemetryEvent[]; busy: boolean }) {
  // Hide raw token deltas from the trace; the chat pane already renders them.
  const shown = events.filter((e) => e.type !== "token" && e.type !== "assistant_message");
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="ucl-gradient-text text-sm font-bold">FDE Inspector</span>
          <span className="text-xs text-slate-500">live execution trace</span>
        </div>
        {busy && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="live-dot h-2 w-2 rounded-full bg-emerald-400" /> streaming
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {shown.length === 0 ? (
          <div className="mt-10 text-center text-sm text-slate-600">
            Run a scenario or send a message.<br />Every tool call, guardrail verdict, RAG hit and state change appears here in real time.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/60">
            {shown.map((e, i) => (
              <EventRow key={i} e={e} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
