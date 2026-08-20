/**
 * OF-016 — the dismissal must survive a pass of the REAL store and the REAL pipeline.
 *
 * This test exists because the one I wrote first did not. `tests/of016-resume-after-dismissal.test.ts`
 * drives `processSourceEvent` against a MOCK store whose `createDraft` mints a fresh event id on
 * every call and whose candidate list never contains the event under consideration — so it modelled
 * a world the resume path can never actually be in, and it passed while the real path was broken.
 *
 * Here the store is `makeSupabaseConsumerStore` over a disposable local PostgreSQL 16, the
 * dismissal goes through the real `resolve_duplicate_review` RPC as a real authenticated human, and
 * the pipeline runs twice. Only the model transport is faked, because there is no model here.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pgSupabase } from "./helpers/pg-supabase";
import { makeSupabaseConsumerStore } from "@/db/consumer-store";
import { processSourceEvent, type ConsumerDeps } from "@/inngest/processing";
import { AiGateway, type CompletionTransport } from "@/ai/gateway";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any, sb: any, store: any;
const SUFFIX = rnd();
const AUTH = `of16rs_${SUFFIX}`;
const conns: any[] = [];
let co: string, reviewer: string;
const companies: string[] = [];

const one = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];

const AMOUNT = "45000.00";
const WHEN = "2026-08-10";
const PARTY = "Acme Supplies";

function extraction() {
  return JSON.stringify({
    schema_version: "1.0", event_type: "expense_payment", company_candidate_id: co,
    division_candidate_id: null, project_candidate_id: null, site_candidate_id: null,
    transaction_date: WHEN, amount: AMOUNT, currency: "LKR", counterparty_name: PARTY,
    counterparty_candidate_id: null, purpose: "site supplies", payment_method: "company_cash",
    paid_by_employee_id: null, suggested_account_code: "5000", tax_code: null,
    evidence_document_ids: ["doc_1"], conversation_reference_ids: [], is_reimbursement_expected: false,
    allocations: [], missing_fields: [], risk_flags: [],
    confidence: { overall: 0.95, amount: 0.95, purpose: 0.9, company: 0.99 },
    recommended_action: "create_draft",
  });
}
const transport: CompletionTransport = {
  async complete() {
    return { text: extraction(), usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: "0" } as any;
  },
};

function deps(): ConsumerDeps {
  return { ...store, gateway: new AiGateway(transport, { record() {} }) } as ConsumerDeps;
}

async function mkConn(role?: string) {
  const { default: pg } = await import("pg" as string);
  const c = new pg.Client({
    connectionString: role ? URL.replace(/\/\/[^@]*@/, `//${role}:probe@`) : URL, ssl: mkSsl(URL),
  });
  await c.connect();
  conns.push(c);
  return c;
}

describe.skipIf(!enabled)("OF-016 — the dismissal survives the real store and pipeline", () => {
  beforeAll(async () => {
    db = await mkConn();
    await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await db.query(`drop role if exists ${AUTH}`);
    await db.query(`create role ${AUTH} login password 'probe'`);
    await db.query(`grant authenticated to ${AUTH}`);
    sb = pgSupabase(db);
    store = makeSupabaseConsumerStore(sb);

    co = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16rs ${SUFFIX}`])).id;
    reviewer = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [reviewer]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'of16rs reviewer',true) on conflict do nothing`, [reviewer]);
    const m = await one(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, reviewer]);
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'finance_reviewer')`, [m.id, co]);
  });

  afterAll(async () => {
    for (const c of conns.slice(1)) await c.end().catch(() => {});
    for (const cid of companies) {
      for (const sql of [
        `delete from approval_requests where company_id=$1`,
        `delete from duplicate_candidates where company_id=$1`,
        `delete from duplicate_reviews where company_id=$1`,
        `delete from financial_events where company_id=$1`,
        `delete from source_events where company_id=$1`,
        `delete from membership_roles where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [cid]); } catch { /* noop */ } }
    }
    for (const sql of [
      `delete from approval_requests where company_id=$1`,
      `delete from duplicate_candidates where company_id=$1`,
      `delete from duplicate_reviews where company_id=$1`,
      `delete from financial_events where company_id=$1`,
      `delete from source_events where company_id=$1`,
      `delete from membership_roles where company_id=$1`,
      `delete from memberships where company_id=$1`,
      `delete from companies where id=$1`,
    ]) { try { await db.query(sql, [co]); } catch { /* noop */ } }
    try { await db.query(`drop role if exists ${AUTH}`); } catch { /* noop */ }
    await db.end().catch(() => {});
  });

  /**
   * A company of its own for each scenario.
   *
   * Without this, an earlier test's "earlier payment" is a perfectly legitimate NEW counterpart for
   * a later test's event — the pipeline pauses again, correctly, and the later test reads it as a
   * failure of the resume. Isolating the company keeps each assertion about the thing it names.
   */
  async function freshCompany(): Promise<string> {
    const id = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`,
      [`of16rs ${rnd()}`])).id;
    companies.push(id);
    const m = await one(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [id, reviewer]);
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'finance_reviewer')`, [m.id, id]);
    return id;
  }

  async function seedSourceAndEarlier() {
    const src = (await one(
      `insert into source_events (source, provider_message_id, raw_payload, idempotency_key, status,
                                  dispatch_state, dispatch_outcome, company_id, correlation_id, next_attempt_at)
       values ('whatsapp',$1,$2,$3,'processing','dispatched','staff_finance',$4,$5, now()) returning id`,
      [`pm-${rnd()}`, JSON.stringify({ text: { body: `paid ${AMOUNT} to ${PARTY}` } }), `idem-${rnd()}`, co, `corr-${rnd()}`])).id;
    await one(
      `insert into financial_events (company_id, event_type, state, amount, currency, transaction_date,
                                     counterparty_name, correlation_id, risk_flags, missing_fields)
       values ($1,'expense','posted',$2,'LKR',$3,$4,$5,'{}','{}') returning id`,
      [co, AMOUNT, WHEN, PARTY, `corr-${rnd()}`]);
    return src;
  }

  async function dismiss(reviewId: string) {
    const c = await mkConn(AUTH);
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ role: "authenticated", sub: reviewer })]);
    await c.query(`select * from public.resolve_duplicate_review($1,'dismissed_distinct','two separate POs')`, [reviewId]);
    await c.query("commit");
  }

  it("pass 1 pauses it, the human releases it, and pass 2 PROCEEDS — no second pause, no dead letter", async () => {
    co = await freshCompany();
    const src = await seedSourceAndEarlier();

    const first = await processSourceEvent({ source_event_id: src, correlation_id: `c-${rnd()}` }, deps());
    expect(first.outcome, "a close resemblance must pause it the first time").toBe("awaiting_information");
    const review = (await one(`select id from duplicate_reviews where financial_event_id=$1`, [first.financial_event_id]));
    expect(review, "and raise a review a person can act on").toBeTruthy();

    await dismiss(review.id);
    expect((await one(`select state from financial_events where id=$1`, [first.financial_event_id])).state).toBe("draft");

    // THE ASSERTION THAT MATTERS. Before the fix this threw: the event, now in `draft`, was offered
    // to the scorer as a candidate against ITSELF, scored 1.0, and `openDuplicateReview` tried to
    // insert financial_event_id = matched_event_id — which 0083's `duplicate_reviews_distinct_ck`
    // rejects. The pipeline threw on every sweep and the sweeper dead-lettered the payment the
    // reviewer had just released.
    const second = await processSourceEvent({ source_event_id: src, correlation_id: `c-${rnd()}` }, deps());
    expect(second.outcome, "the release must actually release it").not.toBe("awaiting_information");

    const fe = await one(`select state from financial_events where id=$1`, [first.financial_event_id]);
    expect(fe.state, "the payment moves on to a person who can approve it").toBe("awaiting_approval");

    const approvals = await one(`select count(*)::int n from approval_requests where financial_event_id=$1`, [first.financial_event_id]);
    expect(approvals.n, "exactly one approval request — not none, not two").toBe(1);

    const reviews = await one(`select count(*)::int n from duplicate_reviews where financial_event_id=$1`, [first.financial_event_id]);
    expect(reviews.n, "no second review row is raised").toBe(1);

    // And nothing self-referential was written on the way through.
    const selfCand = await one(
      `select count(*)::int n from duplicate_candidates where financial_event_id = matched_event_id and company_id=$1`, [co]);
    expect(selfCand.n, "an event must never be recorded as a duplicate of itself").toBe(0);
  });

  it("an event is never offered to the scorer as a candidate against itself", async () => {
    // The root cause, isolated — so a regression names the cause rather than the symptom.
    co = await freshCompany();
    const src = await seedSourceAndEarlier();
    const r = await processSourceEvent({ source_event_id: src, correlation_id: `c-${rnd()}` }, deps());
    const feId = r.financial_event_id;

    const candidates = await store.recentEventsForDedup(
      co, { company_id: co, amount: AMOUNT, currency: "LKR", transaction_date: WHEN, counterparty_name: PARTY }, src);
    expect(candidates.map((c: any) => c.id), "the event under consideration must not be in its own candidate set")
      .not.toContain(feId);
  });

  it("a dismissal is NOT a blanket exemption — a NEW counterpart still pauses the payment", async () => {
    // The third test failed on its first run for exactly this reason, and the behaviour is right:
    // releasing a payment against ONE earlier transaction says nothing about a different one.
    co = await freshCompany();
    const src = await seedSourceAndEarlier();
    const first = await processSourceEvent({ source_event_id: src, correlation_id: `c-${rnd()}` }, deps());
    const review = await one(`select id from duplicate_reviews where financial_event_id=$1`, [first.financial_event_id]);
    await dismiss(review.id);

    // A DIFFERENT earlier payment appears that also resembles it.
    await one(
      `insert into financial_events (company_id, event_type, state, amount, currency, transaction_date,
                                     counterparty_name, correlation_id, risk_flags, missing_fields)
       values ($1,'expense','posted',$2,'LKR',$3,$4,$5,'{}','{}') returning id`,
      [co, AMOUNT, WHEN, PARTY, `corr-${rnd()}`]);

    const second = await processSourceEvent({ source_event_id: src, correlation_id: `c-${rnd()}` }, deps());
    expect(second.outcome, "a new resemblance must still be put to a person").toBe("awaiting_information");
    const reviews = await one(`select count(*)::int n from duplicate_reviews where financial_event_id=$1`, [first.financial_event_id]);
    expect(reviews.n, "and it is a NEW review, not the dismissed one reopened").toBe(2);
  });

  it("J-01: the SECOND layer is live — openDuplicateReview drops a self-match", async () => {
    // The first attempt at defence in depth put this guard in `findDuplicates`, which runs BEFORE
    // `createDraft` and so cannot know the financial event id. Its parameter was never passed, the
    // condition never fired, and the register described protection that did not exist. The review
    // proved it by reverting only the store filter and watching the self-referential insert happen
    // anyway.
    //
    // Here the guard is exercised DIRECTLY, by handing the port a match that points at the event
    // itself — which is what a port that forgot to filter would do. It must be dropped, not
    // written, because the database rejects a self-referential review outright and the pipeline
    // would then throw on every sweep until the sweeper dead-lettered the payment.
    co = await freshCompany();
    const src = await seedSourceAndEarlier();
    const r = await processSourceEvent({ source_event_id: src, correlation_id: `c-${rnd()}` }, deps());
    const feId = r.financial_event_id;
    const before = await one(`select count(*)::int n from duplicate_reviews where financial_event_id=$1`, [feId]);

    await store.openDuplicateReview({
      financial_event_id: feId,
      company_id: co,
      matches: [{ matched_event_id: feId, score: 1, reasons: ["self"] }],
      algorithm_version: "dup/v2-evidence-required",
    });

    const after = await one(`select count(*)::int n from duplicate_reviews where financial_event_id=$1`, [feId]);
    expect(after.n, "a self-match must be dropped, never written").toBe(before.n);
    const selfRows = await one(
      `select count(*)::int n from duplicate_reviews where financial_event_id = matched_event_id`);
    expect(selfRows.n).toBe(0);
  });

  it("a THIRD pass is still stable — the release does not decay", async () => {
    co = await freshCompany();
    const src = await seedSourceAndEarlier();
    const first = await processSourceEvent({ source_event_id: src, correlation_id: `c-${rnd()}` }, deps());
    const review = await one(`select id from duplicate_reviews where financial_event_id=$1`, [first.financial_event_id]);
    await dismiss(review.id);
    await processSourceEvent({ source_event_id: src, correlation_id: `c-${rnd()}` }, deps());
    const third = await processSourceEvent({ source_event_id: src, correlation_id: `c-${rnd()}` }, deps());
    expect(third.outcome).toBe("awaiting_approval");
    const approvals = await one(`select count(*)::int n from approval_requests where financial_event_id=$1`, [first.financial_event_id]);
    expect(approvals.n, "a retry must not add a second approval").toBe(1);
  });
});
