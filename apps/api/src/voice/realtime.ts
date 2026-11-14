import { MockDatabase } from "../db/mockDb.js";
import { HybridRetriever } from "../rag/retriever.js";
import { TelemetryBus } from "../agent/telemetry.js";
import { buildSystemPrompt } from "../agent/prompts.js";
import type { SessionContext } from "../agent/stateMachine.js";
import { TOOLS, toolKind } from "../tools/registry.js";
import { jsonSchemaFor, type ToolName } from "../tools/schemas.js";
import { getHandler, type ToolContext } from "../tools/handlers.js";
import { evaluateToolGuardrails } from "../guardrails/guardrails.js";

/**
 * OpenAI Realtime voice bridge.
 *
 * The browser opens a WebRTC connection directly to the Realtime model using an
 * ephemeral token minted here. The model is given the SAME tool catalogue as the
 * text runtime; when it wants to call a tool the browser forwards it to
 * POST /voice/tool, which runs `executeVoiceTool` below — so voice writes pass
 * the identical deterministic guardrail gate as text. One agent core, two
 * transports.
 */

const REALTIME_URL = "https://api.openai.com/v1/realtime/client_secrets";

function realtimeToolDefs() {
  return (Object.keys(TOOLS) as ToolName[]).map((name) => ({
    type: "function" as const,
    name,
    description: TOOLS[name].description,
    parameters: jsonSchemaFor(name),
  }));
}

export interface RealtimeSessionToken {
  /** Ephemeral token the browser uses to authenticate the WebRTC call. */
  value: string;
  model: string;
  tools_count: number;
}

export async function createRealtimeSession(): Promise<RealtimeSessionToken> {
  const model = process.env.REALTIME_MODEL?.trim() || "gpt-realtime";
  const instructions =
    buildSystemPrompt("AUTHENTICATING", new Date().toISOString()) +
    "\n\nLANGUAGE: Always speak and respond in English, regardless of what language you think you heard. Never switch languages." +
    "\n\nVoice style: speak naturally and briefly. If a turn is unintelligible, empty, or sounds like background noise, do not guess — briefly ask the supporter to repeat themselves. Always verify identity first. For any write action, read back the impact and get a spoken 'yes' before calling the tool with user_confirmed=true.";

  // GA Realtime: mint an ephemeral client secret (POST /v1/realtime/client_secrets).
  const res = await fetch(REALTIME_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        instructions,
        audio: {
          input: {
            transcription: { model: "whisper-1", language: "en" },
            // Require clearer speech before a turn fires — reduces silence hallucinations.
            turn_detection: { type: "server_vad", threshold: 0.6, silence_duration_ms: 600 },
          },
          output: { voice: "alloy" },
        },
        tools: realtimeToolDefs(),
        tool_choice: "auto",
      },
    }),
  });
  if (!res.ok) throw new Error(`Realtime session mint failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { value?: string; client_secret?: { value: string } };
  const value = json.value ?? json.client_secret?.value;
  if (!value) throw new Error("Realtime session mint returned no ephemeral token");
  return { value, model, tools_count: realtimeToolDefs().length };
}

/**
 * Single-shot tool resolution for a voice-originated call. Mirrors the
 * orchestrator's per-call logic (guardrail gate for WRITE, direct execute for
 * READ/AUTH) so both transports enforce identical policy.
 */
export async function executeVoiceTool(
  session: SessionContext,
  db: MockDatabase,
  retriever: HybridRetriever,
  bus: TelemetryBus,
  name: string,
  args: unknown
): Promise<unknown> {
  const toolName = name as ToolName;
  if (!TOOLS[toolName]) return { error: `Unknown tool '${name}'.` };

  const ctx: ToolContext = { db, session, retriever, bus };
  const kind = toolKind(toolName);
  bus.emit({ type: "tool_proposed", tool: toolName, kind: kind === "AUTH" ? "READ" : kind, args, callId: "voice" });

  const run = async () => {
    const t0 = Date.now();
    const result = await getHandler(toolName)(args, ctx);
    bus.emit({ type: "tool_result", tool: toolName, callId: "voice", latencyMs: Date.now() - t0, ok: result.ok, preview: result.preview });
    return result;
  };

  if (TOOLS[toolName].autoExecute) {
    const result = await run();
    if (toolName === "verify_supporter_identity" && result.ok && session.state === "AUTHENTICATING") {
      bus.emit({ type: "state_change", from: "AUTHENTICATING", to: "TRIAGE_READY", at: Date.now() });
      session.state = "TRIAGE_READY";
    }
    return result.data;
  }

  const verdict = await evaluateToolGuardrails(toolName, args, session, db);
  bus.emit({
    type: "guardrail_check",
    tool: toolName,
    callId: "voice",
    allowed: verdict.allowed,
    code: verdict.allowed ? undefined : verdict.code,
    reason: verdict.allowed ? undefined : verdict.reason,
  });
  if (!verdict.allowed) {
    return { status: verdict.code === "CONFIRMATION_REQUIRED" ? "CONFIRMATION_REQUIRED" : "GUARDRAIL_VIOLATION", code: verdict.code, reason: verdict.reason, impact_summary: verdict.allowed ? undefined : verdict.confirmationSummary };
  }
  const result = await run();
  session.pendingAction = null;
  return result.data;
}
