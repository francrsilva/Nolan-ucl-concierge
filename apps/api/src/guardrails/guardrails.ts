import { MockDatabase } from "../db/mockDb.js";
import { SCHEMAS, type ToolName } from "../tools/schemas.js";
import type { SessionContext } from "../agent/stateMachine.js";
import { createHash } from "node:crypto";

/**
 * The Deterministic Guardrail Gate.
 *
 * Every WRITE tool call is intercepted here BEFORE execution. Business rules are
 * checked in plain TypeScript against live DB state — the LLM is never trusted to
 * do date math, verify ownership, or decide eligibility. A blocked call returns a
 * structured error that is fed back to the model so it can explain the rule and
 * offer a legitimate alternative (defense-in-depth, not a dead end).
 */

export type GuardrailResult =
  | { allowed: true }
  | {
      allowed: false;
      code: string;
      reason: string;
      /** Signals the model that a human handoff is the right next move. */
      suggestedEscalation?: boolean;
      /** For the two-turn lock: the impact summary to read back to the user. */
      confirmationSummary?: string;
    };

const HOURS = 60 * 60 * 1000;
const TRANSFER_CUTOFF_HOURS = 3;

function actionHash(tool: ToolName, keyParts: string[]): string {
  return createHash("sha256").update([tool, ...keyParts].join("|")).digest("hex").slice(0, 16);
}

export async function evaluateToolGuardrails(
  tool: ToolName,
  rawArgs: unknown,
  session: SessionContext,
  db: MockDatabase
): Promise<GuardrailResult> {
  // Structural precondition: identity must be verified before any gated tool.
  if (!session.authenticated || !session.supporterId) {
    return { allowed: false, code: "UNAUTHENTICATED", reason: "Supporter identity must be verified before this action." };
  }

  switch (tool) {
    case "transfer_match_ticket":
      return guardTransfer(rawArgs, session, db);
    case "manage_subscription_retention":
      return guardSubscription(rawArgs, session, db);
    case "book_match_ticket":
      return guardBooking(rawArgs, session, db);
    case "upgrade_ticket_to_hospitality":
      return guardUpgrade(rawArgs, session, db);
    case "escalate_to_stadium_ops":
      // Escalation is the safety escape hatch: schema-validated, no confirm lock.
      return SCHEMAS.escalate_to_stadium_ops.safeParse(rawArgs).success
        ? { allowed: true }
        : { allowed: false, code: "INVALID_SCHEMA", reason: "Escalation requires supporter_id, urgency and a structured_summary." };
    default:
      // READ / AUTH tools are not gated here.
      return { allowed: true };
  }
}

async function guardTransfer(rawArgs: unknown, session: SessionContext, db: MockDatabase): Promise<GuardrailResult> {
  const parsed = SCHEMAS.transfer_match_ticket.safeParse(rawArgs);
  if (!parsed.success) return { allowed: false, code: "INVALID_SCHEMA", reason: parsed.error.message };
  const { ticket_id, recipient_email, user_confirmed } = parsed.data;

  const ticket = await db.getTicket(ticket_id);
  if (!ticket || ticket.ownerId !== session.supporterId) {
    return { allowed: false, code: "OWNERSHIP_MISMATCH", reason: "That ticket does not belong to the verified supporter." };
  }
  if (ticket.status !== "ACTIVE") {
    return { allowed: false, code: "TICKET_NOT_ACTIVE", reason: `Ticket status is ${ticket.status}; only ACTIVE tickets can be transferred.` };
  }

  // Rule 1 — 3-hour kickoff cutoff (live date math, never from the LLM).
  const match = await db.getMatch(ticket.matchId);
  if (!match) return { allowed: false, code: "MATCH_NOT_FOUND", reason: "Could not resolve the match for this ticket." };
  const hoursUntilKickoff = (match.kickoffEpochMs - db.now) / HOURS;
  if (hoursUntilKickoff < TRANSFER_CUTOFF_HOURS) {
    return {
      allowed: false,
      code: "POLICY_CUTOFF_VIOLATION",
      reason: `Transfers close ${TRANSFER_CUTOFF_HOURS}h before kickoff (${hoursUntilKickoff.toFixed(1)}h remaining). Offer stadium box-office escalation instead.`,
      suggestedEscalation: true,
    };
  }

  // Rule 2 — anti-scalping: at most one transfer per ticket.
  if (ticket.transferCount >= 1) {
    return { allowed: false, code: "MAX_TRANSFERS_REACHED", reason: "Anti-scalping policy permits only one transfer per ticket." };
  }

  // Rule 3 — two-turn confirmation lock.
  const hash = actionHash("transfer_match_ticket", [ticket_id, recipient_email]);
  const summary = `Transfer ticket ${ticket_id} (${ticket.seat}) for ${match.round} to ${recipient_email}. This is irreversible.`;
  const locked = !user_confirmed || session.pendingAction?.hash !== hash;
  if (locked) {
    session.pendingAction = { tool: "transfer_match_ticket", hash, summary, args: parsed.data };
    return { allowed: false, code: "CONFIRMATION_REQUIRED", reason: "Read back the impact and get explicit confirmation before retrying.", confirmationSummary: summary };
  }
  return { allowed: true };
}

async function guardSubscription(rawArgs: unknown, session: SessionContext, db: MockDatabase): Promise<GuardrailResult> {
  const parsed = SCHEMAS.manage_subscription_retention.safeParse(rawArgs);
  if (!parsed.success) return { allowed: false, code: "INVALID_SCHEMA", reason: parsed.error.message };
  const { subscription_id, action, user_confirmed } = parsed.data;

  const sub = await db.getSubscription(subscription_id);
  if (!sub || sub.ownerId !== session.supporterId) {
    return { allowed: false, code: "OWNERSHIP_MISMATCH", reason: "That subscription does not belong to the verified supporter." };
  }
  if (sub.status === "CANCELLED") {
    return { allowed: false, code: "ALREADY_CANCELLED", reason: "Subscription is already cancelled." };
  }

  // Retention-offer eligibility: only gate the OFFERS, never the user's hard CANCEL.
  if (action === "PAUSE_UNTIL_NEXT_SEASON" || action === "APPLY_ELIMINATION_DISCOUNT_50") {
    const supporter = await db.getSupporter(session.supporterId);
    const club = supporter ? await db.getClub(supporter.favoriteClubId) : undefined;
    const eligible = club?.isEliminated === true && sub.tenureMonths >= 2 && !sub.hasUsedRetentionThisSeason;
    if (!eligible) {
      return {
        allowed: false,
        code: "RETENTION_NOT_ELIGIBLE",
        reason:
          "Retention offer not available (requires the supporter's club eliminated, tenure ≥ 2 months, and no retention used this season). Proceed with the cancellation the supporter asked for.",
      };
    }
  }

  // Two-turn confirmation lock on every subscription mutation.
  const hash = actionHash("manage_subscription_retention", [subscription_id, action]);
  const summary = summariseSubAction(action, sub.priceEurPerMonth, db.now);
  const locked = !user_confirmed || session.pendingAction?.hash !== hash;
  if (locked) {
    session.pendingAction = { tool: "manage_subscription_retention", hash, summary, args: parsed.data };
    return { allowed: false, code: "CONFIRMATION_REQUIRED", reason: "Read back the impact and get explicit confirmation before retrying.", confirmationSummary: summary };
  }
  return { allowed: true };
}

async function guardBooking(rawArgs: unknown, session: SessionContext, db: MockDatabase): Promise<GuardrailResult> {
  const parsed = SCHEMAS.book_match_ticket.safeParse(rawArgs);
  if (!parsed.success) return { allowed: false, code: "INVALID_SCHEMA", reason: parsed.error.message };
  const { match_id, category, user_confirmed } = parsed.data;

  const match = await db.getMatch(match_id);
  if (!match) return { allowed: false, code: "MATCH_NOT_FOUND", reason: `No match ${match_id} exists.` };

  const hoursUntilKickoff = (match.kickoffEpochMs - db.now) / HOURS;
  if (hoursUntilKickoff < 1) {
    return { allowed: false, code: "BOOKING_CLOSED", reason: `Online booking closes 1h before kickoff (${hoursUntilKickoff.toFixed(1)}h remaining).`, suggestedEscalation: true };
  }
  if (match.availability[category] <= 0) {
    return { allowed: false, code: "CATEGORY_SOLD_OUT", reason: `${category} tickets for this fixture are sold out. Offer another category with availability instead.` };
  }
  const dup = (await db.getTicketsByOwner(session.supporterId!)).find((t) => t.matchId === match_id && t.status === "ACTIVE");
  if (dup) return { allowed: false, code: "ALREADY_HAS_TICKET", reason: `The supporter already holds an active ticket (${dup.id}) for this fixture.` };

  const hash = actionHash("book_match_ticket", [match_id, category]);
  const price = match.prices[category];
  const summary = `Book 1 ${category.replace(/_/g, " ")} ticket for ${match.round} at ${match.venueCode} for €${price.toFixed(2)}. Payment is taken immediately.`;
  const locked = !user_confirmed || session.pendingAction?.hash !== hash;
  if (locked) {
    session.pendingAction = { tool: "book_match_ticket", hash, summary, args: parsed.data };
    return { allowed: false, code: "CONFIRMATION_REQUIRED", reason: "Read back the price and get explicit confirmation before retrying.", confirmationSummary: summary };
  }
  return { allowed: true };
}

async function guardUpgrade(rawArgs: unknown, session: SessionContext, db: MockDatabase): Promise<GuardrailResult> {
  const parsed = SCHEMAS.upgrade_ticket_to_hospitality.safeParse(rawArgs);
  if (!parsed.success) return { allowed: false, code: "INVALID_SCHEMA", reason: parsed.error.message };
  const { ticket_id, user_confirmed } = parsed.data;

  const ticket = await db.getTicket(ticket_id);
  if (!ticket || ticket.ownerId !== session.supporterId) {
    return { allowed: false, code: "OWNERSHIP_MISMATCH", reason: "That ticket does not belong to the verified supporter." };
  }
  if (ticket.status !== "ACTIVE") return { allowed: false, code: "TICKET_NOT_ACTIVE", reason: `Ticket status is ${ticket.status}; only ACTIVE tickets can be upgraded.` };
  if (ticket.isHospitality) return { allowed: false, code: "ALREADY_HOSPITALITY", reason: "That ticket is already a VIP hospitality seat." };

  const match = await db.getMatch(ticket.matchId);
  if (!match) return { allowed: false, code: "MATCH_NOT_FOUND", reason: "Could not resolve the match for this ticket." };
  const hoursUntilKickoff = (match.kickoffEpochMs - db.now) / HOURS;
  if (hoursUntilKickoff < TRANSFER_CUTOFF_HOURS) {
    return { allowed: false, code: "POLICY_CUTOFF_VIOLATION", reason: `Hospitality upgrades close ${TRANSFER_CUTOFF_HOURS}h before kickoff (${hoursUntilKickoff.toFixed(1)}h remaining).`, suggestedEscalation: true };
  }
  if (match.availability.HOSPITALITY <= 0) return { allowed: false, code: "HOSPITALITY_SOLD_OUT", reason: "No hospitality inventory remaining for this fixture." };

  const fee = Math.max(0, match.prices.HOSPITALITY - match.prices.GENERAL);
  const hash = actionHash("upgrade_ticket_to_hospitality", [ticket_id]);
  const summary = `Upgrade ticket ${ticket_id} for ${match.round} to VIP hospitality for an additional €${fee.toFixed(2)}.`;
  const locked = !user_confirmed || session.pendingAction?.hash !== hash;
  if (locked) {
    session.pendingAction = { tool: "upgrade_ticket_to_hospitality", hash, summary, args: parsed.data };
    return { allowed: false, code: "CONFIRMATION_REQUIRED", reason: "Read back the fee and get explicit confirmation before retrying.", confirmationSummary: summary };
  }
  return { allowed: true };
}

function summariseSubAction(action: string, priceEur: number, now: number): string {
  const nextSeason = new Date(now + 120 * 24 * HOURS).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  switch (action) {
    case "PAUSE_UNTIL_NEXT_SEASON":
      return `Pause your €${priceEur.toFixed(2)}/mo UEFA Pass until next season (~${nextSeason}). No charges while paused.`;
    case "APPLY_ELIMINATION_DISCOUNT_50":
      return `Apply a 50% loyalty discount, taking your UEFA Pass to €${(priceEur / 2).toFixed(2)}/mo.`;
    case "CANCEL_IMMEDIATELY":
      return `Cancel your €${priceEur.toFixed(2)}/mo UEFA Pass immediately. You will lose access at the end of the current period.`;
    default:
      return "Modify your UEFA Pass subscription.";
  }
}
