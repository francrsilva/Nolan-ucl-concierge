/**
 * Typed telemetry bus.
 *
 * The orchestrator is transport-agnostic: it never writes to an HTTP response
 * directly. Instead it emits structured events here, and each transport decides
 * how to render them — the text transport serialises them as SSE frames for the
 * React "FDE Inspector" drawer; the voice bridge logs/forwards the same events.
 * This is what lets text + voice share one agent core.
 */

import type { AgentState } from "./stateMachine.js";

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

export interface RetrievedChunkMeta {
  docId: string;
  heading: string;
  score: number;
}

export type TelemetryListener = (e: TelemetryEvent) => void;

export class TelemetryBus {
  private listeners = new Set<TelemetryListener>();
  /** Full ordered log of a turn — handy for evals and the Loom demo trace. */
  readonly log: TelemetryEvent[] = [];

  on(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(e: TelemetryEvent): void {
    this.log.push(e);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken listener must never break the agent loop */
      }
    }
  }
}
