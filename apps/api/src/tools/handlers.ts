import { MockDatabase } from "../db/mockDb.js";
import { HybridRetriever } from "../rag/retriever.js";
import { TelemetryBus } from "../agent/telemetry.js";
import type { SessionContext } from "../agent/stateMachine.js";
import {
  VerifySupporterIdentitySchema,
  GetSupporterContextSchema,
  SearchPolicySchema,
  GetMatchStatusSchema,
  SearchAvailableMatchesSchema,
  TransferTicketSchema,
  ManageSubscriptionSchema,
  BookMatchTicketSchema,
  UpgradeTicketSchema,
  EscalateSchema,
  type ToolName,
} from "./schemas.js";

export interface ToolContext {
  db: MockDatabase;
  session: SessionContext;
  retriever: HybridRetriever;
  bus: TelemetryBus;
}

export interface ToolExecResult {
  ok: boolean;
  data: unknown;
  /** Short human-readable line for the FDE Inspector tool_result event. */
  preview: string;
}

const HOURS = 60 * 60 * 1000;

type Handler = (args: unknown, ctx: ToolContext) => Promise<ToolExecResult>;

const handlers: Record<ToolName, Handler> = {
  verify_supporter_identity: async (raw, { db, session }) => {
    const { supporter_id, verification_pin } = VerifySupporterIdentitySchema.parse(raw);
    const s = await db.getSupporter(supporter_id);
    if (!s || s.verificationPin !== verification_pin) {
      return { ok: false, data: { verified: false }, preview: "identity verification failed" };
    }
    session.authenticated = true;
    session.supporterId = s.id;
    return { ok: true, data: { verified: true, name: s.name, tier: s.tier }, preview: `verified ${s.name} (${s.tier})` };
  },

  get_supporter_context: async (raw, { db }) => {
    const { supporter_id } = GetSupporterContextSchema.parse(raw);
    const s = await db.getSupporter(supporter_id);
    if (!s) return { ok: false, data: { found: false }, preview: "supporter not found" };
    const club = await db.getClub(s.favoriteClubId);
    const tickets = await db.getTicketsByOwner(s.id);
    const subs = await db.getSubscriptionsByOwner(s.id);
    const ticketViews = await Promise.all(
      tickets.map(async (t) => {
        const m = await db.getMatch(t.matchId);
        const hoursToKickoff = m ? (m.kickoffEpochMs - db.now) / HOURS : null;
        return {
          ticket_id: t.id,
          match: m ? `${m.round} @ ${m.venueCode}` : t.matchId,
          seat: t.seat,
          status: t.status,
          is_hospitality: t.isHospitality,
          transfer_count: t.transferCount,
          hours_to_kickoff: hoursToKickoff === null ? null : Number(hoursToKickoff.toFixed(1)),
        };
      })
    );
    return {
      ok: true,
      data: {
        supporter_id: s.id,
        name: s.name,
        tier: s.tier,
        favorite_club: club ? { name: club.name, is_eliminated: club.isEliminated } : null,
        tickets: ticketViews,
        subscriptions: subs.map((sub) => ({
          subscription_id: sub.id,
          plan: sub.plan,
          price_eur_per_month: sub.priceEurPerMonth,
          status: sub.status,
          tenure_months: sub.tenureMonths,
          retention_used_this_season: sub.hasUsedRetentionThisSeason,
        })),
      },
      preview: `${s.name}: ${ticketViews.length} ticket(s), ${subs.length} sub(s), club eliminated=${club?.isEliminated}`,
    };
  },

  search_stadium_and_ticket_policy: async (raw, { retriever, bus }) => {
    const { query, venue_code } = SearchPolicySchema.parse(raw);
    const t0 = Date.now();
    const results = await retriever.search(query, venue_code);
    const latencyMs = Date.now() - t0;
    bus.emit({
      type: "rag_retrieval",
      query,
      venue: venue_code,
      latencyMs,
      chunks: results.map((r) => ({ docId: r.docId, heading: r.heading, score: r.score })),
    });
    return {
      ok: true,
      data: { results: results.map((r) => ({ source: `${r.docId}#${r.heading}`, content: r.text })) },
      preview: results.length ? `${results.length} policy chunk(s): ${results.map((r) => r.heading).join(", ")}` : "no matching policy",
    };
  },

  get_match_status: async (raw, { db }) => {
    const { match_id } = GetMatchStatusSchema.parse(raw);
    const m = await db.getMatch(match_id);
    if (!m) return { ok: false, data: { found: false }, preview: "match not found" };
    const [home, away] = await Promise.all([db.getClub(m.homeClubId), db.getClub(m.awayClubId)]);
    const hoursToKickoff = (m.kickoffEpochMs - db.now) / HOURS;
    return {
      ok: true,
      data: {
        match_id: m.id,
        round: m.round,
        venue_code: m.venueCode,
        fixture: `${home?.name ?? m.homeClubId} vs ${away?.name ?? m.awayClubId}`,
        hours_to_kickoff: Number(hoursToKickoff.toFixed(1)),
        kickoff_iso: new Date(m.kickoffEpochMs).toISOString(),
      },
      preview: `${m.round}: ${hoursToKickoff.toFixed(1)}h to kickoff`,
    };
  },

  search_available_matches: async (raw, { db }) => {
    const { venue_code } = SearchAvailableMatchesSchema.parse(raw);
    const matches = await db.getMatches();
    const rows = await Promise.all(
      matches
        .filter((m) => venue_code === "ANY" || m.venueCode === venue_code)
        .filter((m) => (m.kickoffEpochMs - db.now) / HOURS >= 1) // bookable only
        .map(async (m) => {
          const [home, away] = await Promise.all([db.getClub(m.homeClubId), db.getClub(m.awayClubId)]);
          return {
            match_id: m.id,
            round: m.round,
            venue_code: m.venueCode,
            fixture: `${home?.name ?? m.homeClubId} vs ${away?.name ?? m.awayClubId}`,
            days_to_kickoff: Number(((m.kickoffEpochMs - db.now) / (24 * HOURS)).toFixed(1)),
            categories: (["GENERAL", "CATEGORY_1", "HOSPITALITY"] as const).map((cat) => ({
              category: cat,
              price_eur: m.prices[cat],
              available: m.availability[cat],
              sold_out: m.availability[cat] <= 0,
            })),
          };
        })
    );
    return { ok: true, data: { matches: rows }, preview: `${rows.length} bookable fixture(s)` };
  },

  // ── WRITE handlers: only reached AFTER the guardrail gate returns allowed ──
  transfer_match_ticket: async (raw, { db }) => {
    const { ticket_id, recipient_email } = TransferTicketSchema.parse(raw);
    const t = await db.transferTicket(ticket_id, recipient_email);
    return { ok: true, data: { transferred: true, ticket_id: t.id, recipient: recipient_email }, preview: `transferred ${t.id} → ${recipient_email}` };
  },

  book_match_ticket: async (raw, { db, session }) => {
    const { match_id, category } = BookMatchTicketSchema.parse(raw);
    const t = await db.bookTicket(session.supporterId!, match_id, category);
    const m = await db.getMatch(match_id);
    const price = m ? m.prices[category] : 0;
    return {
      ok: true,
      data: { booked: true, ticket_id: t.id, match_id, category, seat: t.seat, price_eur: price },
      preview: `booked ${t.id} (${category}) for ${match_id} €${price}`,
    };
  },

  upgrade_ticket_to_hospitality: async (raw, { db }) => {
    const { ticket_id } = UpgradeTicketSchema.parse(raw);
    const before = await db.getTicket(ticket_id);
    const m = before ? await db.getMatch(before.matchId) : undefined;
    const fee = m ? Math.max(0, m.prices.HOSPITALITY - m.prices.GENERAL) : 0;
    const t = await db.upgradeTicketToHospitality(ticket_id);
    return { ok: true, data: { upgraded: true, ticket_id: t.id, seat: t.seat, upgrade_fee_eur: fee }, preview: `upgraded ${t.id} → hospitality (€${fee})` };
  },

  manage_subscription_retention: async (raw, { db }) => {
    const { subscription_id, action } = ManageSubscriptionSchema.parse(raw);
    let result;
    if (action === "PAUSE_UNTIL_NEXT_SEASON") result = await db.pauseSubscription(subscription_id, db.now + 120 * 24 * HOURS);
    else if (action === "APPLY_ELIMINATION_DISCOUNT_50") result = await db.applyDiscount(subscription_id, 50);
    else result = await db.cancelSubscription(subscription_id);
    return { ok: true, data: { action, status: result.status, new_price_eur: result.priceEurPerMonth }, preview: `${action} → ${result.status}` };
  },

  escalate_to_stadium_ops: async (raw, { db, bus }) => {
    const { supporter_id, urgency, structured_summary } = EscalateSchema.parse(raw);
    const esc = await db.createEscalation({ supporterId: supporter_id, urgency, summary: structured_summary });
    bus.emit({ type: "escalation", escalationId: esc.id, urgency });
    return { ok: true, data: { escalation_id: esc.id, urgency, queued: true }, preview: `escalated ${esc.id} (${urgency})` };
  },
};

export function getHandler(name: ToolName): Handler {
  return handlers[name];
}
