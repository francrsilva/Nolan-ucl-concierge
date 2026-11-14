import type { ToolName } from "../tools/schemas.js";

/**
 * Explicit conversation state tracked OUTSIDE the LLM context window. The LLM is
 * only ever offered the subset of tools legal in the current state — a hard
 * structural guardrail that complements the per-call deterministic checks.
 */
export type AgentState =
  | "AUTHENTICATING"
  | "TRIAGE_READY"
  | "AWAITING_CONFIRMATION"
  | "EXECUTING_MUTATION"
  | "ESCALATION_PREP"
  | "HUMAN_HANDOFF";

export interface PendingAction {
  tool: ToolName;
  /** Deterministic hash of the exact action; the confirm turn must match it. */
  hash: string;
  /** Plain-language impact summary the agent presented for confirmation. */
  summary: string;
  /** The validated arguments, so the orchestrator can execute on confirmation. */
  args: unknown;
}

export interface SessionContext {
  sessionId: string;
  state: AgentState;
  authenticated: boolean;
  supporterId: string | null;
  pendingAction: PendingAction | null;
  /** OpenAI chat message history (typed loosely to avoid SDK coupling here). */
  history: ChatMessage[];
  createdAt: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

const READ_TOOLS: ToolName[] = ["get_supporter_context", "search_stadium_and_ticket_policy", "get_match_status", "search_available_matches"];
const WRITE_TOOLS: ToolName[] = ["transfer_match_ticket", "manage_subscription_retention", "book_match_ticket", "upgrade_ticket_to_hospitality"];
const ALWAYS_AVAILABLE: ToolName[] = ["escalate_to_stadium_ops"];

/** Which tools the LLM is permitted to see/call in a given state. */
export function allowedTools(state: AgentState): ToolName[] {
  switch (state) {
    case "AUTHENTICATING":
      return ["verify_supporter_identity"];
    case "TRIAGE_READY":
    case "AWAITING_CONFIRMATION":
      // In both states the model may read freely and (re)propose writes; the
      // guardrail gate — not the tool list — enforces the confirmation lock.
      return [...READ_TOOLS, ...WRITE_TOOLS, ...ALWAYS_AVAILABLE];
    case "ESCALATION_PREP":
      return [...READ_TOOLS, ...ALWAYS_AVAILABLE];
    case "EXECUTING_MUTATION":
    case "HUMAN_HANDOFF":
      return [];
    default:
      return [];
  }
}

export function createSession(sessionId: string, now = Date.now()): SessionContext {
  return {
    sessionId,
    state: "AUTHENTICATING",
    authenticated: false,
    supporterId: null,
    pendingAction: null,
    history: [],
    createdAt: now,
  };
}
