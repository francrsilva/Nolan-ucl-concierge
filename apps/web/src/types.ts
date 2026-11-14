// Mirror of the API's telemetry event union (apps/api/src/agent/telemetry.ts).
// Kept as a local copy so the web build stays decoupled from the server source.

export type AgentState =
  | "AUTHENTICATING"
  | "TRIAGE_READY"
  | "AWAITING_CONFIRMATION"
  | "EXECUTING_MUTATION"
  | "ESCALATION_PREP"
  | "HUMAN_HANDOFF";

export interface RetrievedChunkMeta {
  docId: string;
  heading: string;
  score: number;
}

export type TelemetryEvent =
  | { type: "state_change"; from: AgentState; to: AgentState; at: number }
  | { type: "token"; delta: string }
  | { type: "assistant_message"; text: string; at: number }
  | { type: "rag_retrieval"; query: string; venue: string; chunks: RetrievedChunkMeta[]; latencyMs: number }
  | { type: "tool_proposed"; tool: string; kind: "READ" | "WRITE"; args: unknown; callId: string }
  | { type: "guardrail_check"; tool: string; callId: string; allowed: boolean; code?: string; reason?: string }
  | { type: "tool_result"; tool: string; callId: string; latencyMs: number; ok: boolean; preview: string }
  | { type: "confirmation_required"; tool: string; summary: string }
  | { type: "escalation"; escalationId: string; urgency: string }
  | { type: "turn_complete"; finalState: AgentState; totalLatencyMs: number }
  | { type: "error"; message: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

export interface Health {
  ok: boolean;
  model: string;
  ragReady: boolean;
  hasApiKey: boolean;
  sessions: number;
}
