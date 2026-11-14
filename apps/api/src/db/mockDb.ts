/**
 * In-memory mock of the production datastore (Postgres + ticket ledger).
 *
 * Every agent session gets its OWN cloned instance via `createSeededDatabase()`
 * so that eval cases and concurrent chats never bleed mutations into each other.
 * All reads/writes are async to faithfully mirror real network-backed IO — the
 * guardrail layer is written to always validate against *live* DB state, never
 * against values the LLM supplied.
 */

export type SupporterTier = "PLATINUM" | "GOLD" | "STANDARD";
export type TicketStatus = "ACTIVE" | "TRANSFERRED" | "USED" | "VOID";
export type SubscriptionStatus = "ACTIVE" | "PAUSED" | "CANCELLED";
export type VenueCode = "MUN" | "MAD" | "LON" | "PAR" | "MIL";
export type TicketCategory = "GENERAL" | "CATEGORY_1" | "HOSPITALITY";

export const TICKET_CATEGORIES: TicketCategory[] = ["GENERAL", "CATEGORY_1", "HOSPITALITY"];

export interface Club {
  id: string;
  name: string;
  /** True once the club is knocked out of the competition this season. */
  isEliminated: boolean;
}

export interface Match {
  id: string;
  homeClubId: string;
  awayClubId: string;
  venueCode: VenueCode;
  round: string;
  kickoffEpochMs: number;
  /** Price per category (EUR). */
  prices: Record<TicketCategory, number>;
  /** Remaining inventory per category. 0 = sold out. */
  availability: Record<TicketCategory, number>;
}

export interface Ticket {
  id: string;
  ownerId: string;
  matchId: string;
  seat: string;
  status: TicketStatus;
  transferCount: number;
  isHospitality: boolean;
}

export interface Subscription {
  id: string;
  ownerId: string;
  plan: string;
  priceEurPerMonth: number;
  status: SubscriptionStatus;
  tenureMonths: number;
  hasUsedRetentionThisSeason: boolean;
  /** When a PAUSE lands, we record the resume date here for the summary. */
  pausedUntilEpochMs: number | null;
}

export interface Supporter {
  id: string;
  name: string;
  email: string;
  tier: SupporterTier;
  favoriteClubId: string;
  /** Last 4 digits used for the lightweight identity check in this demo. */
  verificationPin: string;
}

export interface EscalationTicket {
  id: string;
  supporterId: string;
  urgency: string;
  summary: string;
  createdAtEpochMs: number;
}

interface Collections {
  clubs: Map<string, Club>;
  matches: Map<string, Match>;
  tickets: Map<string, Ticket>;
  subscriptions: Map<string, Subscription>;
  supporters: Map<string, Supporter>;
  escalations: EscalationTicket[];
}

const HOURS = 60 * 60 * 1000;

/**
 * Seed data is expressed relative to a `now` baseline so match kickoff windows
 * behave deterministically regardless of when the suite runs. One match is
 * intentionally < 3h away to exercise the transfer-cutoff guardrail.
 */
function buildSeed(now: number): Collections {
  const clubs: Club[] = [
    { id: "CLB-RMA", name: "Real Madrid", isEliminated: false },
    { id: "CLB-BAY", name: "Bayern München", isEliminated: false },
    { id: "CLB-ARS", name: "Arsenal", isEliminated: true }, // knocked out → retention-eligible
    { id: "CLB-PSG", name: "Paris Saint-Germain", isEliminated: false },
    { id: "CLB-INT", name: "Inter Milan", isEliminated: false },
  ];

  const matches: Match[] = [
    {
      id: "MTC-SF1",
      homeClubId: "CLB-BAY",
      awayClubId: "CLB-RMA",
      venueCode: "MUN",
      round: "Semi-Final 1st Leg",
      kickoffEpochMs: now + 1.75 * HOURS, // < 3h → transfer window CLOSED, booking closed
      prices: { GENERAL: 90, CATEGORY_1: 180, HOSPITALITY: 650 },
      availability: { GENERAL: 0, CATEGORY_1: 0, HOSPITALITY: 2 },
    },
    {
      id: "MTC-SF2",
      homeClubId: "CLB-RMA",
      awayClubId: "CLB-BAY",
      venueCode: "MAD",
      round: "Semi-Final 2nd Leg",
      kickoffEpochMs: now + 8 * 24 * HOURS, // well in the future → transferable + bookable
      prices: { GENERAL: 95, CATEGORY_1: 190, HOSPITALITY: 700 },
      availability: { GENERAL: 120, CATEGORY_1: 40, HOSPITALITY: 0 }, // hospitality sold out
    },
    {
      id: "MTC-QF",
      homeClubId: "CLB-PSG",
      awayClubId: "CLB-INT",
      venueCode: "PAR",
      round: "Quarter-Final 2nd Leg",
      kickoffEpochMs: now + 30 * HOURS,
      prices: { GENERAL: 80, CATEGORY_1: 160, HOSPITALITY: 600 },
      availability: { GENERAL: 300, CATEGORY_1: 75, HOSPITALITY: 12 },
    },
    {
      id: "MTC-FINAL",
      homeClubId: "CLB-RMA",
      awayClubId: "CLB-PSG",
      venueCode: "LON",
      round: "Final",
      kickoffEpochMs: now + 40 * 24 * HOURS, // showcase booking a marquee fixture
      prices: { GENERAL: 180, CATEGORY_1: 450, HOSPITALITY: 2400 },
      availability: { GENERAL: 60, CATEGORY_1: 20, HOSPITALITY: 8 },
    },
  ];

  const tickets: Ticket[] = [
    // Owned by UEFA-88412 (Alex). Kickoff < 3h away → cutoff guardrail fires.
    { id: "TKT-90210", ownerId: "UEFA-88412", matchId: "MTC-SF1", seat: "VIP Box 12, Seat 4", status: "ACTIVE", transferCount: 0, isHospitality: true },
    // Owned by UEFA-88412, future match → transferable.
    { id: "TKT-90211", ownerId: "UEFA-88412", matchId: "MTC-SF2", seat: "Sector 114, Row 9, Seat 22", status: "ACTIVE", transferCount: 0, isHospitality: false },
    // Already transferred once → anti-scalping guardrail fires on a 2nd attempt.
    { id: "TKT-77001", ownerId: "UEFA-20099", matchId: "MTC-QF", seat: "Sector 203, Row 2, Seat 10", status: "ACTIVE", transferCount: 1, isHospitality: false },
  ];

  const subscriptions: Subscription[] = [
    // Alex: Arsenal fan, Arsenal eliminated, tenure 14m, retention unused → eligible.
    { id: "SUB-5001", ownerId: "UEFA-88412", plan: "UEFA Champions League Pass", priceEurPerMonth: 19.99, status: "ACTIVE", tenureMonths: 14, hasUsedRetentionThisSeason: false, pausedUntilEpochMs: null },
    // Jordan: tenure 1m (too new for retention) → retention guardrail blocks the offer.
    { id: "SUB-5002", ownerId: "UEFA-20099", plan: "UEFA Champions League Pass", priceEurPerMonth: 19.99, status: "ACTIVE", tenureMonths: 1, hasUsedRetentionThisSeason: false, pausedUntilEpochMs: null },
  ];

  const supporters: Supporter[] = [
    { id: "UEFA-88412", name: "Alex Rivera", email: "alex.rivera@example.com", tier: "PLATINUM", favoriteClubId: "CLB-ARS", verificationPin: "4417" },
    { id: "UEFA-20099", name: "Jordan Kim", email: "jordan.kim@example.com", tier: "STANDARD", favoriteClubId: "CLB-INT", verificationPin: "9921" },
  ];

  return {
    clubs: new Map(clubs.map((c) => [c.id, c])),
    matches: new Map(matches.map((m) => [m.id, m])),
    tickets: new Map(tickets.map((t) => [t.id, t])),
    subscriptions: new Map(subscriptions.map((s) => [s.id, s])),
    supporters: new Map(supporters.map((s) => [s.id, s])),
    escalations: [],
  };
}

export class MockDatabase {
  private c: Collections;
  private ticketSeq = 90300;
  /** Fixed per-instance clock so kickoff math is reproducible across a session. */
  readonly now: number;

  constructor(now = Date.now()) {
    this.now = now;
    this.c = buildSeed(now);
  }

  // ── Reads ──────────────────────────────────────────────────
  async getSupporter(id: string): Promise<Supporter | undefined> {
    return this.c.supporters.get(id);
  }
  async getClub(id: string): Promise<Club | undefined> {
    return this.c.clubs.get(id);
  }
  async getMatch(id: string): Promise<Match | undefined> {
    return this.c.matches.get(id);
  }
  async getMatches(): Promise<Match[]> {
    return [...this.c.matches.values()].sort((a, b) => a.kickoffEpochMs - b.kickoffEpochMs);
  }
  async getTicket(id: string): Promise<Ticket | undefined> {
    return this.c.tickets.get(id);
  }
  async getTicketsByOwner(ownerId: string): Promise<Ticket[]> {
    return [...this.c.tickets.values()].filter((t) => t.ownerId === ownerId);
  }
  async getSubscription(id: string): Promise<Subscription | undefined> {
    return this.c.subscriptions.get(id);
  }
  async getSubscriptionsByOwner(ownerId: string): Promise<Subscription[]> {
    return [...this.c.subscriptions.values()].filter((s) => s.ownerId === ownerId);
  }

  // ── Mutations (only ever reached after the guardrail gate passes) ──
  async bookTicket(supporterId: string, matchId: string, category: TicketCategory): Promise<Ticket> {
    const m = this.c.matches.get(matchId);
    if (!m) throw new Error(`Match ${matchId} not found`);
    if (m.availability[category] <= 0) throw new Error(`No ${category} inventory for ${matchId}`);
    m.availability[category] -= 1;
    const id = `TKT-${this.ticketSeq++}`;
    const seat = seatFor(category, id);
    const ticket: Ticket = { id, ownerId: supporterId, matchId, seat, status: "ACTIVE", transferCount: 0, isHospitality: category === "HOSPITALITY" };
    this.c.tickets.set(id, ticket);
    return { ...ticket };
  }

  async upgradeTicketToHospitality(ticketId: string): Promise<Ticket> {
    const t = this.c.tickets.get(ticketId);
    if (!t) throw new Error(`Ticket ${ticketId} not found`);
    const m = this.c.matches.get(t.matchId);
    if (!m || m.availability.HOSPITALITY <= 0) throw new Error("No hospitality inventory");
    m.availability.HOSPITALITY -= 1;
    t.isHospitality = true;
    t.seat = seatFor("HOSPITALITY", t.id);
    return { ...t };
  }

  async transferTicket(ticketId: string, recipientEmail: string): Promise<Ticket> {
    const t = this.c.tickets.get(ticketId);
    if (!t) throw new Error(`Ticket ${ticketId} not found`);
    t.status = "TRANSFERRED";
    t.transferCount += 1;
    t.ownerId = `pending:${recipientEmail}`;
    return { ...t };
  }

  async pauseSubscription(subscriptionId: string, resumeEpochMs: number): Promise<Subscription> {
    const s = this.requireSub(subscriptionId);
    s.status = "PAUSED";
    s.pausedUntilEpochMs = resumeEpochMs;
    s.hasUsedRetentionThisSeason = true;
    return { ...s };
  }

  async applyDiscount(subscriptionId: string, pct: number): Promise<Subscription> {
    const s = this.requireSub(subscriptionId);
    s.priceEurPerMonth = Math.round(s.priceEurPerMonth * (1 - pct / 100) * 100) / 100;
    s.hasUsedRetentionThisSeason = true;
    return { ...s };
  }

  async cancelSubscription(subscriptionId: string): Promise<Subscription> {
    const s = this.requireSub(subscriptionId);
    s.status = "CANCELLED";
    return { ...s };
  }

  async createEscalation(e: Omit<EscalationTicket, "id" | "createdAtEpochMs">): Promise<EscalationTicket> {
    const ticket: EscalationTicket = {
      ...e,
      id: `ESC-${(this.c.escalations.length + 1).toString().padStart(4, "0")}`,
      createdAtEpochMs: this.now,
    };
    this.c.escalations.push(ticket);
    return { ...ticket };
  }

  private requireSub(id: string): Subscription {
    const s = this.c.subscriptions.get(id);
    if (!s) throw new Error(`Subscription ${id} not found`);
    return s;
  }
}

function seatFor(category: TicketCategory, id: string): string {
  const n = (parseInt(id.replace(/\D/g, ""), 10) % 40) + 1;
  switch (category) {
    case "HOSPITALITY":
      return `VIP Box ${(n % 20) + 1}, Seat ${(n % 6) + 1}`;
    case "CATEGORY_1":
      return `Cat-1 Sector 112, Row ${(n % 20) + 1}, Seat ${n}`;
    default:
      return `Sector ${200 + (n % 40)}, Row ${(n % 25) + 1}, Seat ${n}`;
  }
}

export function createSeededDatabase(now?: number): MockDatabase {
  return new MockDatabase(now);
}
