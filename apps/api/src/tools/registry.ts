import { jsonSchemaFor, type ToolName } from "./schemas.js";

/**
 * Two-tier tool classification (the core trust model).
 *
 *  - AUTH  : establishes identity; auto-executes; no business guardrails.
 *  - READ  : zero side effects; auto-executes; safe to run without confirmation.
 *  - WRITE : mutates state; MUST pass the deterministic guardrail gate, and
 *            (unless `confirmationExempt`) requires a two-turn user confirmation.
 */
export type ToolKind = "AUTH" | "READ" | "WRITE";

export interface ToolSpec {
  name: ToolName;
  kind: ToolKind;
  description: string;
  /** READ/AUTH run immediately; WRITE is gated. */
  autoExecute: boolean;
  /** WRITE escape hatch (escalation) skips the confirmation lock. */
  confirmationExempt?: boolean;
}

export const TOOLS: Record<ToolName, ToolSpec> = {
  verify_supporter_identity: {
    name: "verify_supporter_identity",
    kind: "AUTH",
    autoExecute: true,
    description: "Verify the supporter's identity with their UEFA Supporter ID and 4-digit PIN. Must succeed before any account or ticket action.",
  },
  get_supporter_context: {
    name: "get_supporter_context",
    kind: "READ",
    autoExecute: true,
    description: "Retrieve the supporter's profile, tier, active match tickets, favourite-club elimination status, and UEFA Pass subscriptions.",
  },
  search_stadium_and_ticket_policy: {
    name: "search_stadium_and_ticket_policy",
    kind: "READ",
    autoExecute: true,
    description: "Hybrid RAG search over official UEFA stadium entry rules, prohibited items, hospitality terms, transfer rules and refund policy. Always ground policy answers with this.",
  },
  get_match_status: {
    name: "get_match_status",
    kind: "READ",
    autoExecute: true,
    description: "Look up a match's fixture, venue, round and exact hours until kickoff.",
  },
  search_available_matches: {
    name: "search_available_matches",
    kind: "READ",
    autoExecute: true,
    description: "List upcoming fixtures with ticket availability and prices per category (GENERAL, CATEGORY_1, HOSPITALITY). Use this before booking so you can quote real prices and availability.",
  },
  transfer_match_ticket: {
    name: "transfer_match_ticket",
    kind: "WRITE",
    autoExecute: false,
    description: "Transfer an active match ticket to another supporter. Blocked within 3h of kickoff, if already transferred once, or without explicit confirmation.",
  },
  manage_subscription_retention: {
    name: "manage_subscription_retention",
    kind: "WRITE",
    autoExecute: false,
    description: "Pause, apply a loyalty discount to, or cancel the supporter's UEFA Champions League Pass. Offers are eligibility-gated; an insisted cancellation is always honoured.",
  },
  book_match_ticket: {
    name: "book_match_ticket",
    kind: "WRITE",
    autoExecute: false,
    description: "Purchase a NEW ticket for a match in a given category. Blocked if the category is sold out, the supporter already holds a ticket for that match, bookings have closed (within 1h of kickoff), or without explicit confirmation of the price.",
  },
  upgrade_ticket_to_hospitality: {
    name: "upgrade_ticket_to_hospitality",
    kind: "WRITE",
    autoExecute: false,
    description: "Upgrade one of the supporter's existing active tickets to a VIP hospitality seat. Blocked if not owned, not active, already hospitality, hospitality sold out, within 3h of kickoff, or without explicit confirmation of the fee.",
  },
  escalate_to_stadium_ops: {
    name: "escalate_to_stadium_ops",
    kind: "WRITE",
    autoExecute: false,
    confirmationExempt: true,
    description: "Escalate an unresolved gate failure, suspected fraud, or out-of-policy exception to a live UEFA duty officer with a structured handoff packet.",
  },
};

export function toolKind(name: ToolName): ToolKind {
  return TOOLS[name].kind;
}

/** OpenAI tools array for the subset of tool names allowed in the current state. */
export function openAiToolsFor(names: ToolName[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return names.map((name) => ({
    type: "function",
    function: { name, description: TOOLS[name].description, parameters: jsonSchemaFor(name) },
  }));
}
