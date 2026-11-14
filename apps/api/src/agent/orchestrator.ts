import { TelemetryBus } from "./telemetry.js";
import { buildSystemPrompt } from "./prompts.js";
import { runChatTurn } from "./llm.js";
import {
  type SessionContext,
  type AgentState,
  type ChatMessage,
  allowedTools,
} from "./stateMachine.js";
import { TOOLS, openAiToolsFor, toolKind } from "../tools/registry.js";
import { getHandler } from "../tools/handlers.js";
import type { ToolContext } from "../tools/handlers.js";
import { evaluateToolGuardrails } from "../guardrails/guardrails.js";
import type { ToolName } from "../tools/schemas.js";

const MAX_TOOL_ITERATIONS = 8;

export interface RunContext extends Omit<ToolContext, "session"> {}

/**
 * Process a single user turn to completion, emitting telemetry throughout.
 * Returns the final assistant-visible text. Transport layers (SSE text, voice)
 * subscribe to `ctx.bus` for the live trace and never see internals.
 */
export async function handleUserTurn(
  session: SessionContext,
  userText: string,
  ctx: RunContext
): Promise<string> {
  const turnStart = Date.now();
  const bus = ctx.bus;
  const toolCtx: ToolContext = { ...ctx, session };

  session.history.push({ role: "user", content: userText });

  // Once a confirmation is requested this turn, no WRITE may execute until the
  // NEXT user turn — this is what makes the two-turn lock genuinely two-turn.
  let writesLockedThisTurn = false;
  let finalText = "";

  const transition = (to: AgentState) => {
    if (session.state === to) return;
    bus.emit({ type: "state_change", from: session.state, to, at: Date.now() });
    session.state = to;
  };

  // ── Deterministic confirmation RELEASE ───────────────────────
  // The lock is set in code (guardrails); the release fires in code too. We do
  // not depend on the model to re-issue the tool call on "yes" — that is the
  // critical mutation trigger and must be deterministic.
  if (session.state === "AWAITING_CONFIRMATION" && session.pendingAction) {
    const decision = classifyConfirmation(userText);
    if (decision === "confirm") {
      const pa = session.pendingAction;
      const args = { ...(pa.args as Record<string, unknown>), user_confirmed: true };
      const verdict = await evaluateToolGuardrails(pa.tool, args, session, ctx.db);
      bus.emit({ type: "guardrail_check", tool: pa.tool, callId: "confirm", allowed: verdict.allowed, code: verdict.allowed ? undefined : verdict.code, reason: verdict.allowed ? undefined : verdict.reason });
      if (verdict.allowed) {
        transition("EXECUTING_MUTATION");
        const t0 = Date.now();
        try {
          const result = await getHandler(pa.tool)(args, toolCtx);
          bus.emit({ type: "tool_result", tool: pa.tool, callId: "confirm", latencyMs: Date.now() - t0, ok: result.ok, preview: result.preview });
          // Record the outcome as context WITHOUT a role:"tool" message (there is
          // no matching assistant tool_call id to anchor one to).
          session.history.push({ role: "system", content: `[${pa.tool} executed] ${JSON.stringify(result.data)}` });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          bus.emit({ type: "tool_result", tool: pa.tool, callId: "confirm", latencyMs: Date.now() - t0, ok: false, preview: `error: ${message}` });
          session.history.push({ role: "system", content: `[${pa.tool} failed] ${message}` });
        }
        session.pendingAction = null;
        transition("TRIAGE_READY");
        writesLockedThisTurn = true; // let the model only phrase the outcome this turn
      } else {
        session.pendingAction = null;
        transition("TRIAGE_READY");
        session.history.push({ role: "system", content: `[action could not be completed] ${verdict.allowed ? "" : verdict.reason}` });
      }
    } else if (decision === "deny") {
      session.pendingAction = null;
      transition("TRIAGE_READY");
      session.history.push({ role: "system", content: "[supporter declined the pending action — do not execute it; acknowledge and ask how else to help]" });
    }
    // "unclear" → fall through to the normal loop (model handles it)
  }

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const stateTools = allowedTools(session.state).filter((t) =>
      writesLockedThisTurn ? toolKind(t) !== "WRITE" : true
    );
    const tools = openAiToolsFor(stateTools);
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(session.state, new Date(ctx.db.now).toISOString()) },
      ...session.history,
    ];

    const assistant = await runChatTurn(messages, tools, (delta) => bus.emit({ type: "token", delta }));

    // Record the assistant message (with any tool calls) in history.
    session.history.push({
      role: "assistant",
      content: assistant.content,
      tool_calls: assistant.toolCalls.length
        ? assistant.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } }))
        : undefined,
    });

    if (assistant.toolCalls.length === 0) {
      finalText = assistant.content ?? "";
      if (finalText) bus.emit({ type: "assistant_message", text: finalText, at: Date.now() });
      break;
    }

    // Resolve each proposed tool call.
    for (const call of assistant.toolCalls) {
      const name = call.name as ToolName;
      if (!TOOLS[name]) {
        pushToolResult(session, call.id, name, { error: `Unknown tool '${name}'.` });
        continue;
      }
      let args: unknown;
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        pushToolResult(session, call.id, name, { error: "Arguments were not valid JSON." });
        continue;
      }

      const kind = toolKind(name);
      bus.emit({ type: "tool_proposed", tool: name, kind: kind === "AUTH" ? "READ" : kind, args, callId: call.id });

      if (TOOLS[name].autoExecute) {
        await executeTool(name, call.id, args, toolCtx, transition);
        continue;
      }

      // WRITE path → deterministic guardrail gate.
      const verdict = await evaluateToolGuardrails(name, args, session, ctx.db);
      bus.emit({
        type: "guardrail_check",
        tool: name,
        callId: call.id,
        allowed: verdict.allowed,
        code: verdict.allowed ? undefined : verdict.code,
        reason: verdict.allowed ? undefined : verdict.reason,
      });

      if (!verdict.allowed) {
        if (verdict.code === "CONFIRMATION_REQUIRED") {
          writesLockedThisTurn = true;
          transition("AWAITING_CONFIRMATION");
          bus.emit({ type: "confirmation_required", tool: name, summary: verdict.confirmationSummary ?? "" });
          pushToolResult(session, call.id, name, {
            status: "CONFIRMATION_REQUIRED",
            instruction: "Read this impact back to the supporter verbatim and ask for an explicit yes/no. Do NOT call any write tool again this turn.",
            impact_summary: verdict.confirmationSummary,
          });
        } else {
          if (verdict.suggestedEscalation) transition("ESCALATION_PREP");
          pushToolResult(session, call.id, name, {
            status: "GUARDRAIL_VIOLATION",
            code: verdict.code,
            reason: verdict.reason,
            instruction: "Explain this rule to the supporter plainly and offer the best legitimate alternative.",
          });
        }
        continue;
      }

      // Allowed WRITE → execute as a tracked mutation.
      transition("EXECUTING_MUTATION");
      await executeTool(name, call.id, args, toolCtx, transition);
      session.pendingAction = null;
      transition(session.state === "ESCALATION_PREP" ? "ESCALATION_PREP" : "TRIAGE_READY");
    }
  }

  if (!finalText) {
    finalText =
      "I want to get this exactly right — let me connect you with a duty officer to finish up.";
    bus.emit({ type: "assistant_message", text: finalText, at: Date.now() });
  }

  bus.emit({ type: "turn_complete", finalState: session.state, totalLatencyMs: Date.now() - turnStart });
  return finalText;
}

async function executeTool(
  name: ToolName,
  callId: string,
  args: unknown,
  ctx: ToolContext,
  transition: (s: AgentState) => void
): Promise<void> {
  const t0 = Date.now();
  try {
    const result = await getHandler(name)(args, ctx);
    ctx.bus.emit({ type: "tool_result", tool: name, callId, latencyMs: Date.now() - t0, ok: result.ok, preview: result.preview });
    pushToolResult(ctx.session, callId, name, result.data);

    // AUTH success unlocks triage.
    if (name === "verify_supporter_identity" && result.ok) transition("TRIAGE_READY");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.bus.emit({ type: "tool_result", tool: name, callId, latencyMs: Date.now() - t0, ok: false, preview: `error: ${message}` });
    pushToolResult(ctx.session, callId, name, { error: message });
  }
}

function pushToolResult(session: SessionContext, callId: string, name: string, data: unknown): void {
  session.history.push({ role: "tool", tool_call_id: callId, name, content: JSON.stringify(data) });
}

/**
 * Lightweight confirm/deny detector for the deterministic release step. Deny is
 * checked first so "no, don't" never reads as a confirm. Anything ambiguous
 * returns "unclear" and is handed to the model. (A production system would back
 * this with a tiny intent classifier; the regex is sufficient and auditable here.)
 */
function classifyConfirmation(text: string): "confirm" | "deny" | "unclear" {
  const t = text.toLowerCase();
  if (/\b(no|nope|don'?t|do not|stop|cancel that|abort|nevermind|never mind|changed my mind|not now)\b/.test(t)) return "deny";
  if (/\b(yes|yeah|yep|yup|confirm|confirmed|go ahead|proceed|do it|please do|sounds good|that'?s right|correct|ok|okay|sure)\b/.test(t)) return "confirm";
  return "unclear";
}
