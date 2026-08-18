/**
 * REMEDIATION R1 §7 — extreme end-to-end testing.
 *
 * The nine paths the owner named, each run through the REAL production modules against a
 * DISPOSABLE LOCAL PostgreSQL. The only substitutions are the ones that cannot exist in a test
 * process, and each is a TRANSPORT, never a decision:
 *
 *   * `supabaseAdmin()` / `serviceClient()` → a pg-backed client that lands on the SAME SQL
 *     functions PostgREST would have called (tests/integration/helpers/pg-supabase.ts);
 *   * the OpenAI HTTP transport → a fixture that returns a fixed extraction document, so the
 *     CLASSIFICATION is deterministic. The gateway still validates it against the real Zod schema,
 *     and every decision downstream is still the real deterministic code;
 *   * the Inngest queue → an in-process recorder, because "was it enqueued" is the assertion.
 *
 * Everything else runs: the WhatsApp adapter, `recordInboundReceipt`, `dispatchReceipt`, identity
 * resolution, the finance gate, `drainInboundDispatch` through the real cron route handler,
 * `claim_source_events`, `makeFinanceCaptureProcessor`, `processSourceEvent`, the consumer store,
 * policy evaluation, approval creation, the audit trail, the review queue and the health signal.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── the substituted transports, set up in beforeAll and read through the mocks ────────────────
const H: {
  sb: any;
  enqueued: { name: string; data: any }[];
  extraction: Record<string, unknown> | null;
  transportError: string | null;
  transportCalls: number;
} = { sb: null, enqueued: [], extraction: null, transportError: null, transportCalls: 0 };

vi.mock("@/lib/supabase/server", () => ({ supabaseAdmin: () => H.sb }));
vi.mock("@/db/client", () => ({ serviceClient: () => H.sb }));
vi.mock("@/inngest/client", () => ({
  WHATSAPP_INBOUND_EVENT: "whatsapp/message.received",
  inngest: { send: async () => {} },
  inngestQueue: { enqueue: async (e: any) => { H.enqueued.push(e); } },
}));
vi.mock("@/ai/openai-transport", () => ({
  makeOpenAiTransport: () => ({
    async complete() {
      H.transportCalls += 1;
      if (H.transportError) throw new Error(H.transportError);
      return {
        text: JSON.stringify(H.extraction ?? {}),
        usage: { input_tokens: 10, output_tokens: 20 },
        cost_usd: "0.000100",
      };
    },
  }),
}));

import { pgSupabase } from "./helpers/pg-supabase";
import { whatsappAdapter } from "@/lib/inbound/adapters/whatsapp";
import { recordInboundReceipt } from "@/lib/inbound/receipt";
import { dispatchReceipt } from "@/lib/inbound/dispatch-receipt";
import { makeInboundDeps } from "@/lib/inbound/production-deps";
import { AWAITING_CLASSIFIER } from "@/events/finance-capture-processor";
import type { FinanceIntent } from "@/schemas/finance-intent";
import { sha256 } from "@/lib/ids";
import { newCorrelationId } from "@/lib/log";

let db: any;
let coA: string, coB: string;
let staffUser: string, reviewer: string;
const ACCT_A = `wa_x_a_${rnd()}`;
const ACCT_B = `wa_x_b_${rnd()}`;
const ACCT_UNMAPPED = `wa_x_none_${rnd()}`;
const STAFF = "94770000001";
const CUSTOMER = "94770000002";
const STRANGER = "94770000003";

/** A WhatsApp Cloud API webhook envelope, as Meta actually shapes it. */
const envelope = (account: string, from: string, text: string, msgId: string) => ({
  object: "whatsapp_business_account",
  entry: [{
    id: "waba",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "1", phone_number_id: account },
        messages: [{ from, id: msgId, timestamp: "1755500000", type: "text", text: { body: text } }],
      },
    }],
  }],
});

/**
 * The production inbound path, start to finish, exactly as `/api/webhooks/whatsapp` runs it:
 * adapt → persist the canonical receipt → dispatch under a lease.
 */
async function inbound(
  account: string, from: string, text: string, msgId = `wamid.${rnd()}`,
  classify?: () => Promise<FinanceIntent | null>,
) {
  const parsed = whatsappAdapter.parse(envelope(account, from, text, msgId), newCorrelationId);
  expect(parsed).toHaveLength(1);
  const m = parsed[0]!;
  const receipt = await recordInboundReceipt(H.sb, {
    source: m.channel,
    providerAccountId: m.providerAccountId,
    providerMessageId: m.providerMessageId,
    rawPayload: m.raw,
    contentHash: sha256(m.text),
    correlationId: m.correlationId,
  });
  const outcome = await dispatchReceipt(
    H.sb, receipt,
    { channel: "whatsapp", from: m.from ?? "", text: m.text, providerMessageId: m.providerMessageId ?? "", rawPayload: m.raw },
    m.providerAccountId,
    // The ONE substituted decision, and only when a test supplies it: production's
    // `classifyFinanceIntent` returns null because no model provider is configured (owner gate,
    // FOUND-003 blocked_owner). Everything else in these deps is the production wiring.
    classify
      ? (owner, currencies) => ({ ...makeInboundDeps(owner, currencies), classifyFinanceIntent: classify })
      : makeInboundDeps,
  );
  return { receipt, outcome, msgId };
}

/** Run the REAL scheduled dispatch drain route (secret and all). */
async function runDrain() {
  const { GET } = await import("@/app/api/cron/dispatch-drain/route");
  const res = await GET(new Request("http://x/api/cron/dispatch-drain", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }));
  return { status: res.status, body: await res.json() };
}

/** Run the REAL scheduled inbound sweeper route (the finance consumer). */
async function runSweeper() {
  const { GET } = await import("@/app/api/cron/inbound-sweeper/route");
  const res = await GET(new Request("http://x/api/cron/inbound-sweeper", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }));
  return { status: res.status, body: await res.json() };
}

const row = async (sql: string, params: any[] = []) => (await db.query(sql, params)).rows[0];
const rows = async (sql: string, params: any[] = []) => (await db.query(sql, params)).rows;

/**
 * The classification fixture §7 names. A model is only ever permitted to PROPOSE this much — no
 * company, no authority, no account code, no instruction to pay — and the deterministic gate in
 * `src/lib/finance/intent-gate.ts` still decides what happens to it.
 */
const FINANCE_INTENT = (amount: string, counterparty: string, evidence = false): FinanceIntent => ({
  kind: "payment_made",
  amountRaw: amount,
  currencyRaw: "LKR",
  counterpartyRaw: counterparty,
  evidenceRefs: [`paid LKR ${amount}`],
  // The gate refuses to capture a MATERIAL amount (> LKR 10,000) with no supporting document; it
  // goes to a person instead. Tests that want a capture at a material amount say so explicitly.
  mentionsEvidenceDocument: evidence,
  confidence: 0.94,
  missingInfo: [],
});
const classifier = (amount: string, counterparty: string, evidence = false) =>
  async () => FINANCE_INTENT(amount, counterparty, evidence);
/** A message the classifier says is not financial at all. */
const notFinancial = async (): Promise<FinanceIntent> => ({
  kind: "none", amountRaw: null, currencyRaw: null, counterpartyRaw: null,
  evidenceRefs: [], mentionsEvidenceDocument: false, confidence: 0.9, missingInfo: [],
});

const VALID_EXTRACTION = (companyId: string) => ({
  schema_version: "1.0",
  event_type: "expense_payment",
  company_candidate_id: companyId,
  division_candidate_id: null,
  project_candidate_id: null,
  site_candidate_id: null,
  transaction_date: "2026-08-01",
  amount: "45000.00",
  currency: "LKR",
  counterparty_name: "Acme Cement",
  counterparty_candidate_id: null,
  purpose: "cement for the site",
  payment_method: "company_bank",
  paid_by_employee_id: null,
  suggested_account_code: null,
  tax_code: null,
  evidence_document_ids: ["x2e-receipt-1"],
  conversation_reference_ids: [],
  is_reimbursement_expected: false,
  allocations: [],
  missing_fields: [],
  risk_flags: [],
  confidence: { overall: 0.93, amount: 0.97 },
  recommended_action: "create_draft",
});

describe.skipIf(!enabled)("R1 §7 — extreme end to end (disposable local PostgreSQL)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    H.sb = pgSupabase(db);
    process.env.CRON_SECRET = `x2e_${rnd()}`;

    coA = (await row(`insert into companies (name, base_currency) values ('x2e A','LKR') returning id`)).id;
    coB = (await row(`insert into companies (name, base_currency) values ('x2e B','LKR') returning id`)).id;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coA, ACCT_A]);
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coB, ACCT_B]);

    staffUser = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [staffUser]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'x2e staff',true) on conflict do nothing`, [staffUser]);
    await db.query(
      `insert into channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
       values ($1,'whatsapp',$2,'staff',$3,'x2e staff')`, [coA, STAFF, staffUser]);
    const cust = (await row(`insert into customers (company_id, name, phone) values ($1,'x2e customer',$2) returning id`, [coA, CUSTOMER])).id;
    await db.query(
      `insert into channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
       values ($1,'whatsapp',$2,'customer',$3,'x2e customer')`, [coA, CUSTOMER, cust]);

    reviewer = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [reviewer]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'x2e reviewer',true) on conflict do nothing`, [reviewer]);
    const m = (await row(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [coA, reviewer])).id;
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [m, coA]);

    // A real approval policy, so the DETERMINISTIC policy engine runs rather than the
    // no-policy fail-safe. Nothing auto-approves: every rule here requires a person.
    await db.query(
      `insert into approval_policies (company_id, version, policy, is_active) values ($1,1,$2,true)`,
      [coA, JSON.stringify({
        company_id: coA,
        currency: "LKR",
        version: 1,
        rules: [{
          id: "x2e-expense",
          description: "expense payments need one finance reviewer",
          priority: 10,
          event_types: null,
          currency: "LKR",
          min_amount: null,
          max_amount: null,
          require_evidence: true,
          auto_approve: false,
          required_approver_roles: ["finance_reviewer"],
          approvals_required: 1,
        }],
      })]);
  });

  afterAll(async () => {
    for (const co of [coA, coB]) {
      for (const sql of [
        `delete from audit_events where company_id=$1`,
        `delete from approval_requests where company_id=$1`,
        `delete from policy_evaluations where company_id=$1`,
        `delete from clarification_requests where company_id=$1`,
        `delete from duplicate_candidates where company_id=$1`,
        `delete from financial_event_versions where company_id=$1`,
        `delete from financial_events where company_id=$1`,
        `delete from inbound_reviews where company_id=$1`,
        `delete from ai_runs where company_id=$1`,
        `delete from source_events where company_id=$1`,
        `delete from channel_identities where company_id=$1`,
        `delete from channel_accounts where company_id=$1`,
        `delete from customers where company_id=$1`,
        `delete from membership_roles where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [co]); } catch { /* noop */ } }
    }
    await db?.end().catch(() => {});
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // PATH 1 — the whole journey, receipt to health signal.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("PATH 1 — receipt → company → identity → classification → source event → drain → finance processor → policy → approval → audit → health", async () => {
    const baseline = await row(`select * from public.inbound_dispatch_health()`);
    H.enqueued = [];
    H.extraction = VALID_EXTRACTION(coA);
    H.transportError = null;
    delete process.env.OPENAI_API_KEY;

    // (a) the message arrives and is dispatched. No classifier is configured yet, so the honest
    //     outcome is a review item — not a guess, and not a customer order.
    const { receipt, msgId } = await inbound(ACCT_A, STAFF, "paid LKR 45,000 to Acme Cement for the site");
    const after = await row(`select company_id, dispatch_state, dispatch_outcome, provider_message_id, event_identity from source_events where id=$1`, [receipt.event.id]);
    expect(after.company_id).toBe(coA);                       // company, from the receiving account
    expect(after.provider_message_id).toBe(msgId);            // trusted provider identity
    expect(after.event_identity).toContain(ACCT_A);           // canonical identity, not the text
    expect(after.dispatch_state).toBe("manual_review");       // parked for a person, explicitly
    expect(after.dispatch_outcome).toBe("manual_review");     // fails CLOSED without a classifier

    const parked = await row(`select reason_code, state from inbound_reviews where source_event_id=$1`, [receipt.event.id]);
    expect(parked.state).toBe("open");

    // (b) NOW a classifier answers — the §7 classification fixture. The same kind of staff message
    //     becomes a durable finance capture. In production this port still returns null (owner
    //     gate), which is why FOUND-003 stays blocked_owner; what the fixture proves is that the
    //     REST of the chain is built and works the moment the owner configures a provider.
    process.env.OPENAI_API_KEY = "x2e-fixture";
    const second = await inbound(ACCT_A, STAFF, "paid LKR 62,500 to Acme Cement for rebar",
      `wamid.${rnd()}`, classifier("62500", "Acme Cement", true));
    expect(second.outcome).toBe("staff_finance");
    const cap = await row(`select company_id, dispatch_outcome, status from source_events where id=$1`, [second.receipt.event.id]);
    expect(cap.dispatch_outcome).toBe("staff_finance");
    expect(cap.company_id).toBe(coA);
    expect(cap.status).toBe("pending");                       // real backlog, not a fake completion
    expect(H.enqueued.length).toBeGreaterThan(0);             // the durable consumer was asked

    // (c) the SCHEDULED consumer runs — the real route, the real pipeline.
    const sweep = await runSweeper();
    expect(sweep.status).toBe(200);
    expect(sweep.body.claimed).toBeGreaterThan(0);
    expect(H.transportCalls).toBeGreaterThan(0);              // extraction really ran

    // (d) a drafted financial event exists, in a REVIEWABLE state — never posted.
    const fe = await row(`select id, state, amount, currency, company_id from financial_events where source_event_id=$1`, [second.receipt.event.id]);
    expect(fe).toBeTruthy();
    expect(fe.company_id).toBe(coA);
    expect(Number(fe.amount)).toBe(45000);      // the EXTRACTED amount, stored as an exact decimal
    expect(fe.currency).toBe("LKR");
    // The deterministic policy engine decided this, not the model: an approval is required, so the
    // event waits for one. `approved` here would still not mean posted.
    expect(["awaiting_approval", "approved"]).toContain(fe.state);
    if (fe.state === "awaiting_approval") {
      const ap = await row(`select approvals_required, status from approval_requests where financial_event_id=$1`, [fe.id]);
      expect(ap).toBeTruthy();
      expect(Number(ap.approvals_required)).toBeGreaterThan(0);
    }

    // (e) an immutable v1 snapshot, a policy evaluation and an audit trail.
    expect(await row(`select version from financial_event_versions where financial_event_id=$1`, [fe.id])).toBeTruthy();
    const pe = await row(`select outcome, approvals_required, reasons from policy_evaluations where financial_event_id=$1`, [fe.id]);
    expect(pe).toBeTruthy();                  // the DETERMINISTIC policy engine ran and was recorded
    expect(pe.outcome).toBe("require_approval");
    expect(Number(pe.approvals_required)).toBeGreaterThan(0);
    const audit = await rows(`select action from audit_events where company_id=$1`, [coA]);
    expect(audit.length).toBeGreaterThan(0);

    // (f) NOTHING was posted to the ledger by this path.
    const je = await row(`select count(*)::int as n from journal_entries where company_id=$1`, [coA]);
    expect(je.n).toBe(0);

    // (g) the receipt is settled, so the health backlog is truthful rather than permanently inflated.
    const done = await row(`select status from source_events where id=$1`, [second.receipt.event.id]);
    expect(done.status).toBe("completed");            // the consumer finished it
    // The backlog a person is shown counts only genuinely outstanding work: this receipt is
    // finished, and the customer orders and decided reviews are not counted as unprocessed.
    const backlog = await row(`select * from public.source_event_backlog($1)`, [coA]);
    expect(Number(backlog.pending)).toBe(0);
    expect(Number(backlog.dead_letter)).toBe(0);
    // `inbound_dispatch_health()` is a GLOBAL operator signal, not a per-company one, and this
    // suite shares a database with every other integration file. Assert the DELTA this path leaves
    // behind rather than an absolute zero, which would be measuring other tests' fixtures.
    const health = await row(`select * from public.inbound_dispatch_health()`);
    expect(Number(health.awaiting_dispatch) - Number(baseline.awaiting_dispatch)).toBe(0);
    expect(Number(health.dispatching) - Number(baseline.dispatching)).toBe(0);

    // (h) a MATERIAL transaction with NO supporting document stops for evidence rather than
    //     proceeding to approval. The model does not get to waive this.
    H.extraction = {
      ...VALID_EXTRACTION(coA), evidence_document_ids: [],
      amount: "90000.00", counterparty_name: "Ceylon Roofing", transaction_date: "2026-08-05",
    };
    const undocumented = await inbound(ACCT_A, STAFF, "paid LKR 90,000 to Ceylon Roofing, no bill yet",
      `wamid.${rnd()}`, classifier("90000", "Ceylon Roofing", true));
    expect(undocumented.outcome).toBe("staff_finance");
    await runSweeper();
    const evFe = await row(`select state from financial_events where source_event_id=$1`, [undocumented.receipt.event.id]);
    expect(evFe.state).toBe("awaiting_evidence");
    expect((await row(`select count(*)::int as n from approval_requests where financial_event_id=(select id from financial_events where source_event_id=$1)`, [undocumented.receipt.event.id])).n).toBe(0);

    // (i) DUPLICATE DETECTION runs. The same payment described twice is scored against what the
    //     company already has, and the second one is flagged rather than drafted as new work.
    H.extraction = { ...VALID_EXTRACTION(coA), evidence_document_ids: [] };
    const again = await inbound(ACCT_A, STAFF, "paid LKR 90,000 to Ceylon Roofing (resending)",
      `wamid.${rnd()}`, classifier("90000", "Ceylon Roofing", true));
    await runSweeper();
    const dupFe = await row(`select id, state from financial_events where source_event_id=$1`, [again.receipt.event.id]);
    // PAUSED for a person, not terminated. `duplicate` has no transition out, so writing it from a
    // similarity SCORE silently discarded a second genuine payment; `awaiting_information` is
    // reversible and a human decides.
    expect(dupFe.state).toBe("awaiting_information");
    expect(Number((await row(`select count(*)::int as n from duplicate_candidates where financial_event_id=$1`, [dupFe.id])).n)).toBeGreaterThan(0);
    const dupRev = await row(`select state, score, algorithm_version from duplicate_reviews where financial_event_id=$1`, [dupFe.id]);
    expect(dupRev.state).toBe("open");
    expect(dupRev.algorithm_version).toBe("dup/v2-evidence-required");
    H.extraction = VALID_EXTRACTION(coA);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // PATH 2 — a customer order never enters the staff finance path.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("PATH 2 — a CUSTOMER message never becomes a finance capture, however it is worded", async () => {
    process.env.OPENAI_API_KEY = "x2e-fixture";
    const before = (await row(`select count(*)::int as n from source_events where company_id=$1 and dispatch_outcome='staff_finance'`, [coA])).n;

    // Worded to look exactly like the staff finance message, WITH a classifier that reads it as a
    // payment, from a customer's number. Identity decides; wording and classification do not.
    const { receipt, outcome } = await inbound(ACCT_A, CUSTOMER, "paid LKR 45,000 to Acme Cement, please record it",
      `wamid.${rnd()}`, classifier("45000", "Acme Cement", true));
    expect(outcome).toBe("customer_order");

    const r = await row(`select dispatch_outcome, status from source_events where id=$1`, [receipt.event.id]);
    expect(r.dispatch_outcome).toBe("customer_order");
    expect(r.status).toBe("processed");                       // decided, so not counted as backlog
    const afterN = (await row(`select count(*)::int as n from source_events where company_id=$1 and dispatch_outcome='staff_finance'`, [coA])).n;
    expect(afterN).toBe(before);
    expect(await row(`select id from financial_events where source_event_id=$1`, [receipt.event.id])).toBeUndefined();

    // And the consumer cannot reach it even if it wanted to: claiming is narrowed to captures.
    const claimable = await rows(`select id from public.claim_source_events(50,'x2e-probe',60) where id=$1`, [receipt.event.id]);
    expect(claimable).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // PATH 3 — an unmapped receiving account is VISIBLE, not silently attributed.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("PATH 3 — an unknown company is retryable and visible, never guessed", async () => {
    const { receipt, outcome } = await inbound(ACCT_UNMAPPED, STAFF, "paid LKR 10,000 for fuel",
      `wamid.${rnd()}`, classifier("10000", "Fuel Station"));
    expect(outcome).toBe("unattributed");

    const r = await row(`select company_id, dispatch_state, last_error_code, dispatch_attempts, next_attempt_at from source_events where id=$1`, [receipt.event.id]);
    expect(r.company_id).toBeNull();                          // NOT attributed to the only company
    expect(r.dispatch_state).toBe("failed");                  // retryable, with a backoff
    expect(r.last_error_code).toBe("company_unresolved");
    expect(Number(r.dispatch_attempts)).toBe(1);

    // Visible in the health signal rather than lost.
    const health = await row(`select * from public.inbound_dispatch_health()`);
    expect(Number(health.unattributed ?? 0)).toBeGreaterThan(0);

    // And it recovers BY ITSELF once an owner maps the account — no replay of the message.
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coB, ACCT_UNMAPPED]);
    await db.query(`update source_events set next_attempt_at = now() - interval '1 minute' where id=$1`, [receipt.event.id]);
    const drain = await runDrain();
    expect(drain.status).toBe(200);
    const recovered = await row(`select company_id, dispatch_state from source_events where id=$1`, [receipt.event.id]);
    expect(recovered.company_id).toBe(coB);
    // Decided — as a review item, because this sender is not company B's staff. What matters here
    // is that it was decided AT ALL, by the system's own retry, with no replay of the message.
    expect(["dispatched", "manual_review"]).toContain(recovered.dispatch_state);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // PATH 4 — provider unavailable → backoff → recovery, with no loss and no duplicate.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("PATH 4 — an unavailable model provider backs off and later recovers, producing ONE financial event", async () => {
    process.env.OPENAI_API_KEY = "x2e-fixture";
    H.extraction = VALID_EXTRACTION(coA);
    const { receipt } = await inbound(ACCT_A, STAFF, "paid LKR 8,000 to Lanka Hardware for nails",
      `wamid.${rnd()}`, classifier("8000", "Lanka Hardware"));
    expect((await row(`select dispatch_outcome from source_events where id=$1`, [receipt.event.id])).dispatch_outcome).toBe("staff_finance");

    // The provider is down. The sweep must NOT complete the event and must NOT dead-letter it.
    H.transportError = "ECONNRESET talking to the model provider";
    const failed = await runSweeper();
    expect(failed.status).toBe(200);
    const backoff = await row(`select status, attempts, next_attempt_at, dead_lettered_at, last_error_code from source_events where id=$1`, [receipt.event.id]);
    expect(backoff.status).toBe("retry_wait");                // still outstanding, truthfully
    expect(Number(backoff.attempts)).toBeGreaterThan(0);
    expect(backoff.dead_lettered_at).toBeNull();
    expect(new Date(backoff.next_attempt_at).getTime()).toBeGreaterThan(Date.now() - 1000); // backed off
    expect(await row(`select id from financial_events where source_event_id=$1`, [receipt.event.id])).toBeUndefined();

    // The provider recovers. The retry succeeds and produces exactly ONE financial event.
    H.transportError = null;
    await db.query(`update source_events set next_attempt_at = now() - interval '1 minute' where id=$1`, [receipt.event.id]);
    const ok = await runSweeper();
    expect(ok.status).toBe(200);
    const settled = await row(`select status, last_error_code, last_error from source_events where id=$1`, [receipt.event.id]);
    if (settled.status !== "completed") console.error("DEBUG P4", settled.last_error_code, settled.last_error);
    expect(settled.status).toBe("completed");
    const n = (await row(`select count(*)::int as n from financial_events where source_event_id=$1`, [receipt.event.id])).n;
    expect(n).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // PATH 5 — a duplicate/replayed message produces exactly ONE of everything.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("PATH 5 — the SAME provider message delivered five times, including concurrently, has ONE effect", async () => {
    process.env.OPENAI_API_KEY = "x2e-fixture";
    H.extraction = VALID_EXTRACTION(coA);
    H.enqueued = [];
    const msgId = `wamid.replay_${rnd()}`;
    const text = "paid LKR 21,000 to Ceylon Steel for brackets";

    // Delivery 1, then three CONCURRENT redeliveries, then one more after it settled.
    const cls = classifier("21000", "Ceylon Steel", true);
    const first = await inbound(ACCT_A, STAFF, text, msgId, cls);
    const concurrent = await Promise.all([
      inbound(ACCT_A, STAFF, text, msgId, cls),
      inbound(ACCT_A, STAFF, text, msgId, cls),
      inbound(ACCT_A, STAFF, text, msgId, cls),
    ]);
    const last = await inbound(ACCT_A, STAFF, text, msgId, cls);

    // ONE receipt.
    const receipts = await rows(`select id from source_events where provider_message_id=$1`, [msgId]);
    expect(receipts).toHaveLength(1);
    expect(concurrent.every((c) => c.receipt.event.id === first.receipt.event.id)).toBe(true);
    expect(last.receipt.created).toBe(false);

    // ONE business dispatch: the redeliveries were refused, not re-decided.
    expect(first.outcome).toBe("staff_finance");
    for (const c of [...concurrent, last]) {
      expect(["already_dispatched", "retry_pending"]).toContain(c.outcome);
    }
    expect(H.enqueued.filter((e) => e.data?.source_event_id === first.receipt.event.id)).toHaveLength(1);

    // ONE financial event, even though the sweeper also runs twice.
    await runSweeper();
    await runSweeper();
    const fes = await rows(`select id from financial_events where source_event_id=$1`, [first.receipt.event.id]);
    expect(fes).toHaveLength(1);
    // ONE review row at most, and no second manual-review item for the same message.
    const reviews = await rows(`select id from inbound_reviews where provider_message_id=$1`, [msgId]);
    expect(reviews.length).toBeLessThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // PATH 6 — the service role cannot forge a human decision.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("PATH 6 — a service-role caller cannot create a human routing decision by any route", async () => {
    const t = (await row(`insert into tasks (company_id, title, status) values ($1,'x2e forge probe','captured') returning id`, [coA])).id;

    // (a) the human RPC is not granted to service_role at all.
    await db.query("begin");
    try {
      await expect(db.query(`select * from public.route_task_as_human($1,$2,'needs_routing','forged')`, [coA, t]))
        .rejects.toMatchObject({ code: "42501" });
    } finally { await db.query("rollback"); }

    // (b) the old spoofable entrypoint is gone — a caller-supplied actor_source cannot be passed.
    await db.query("begin");
    try {
      await expect(db.query(`select * from public.route_task($1,$2,'needs_routing','x','human',$3)`, [coA, t, reviewer]))
        .rejects.toMatchObject({ code: "42883" });
    } finally { await db.query("rollback"); }

    // (c) a DIRECT table write claiming human provenance is refused by the database itself.
    //     The columns here are the REAL ones — an earlier version of this assertion named columns
    //     that do not exist, so it passed on a 42703 and established nothing about the boundary.
    // AS service_role, not as the connection's own role: this test connects as the table OWNER, for
    // which the positive owner allowlist legitimately returns true. Probing as the owner proves
    // nothing about what a CALLER can do, which is the only question here.
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      await expect(db.query(
        `insert into task_routing_events (company_id, task_id, from_state, to_state, reason_code, actor_source, actor_id)
         values ($1,$2,null,'assigned','forged','human',$3)`, [coA, t, reviewer]))
        .rejects.toThrow(/routing boundary/i);
      await db.query("rollback");
      await db.query("begin");
      await db.query("set local role service_role");
      // …and so is a routing ROW that claims a person decided it.
      await expect(db.query(
        `insert into task_routing (company_id, task_id, routing_state, reason_code, decided_by, decided_by_source)
         values ($1,$2,'assigned','forged',$3,'human')`, [coA, t, reviewer]))
        .rejects.toThrow(/routing boundary/i);
    } finally { await db.query("rollback"); }

    // (d) the AI path works, and CANNOT name a person.
    const ai = await row(`select * from public.route_task_as_ai($1,$2,'needs_routing','low confidence','x2e-test','fixture','x2e/v1')`, [coA, t]);
    expect(ai).toBeTruthy();
    const ev = await row(`select actor_source, actor_id, detail from task_routing_events where task_id=$1 order by created_at desc limit 1`, [t]);
    expect(ev.actor_source).toBe("ai");
    expect(ev.actor_id).toBeNull();                  // a machine decision never names a person
    expect(ev.detail.component).toBe("x2e-test");
    const routing = await row(`select decided_by_source, decided_by, decided_by_component, decided_by_model, decided_by_policy_version
                                 from task_routing where task_id=$1 and superseded_by is null`, [t]);
    expect(routing.decided_by_source).toBe("ai");
    expect(routing.decided_by).toBeNull();
    expect(routing.decided_by_component).toBe("x2e-test");
    expect(routing.decided_by_model).toBe("fixture");
    expect(routing.decided_by_policy_version).toBe("x2e/v1");

    // (e) provenance is immutable after the fact.
    await expect(db.query(`update task_routing_events set actor_source='human', actor_id=$2 where task_id=$1`, [t, reviewer]))
      .rejects.toThrow();
    await db.query(`delete from task_routing_events where task_id=$1`, [t]).catch(() => {});
    await db.query(`delete from tasks where id=$1`, [t]).catch(() => {});
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // PATH 7 — cross-company substitution is refused at every layer that could accept it.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("PATH 7 — a message on company A's number cannot be attributed to, or read by, company B", async () => {
    process.env.OPENAI_API_KEY = "x2e-fixture";
    // The extraction NAMES company B. The pipeline must ignore it: a model does not choose a company.
    H.extraction = { ...VALID_EXTRACTION(coA), company_candidate_id: coB };
    const { receipt } = await inbound(ACCT_A, STAFF, "paid LKR 5,000 to Metro Traders for tape",
      `wamid.${rnd()}`, classifier("5000", "Metro Traders"));
    await runSweeper();

    const fe = await row(`select company_id from financial_events where source_event_id=$1`, [receipt.event.id]);
    expect(fe.company_id).toBe(coA);        // the RECEIVING account decides, not the model
    expect(fe.company_id).not.toBe(coB);

    // The same staff phone number on company B's account is NOT that company's staff.
    const { receipt: bReceipt, outcome } = await inbound(ACCT_B, STAFF, "paid LKR 5,000 for tape",
      `wamid.${rnd()}`, classifier("5000", "Metro Traders"));
    expect(outcome).not.toBe("staff_finance");
    const b = await row(`select company_id, dispatch_outcome from source_events where id=$1`, [bReceipt.event.id]);
    expect(b.company_id).toBe(coB);

    // And company A's reviewer sees nothing of company B's queue.
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "authenticated", sub: reviewer })]);
      const visible = await rows(`select company_id from inbound_reviews`);
      expect(visible.every((v: any) => v.company_id === coA)).toBe(true);
      const events = await rows(`select company_id from source_events`);
      expect(events.every((v: any) => v.company_id === coA)).toBe(true);
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
    H.extraction = VALID_EXTRACTION(coA);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // PATH 8 — a crash at every durable boundary loses nothing and duplicates nothing.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("PATH 8 — a crash after the receipt, after the claim, after the effect, and mid-consumer, all recover", async () => {
    process.env.OPENAI_API_KEY = "x2e-fixture";
    H.extraction = VALID_EXTRACTION(coA);

    // (a) crash AFTER the receipt, BEFORE any dispatch: the drain picks it up.
    const parsedA = whatsappAdapter.parse(envelope(ACCT_A, STAFF, "paid LKR 3,300 for gloves", `wamid.c1_${rnd()}`), newCorrelationId);
    const rA = await recordInboundReceipt(H.sb, {
      source: "whatsapp", providerAccountId: parsedA[0]!.providerAccountId,
      providerMessageId: parsedA[0]!.providerMessageId, rawPayload: parsedA[0]!.raw,
      contentHash: sha256("x"), correlationId: parsedA[0]!.correlationId,
    });
    expect((await row(`select dispatch_state from source_events where id=$1`, [rA.event.id])).dispatch_state).toBe("pending");
    await runDrain();
    const aAfter = await row(`select dispatch_state, company_id from source_events where id=$1`, [rA.event.id]);
    // The drain has no per-message classifier fixture, so this decides as a review item. What is
    // being proven is that a receipt with NO dispatch is picked up and DECIDED by the schedule.
    expect(["dispatched", "manual_review"]).toContain(aAfter.dispatch_state);
    expect(aAfter.company_id).toBe(coA);

    // (b) crash AFTER the claim, BEFORE the outcome: the lease expires and the work is recovered,
    //     without a second effect.
    const { receipt: rB } = await inbound(ACCT_A, STAFF, "paid LKR 4,400 for a drill bit",
      `wamid.${rnd()}`, classifier("4400", "Tool Shop"));
    await db.query(`update source_events set dispatch_state='dispatching', dispatch_owner='dead-worker',
                    dispatch_lease_expires_at = now() - interval '5 minutes' where id=$1`, [rB.event.id]);
    const drainB = await runDrain();
    expect(drainB.status).toBe(200);
    const bAfter = await row(`select dispatch_state, dispatch_outcome from source_events where id=$1`, [rB.event.id]);
    expect(["dispatched", "manual_review"]).toContain(bAfter.dispatch_state);
    const bCount = (await row(`select count(*)::int as n from source_events where provider_message_id=(select provider_message_id from source_events where id=$1)`, [rB.event.id])).n;
    expect(bCount).toBe(1);

    // (c) crash AFTER the downstream effect, BEFORE the marker: the retry is idempotent because
    //     every downstream is. Simulated by rewinding the marker and re-running the drain.
    const { receipt: rC } = await inbound(ACCT_A, STAFF, "paid LKR 5,500 for a saw blade",
      `wamid.${rnd()}`, classifier("5500", "Tool Shop"));
    await db.query(`update source_events set dispatch_state='pending', dispatch_owner=null,
                    dispatch_lease_expires_at=null, next_attempt_at = now() - interval '1 minute' where id=$1`, [rC.event.id]);
    await runDrain();
    expect(["dispatched", "manual_review"]).toContain(
      (await row(`select dispatch_state from source_events where id=$1`, [rC.event.id])).dispatch_state);
    const cReviews = (await row(`select count(*)::int as n from inbound_reviews where source_event_id=$1`, [rC.event.id])).n;
    expect(cReviews).toBeLessThanOrEqual(1);

    // (d) crash MID-CONSUMER: the sweeper's lease expires and another run finishes the work once.
    const { receipt: rD } = await inbound(ACCT_A, STAFF, "paid LKR 6,600 for a level",
      `wamid.${rnd()}`, classifier("6600", "Tool Shop"));
    await db.query(`select id from public.claim_source_events(50,'dead-sweeper',1) where id=$1`, [rD.event.id]);
    await db.query(`update source_events set lease_expires_at = now() - interval '5 minutes' where id=$1`, [rD.event.id]);
    await runSweeper();
    const dAfter = await row(`select status from source_events where id=$1`, [rD.event.id]);
    expect(dAfter.status).toBe("completed");
    expect((await row(`select count(*)::int as n from financial_events where source_event_id=$1`, [rD.event.id])).n).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // PATH 9 — what a person is shown matches what is persisted.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  it("PATH 9 — the review and routing states a capable member reads are the persisted ones, and an incapable member reads none", async () => {
    // A message from a stranger — neither staff nor customer — is parked for a person.
    delete process.env.OPENAI_API_KEY;
    const { receipt, outcome } = await inbound(ACCT_A, STRANGER, "hello, is this the site office?");
    expect(outcome).toBe("manual_review");

    const persisted = await row(
      `select id, state, reason_code, actor_type, identity_match, sender_identity
         from inbound_reviews where source_event_id=$1`, [receipt.event.id]);
    expect(persisted.state).toBe("open");
    expect(persisted.actor_type).toBe("unknown");
    expect(persisted.sender_identity).toBe(STRANGER);

    // What the capable member's query returns is the SAME row, with the same state.
    await db.query("begin");
    let seen: any;
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "authenticated", sub: reviewer })]);
      seen = (await db.query(`select id, state, reason_code, actor_type from inbound_reviews where id=$1`, [persisted.id])).rows[0];
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
    expect(seen).toBeTruthy();
    expect(seen.state).toBe(persisted.state);
    expect(seen.reason_code).toBe(persisted.reason_code);
    expect(seen.actor_type).toBe(persisted.actor_type);

    // A member with no capability in this company reads nothing at all.
    const outsider = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [outsider]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'x2e outsider',true) on conflict do nothing`, [outsider]);
    await db.query("begin");
    let outsiderRows: any[];
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "authenticated", sub: outsider })]);
      outsiderRows = (await db.query(`select id from inbound_reviews`)).rows;
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
    expect(outsiderRows).toHaveLength(0);
    await db.query(`delete from users where id=$1`, [outsider]).catch(() => {});

    // Closing it records WHO and WHY, and the state a person then reads is the closed one.
    await db.query(`select * from public.resolve_inbound_review($1,$2,$3,'resolved','x2e: replied by phone')`, [coA, persisted.id, reviewer]);
    const closed = await row(`select state, resolved_by, resolution_note from inbound_reviews where id=$1`, [persisted.id]);
    expect(closed.state).toBe("resolved");
    expect(closed.resolved_by).toBe(reviewer);
    expect(closed.resolution_note).toContain("replied by phone");
    process.env.OPENAI_API_KEY = "x2e-fixture";
  });
});
