import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Tool argument schemas. Zod is the single source of truth: the same object
 * validates the model's raw arguments (guardrail layer) AND is projected to the
 * JSON Schema we advertise to the LLM. A required free-text `reasoning` field on
 * every tool improves tool-call accuracy and gives the FDE Inspector a clean,
 * human-readable "why" for each call.
 */

export const VENUE_CODES = ["MUN", "MAD", "LON", "PAR", "MIL", "GENERAL"] as const;

const reasoning = z
  .string()
  .min(1)
  .describe("One concise sentence: why you are calling this tool right now, in the user's terms.");

// ── AUTH ─────────────────────────────────────────────────────
export const VerifySupporterIdentitySchema = z.object({
  reasoning,
  supporter_id: z.string().describe("Unique UEFA Supporter ID (e.g., 'UEFA-88412')."),
  verification_pin: z.string().describe("4-digit identity PIN the supporter provides."),
});

// ── READ ─────────────────────────────────────────────────────
export const GetSupporterContextSchema = z.object({
  reasoning,
  supporter_id: z.string().describe("Unique UEFA Supporter ID (e.g., 'UEFA-88412')."),
});

export const SearchPolicySchema = z.object({
  reasoning,
  query: z.string().describe("Specific policy question or keywords (e.g., 'backpack dimensions gate C')."),
  venue_code: z.enum(VENUE_CODES).describe("3-letter venue code, or GENERAL for competition-wide rules."),
});

export const GetMatchStatusSchema = z.object({
  reasoning,
  match_id: z.string().describe("Match identifier (e.g., 'MTC-SF1')."),
});

export const SearchAvailableMatchesSchema = z.object({
  reasoning,
  venue_code: z.enum(["MUN", "MAD", "LON", "PAR", "MIL", "ANY"]).describe("Filter by venue, or ANY for all upcoming fixtures."),
});

// ── WRITE ────────────────────────────────────────────────────
export const BookMatchTicketSchema = z.object({
  reasoning,
  match_id: z.string().describe("The match to book a ticket for (e.g., 'MTC-FINAL')."),
  category: z.enum(["GENERAL", "CATEGORY_1", "HOSPITALITY"]).describe("Ticket category to purchase."),
  user_confirmed: z.boolean().describe("Set true ONLY after the supporter has confirmed the purchase and price in a prior turn."),
});

export const UpgradeTicketSchema = z.object({
  reasoning,
  ticket_id: z.string().describe("The existing active ticket to upgrade to hospitality (e.g., 'TKT-90211')."),
  user_confirmed: z.boolean().describe("Set true ONLY after the supporter has confirmed the upgrade and fee in a prior turn."),
});

export const TransferTicketSchema = z.object({
  reasoning,
  ticket_id: z.string().describe("The unique ticket identifier (e.g., 'TKT-90210')."),
  recipient_email: z.string().email().describe("Email of the recipient receiving the mobile pass."),
  transfer_reason: z.enum(["TRAVEL_DISRUPTION", "ILLNESS", "GIFT_TO_FAMILY", "OTHER"]),
  user_confirmed: z
    .boolean()
    .describe("Set true ONLY after the supporter has explicitly confirmed this irreversible transfer in a prior turn."),
});

export const ManageSubscriptionSchema = z.object({
  reasoning,
  subscription_id: z.string(),
  action: z
    .enum(["PAUSE_UNTIL_NEXT_SEASON", "APPLY_ELIMINATION_DISCOUNT_50", "CANCEL_IMMEDIATELY"])
    .describe(
      "Offer PAUSE or DISCOUNT only when the supporter is frustrated about elimination AND agrees. Use CANCEL_IMMEDIATELY if the supporter insists."
    ),
  cancellation_reason: z.enum(["CLUB_ELIMINATED", "TOO_EXPENSIVE", "TECHNICAL_ISSUES", "OTHER"]),
  user_confirmed: z.boolean(),
});

export const EscalateSchema = z.object({
  reasoning,
  supporter_id: z.string(),
  urgency: z.enum(["CRITICAL_AT_GATE", "HIGH_MATCHDAY", "STANDARD"]),
  structured_summary: z
    .string()
    .describe("Concise 3-bullet summary: the issue, policies already checked, and why automated resolution was blocked."),
});

export const SCHEMAS = {
  verify_supporter_identity: VerifySupporterIdentitySchema,
  get_supporter_context: GetSupporterContextSchema,
  search_stadium_and_ticket_policy: SearchPolicySchema,
  get_match_status: GetMatchStatusSchema,
  search_available_matches: SearchAvailableMatchesSchema,
  transfer_match_ticket: TransferTicketSchema,
  manage_subscription_retention: ManageSubscriptionSchema,
  book_match_ticket: BookMatchTicketSchema,
  upgrade_ticket_to_hospitality: UpgradeTicketSchema,
  escalate_to_stadium_ops: EscalateSchema,
} as const;

export type ToolName = keyof typeof SCHEMAS;

/** JSON Schema projection (strict) for the OpenAI tools array. */
export function jsonSchemaFor(name: ToolName): Record<string, unknown> {
  const schema = zodToJsonSchema(SCHEMAS[name], { target: "openApi3", $refStrategy: "none" });
  return schema as Record<string, unknown>;
}
