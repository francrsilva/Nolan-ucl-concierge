/**
 * Offline guardrail smoke test — NO LLM, NO network, runs in milliseconds.
 *
 *   npm run test:guardrails
 *
 * Proves the deterministic trust layer (the part that must NEVER depend on the
 * model) in isolation: ownership, 3h cutoff, anti-scalping, two-turn lock,
 * retention eligibility, and auth gating. This is the safety net the eval suite
 * sits on top of.
 */
import assert from "node:assert/strict";
import { createSeededDatabase } from "../apps/api/src/db/mockDb.js";
import { createSession, type SessionContext } from "../apps/api/src/agent/stateMachine.js";
import { evaluateToolGuardrails } from "../apps/api/src/guardrails/guardrails.js";

let pass = 0;
let fail = 0;
async function it(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`❌ ${name}\n   ${e instanceof Error ? e.message : e}`);
  }
}

function authed(db = createSeededDatabase(), supporterId = "UEFA-88412"): SessionContext {
  const s = createSession("smoke", db.now);
  s.authenticated = true;
  s.supporterId = supporterId;
  s.state = "TRIAGE_READY";
  return s;
}

const base = { reasoning: "test" };

await it("blocks any gated tool before authentication", async () => {
  const db = createSeededDatabase();
  const s = createSession("smoke", db.now);
  const r = await evaluateToolGuardrails("transfer_match_ticket", { ...base, ticket_id: "TKT-90211", recipient_email: "a@b.com", transfer_reason: "GIFT_TO_FAMILY", user_confirmed: true }, s, db);
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.code, "UNAUTHENTICATED");
});

await it("blocks transfer within 3h of kickoff (TKT-90210)", async () => {
  const db = createSeededDatabase();
  const s = authed(db);
  const r = await evaluateToolGuardrails("transfer_match_ticket", { ...base, ticket_id: "TKT-90210", recipient_email: "a@b.com", transfer_reason: "TRAVEL_DISRUPTION", user_confirmed: true }, s, db);
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.code, "POLICY_CUTOFF_VIOLATION");
});

await it("blocks a ticket not owned by the supporter", async () => {
  const db = createSeededDatabase();
  const s = authed(db);
  const r = await evaluateToolGuardrails("transfer_match_ticket", { ...base, ticket_id: "TKT-77001", recipient_email: "a@b.com", transfer_reason: "OTHER", user_confirmed: true }, s, db);
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.code, "OWNERSHIP_MISMATCH");
});

await it("enforces the two-turn confirmation lock, then allows on confirm", async () => {
  const db = createSeededDatabase();
  const s = authed(db);
  const args = { ...base, ticket_id: "TKT-90211", recipient_email: "sam@b.com", transfer_reason: "GIFT_TO_FAMILY", user_confirmed: false } as const;
  // First proposal: locked.
  const first = await evaluateToolGuardrails("transfer_match_ticket", args, s, db);
  assert.equal(first.allowed, false);
  if (!first.allowed) assert.equal(first.code, "CONFIRMATION_REQUIRED");
  assert.ok(s.pendingAction, "pendingAction should be set");
  // Confirmed retry with matching hash: allowed.
  const second = await evaluateToolGuardrails("transfer_match_ticket", { ...args, user_confirmed: true }, s, db);
  assert.equal(second.allowed, true);
});

await it("anti-scalping: second transfer blocked (TKT-77001, already transferred)", async () => {
  const db = createSeededDatabase();
  const s = authed(db, "UEFA-20099");
  const r = await evaluateToolGuardrails("transfer_match_ticket", { ...base, ticket_id: "TKT-77001", recipient_email: "a@b.com", transfer_reason: "OTHER", user_confirmed: true }, s, db);
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.code, "MAX_TRANSFERS_REACHED");
});

await it("retention offer blocked for ineligible supporter (Jordan, tenure 1m)", async () => {
  const db = createSeededDatabase();
  const s = authed(db, "UEFA-20099");
  const r = await evaluateToolGuardrails("manage_subscription_retention", { ...base, subscription_id: "SUB-5002", action: "APPLY_ELIMINATION_DISCOUNT_50", cancellation_reason: "TOO_EXPENSIVE", user_confirmed: true }, s, db);
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.code, "RETENTION_NOT_ELIGIBLE");
});

await it("hard cancel is never blocked by eligibility (only confirmation-locked)", async () => {
  const db = createSeededDatabase();
  const s = authed(db, "UEFA-20099");
  const args = { ...base, subscription_id: "SUB-5002", action: "CANCEL_IMMEDIATELY", cancellation_reason: "TOO_EXPENSIVE", user_confirmed: false } as const;
  const first = await evaluateToolGuardrails("manage_subscription_retention", args, s, db);
  assert.equal(first.allowed, false);
  if (!first.allowed) assert.equal(first.code, "CONFIRMATION_REQUIRED");
  const second = await evaluateToolGuardrails("manage_subscription_retention", { ...args, user_confirmed: true }, s, db);
  assert.equal(second.allowed, true);
});

await it("booking: confirmation lock then allow (Jordan books the Final)", async () => {
  const db = createSeededDatabase();
  const s = authed(db, "UEFA-20099");
  const args = { ...base, match_id: "MTC-FINAL", category: "GENERAL", user_confirmed: false } as const;
  const first = await evaluateToolGuardrails("book_match_ticket", args, s, db);
  assert.equal(first.allowed, false);
  if (!first.allowed) assert.equal(first.code, "CONFIRMATION_REQUIRED");
  const second = await evaluateToolGuardrails("book_match_ticket", { ...args, user_confirmed: true }, s, db);
  assert.equal(second.allowed, true);
});

await it("booking: sold-out category is blocked (MTC-SF2 hospitality)", async () => {
  const db = createSeededDatabase();
  const s = authed(db, "UEFA-20099");
  const r = await evaluateToolGuardrails("book_match_ticket", { ...base, match_id: "MTC-SF2", category: "HOSPITALITY", user_confirmed: true }, s, db);
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.code, "CATEGORY_SOLD_OUT");
});

await it("booking: duplicate ticket for same fixture is blocked (Alex already holds MTC-SF2)", async () => {
  const db = createSeededDatabase();
  const s = authed(db, "UEFA-88412");
  const r = await evaluateToolGuardrails("book_match_ticket", { ...base, match_id: "MTC-SF2", category: "GENERAL", user_confirmed: true }, s, db);
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.code, "ALREADY_HAS_TICKET");
});

await it("upgrade: confirmation lock then allow (Jordan upgrades TKT-77001)", async () => {
  const db = createSeededDatabase();
  const s = authed(db, "UEFA-20099");
  const args = { ...base, ticket_id: "TKT-77001", user_confirmed: false } as const;
  const first = await evaluateToolGuardrails("upgrade_ticket_to_hospitality", args, s, db);
  assert.equal(first.allowed, false);
  if (!first.allowed) assert.equal(first.code, "CONFIRMATION_REQUIRED");
  const second = await evaluateToolGuardrails("upgrade_ticket_to_hospitality", { ...args, user_confirmed: true }, s, db);
  assert.equal(second.allowed, true);
});

await it("upgrade: already-hospitality ticket is blocked (Alex TKT-90210)", async () => {
  const db = createSeededDatabase();
  const s = authed(db, "UEFA-88412");
  const r = await evaluateToolGuardrails("upgrade_ticket_to_hospitality", { ...base, ticket_id: "TKT-90210", user_confirmed: true }, s, db);
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.code, "ALREADY_HOSPITALITY");
});

console.log(`\n${pass}/${pass + fail} guardrail checks passed`);
process.exit(fail ? 1 : 0);
