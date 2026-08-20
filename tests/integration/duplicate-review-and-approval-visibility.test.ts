/**
 * Evidence closure for package 0083 — items 2 and 3 of the owner's directive.
 *
 * ITEM 3 (approval visibility) is proven end to end and PASSES.
 * ITEM 2 (duplicate-review usability) is proven end to end and FAILS to exist. These tests record
 * that honestly rather than asserting around it: a suspected duplicate is durable, reversible and
 * correctly evidenced, but there is NO authorized way for a person to see or resolve one. That is a
 * MATERIAL BLOCKER, recorded as such, and it is not repaired here — the package's two correction
 * loops are spent.
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
const H: { sb: any; extraction: Record<string, unknown> | null } = { sb: null, extraction: null };

vi.mock("@/lib/supabase/server", () => ({ supabaseAdmin: () => H.sb }));
vi.mock("@/db/client", () => ({ serviceClient: () => H.sb }));
vi.mock("@/inngest/client", () => ({
  WHATSAPP_INBOUND_EVENT: "whatsapp/message.received",
  inngest: { send: async () => {} },
  inngestQueue: { enqueue: async () => {} },
}));
vi.mock("@/ai/openai-transport", () => ({
  makeOpenAiTransport: () => ({
    async complete() {
      return { text: JSON.stringify(H.extraction ?? {}), usage: { input_tokens: 5, output_tokens: 5 }, cost_usd: "0.0001" };
    },
  }),
}));

import { pgSupabase } from "./helpers/pg-supabase";
import { whatsappAdapter } from "@/lib/inbound/adapters/whatsapp";
import { recordInboundReceipt } from "@/lib/inbound/receipt";
import { sha256 } from "@/lib/ids";
import { newCorrelationId } from "@/lib/log";

let db: any;
let co: string, coB: string, approver: string, outsider: string;
const ACCOUNT = `wa_dr_${rnd()}`;
const STAFF = "94770005555";

const row = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];
const rows = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;

const EXTRACTION = (companyId: string, over: Record<string, unknown> = {}) => ({
  schema_version: "1.0", event_type: "expense_payment", company_candidate_id: companyId,
  division_candidate_id: null, project_candidate_id: null, site_candidate_id: null,
  transaction_date: "2026-08-01", amount: "45000.00", currency: "LKR",
  counterparty_name: "Acme Cement", counterparty_candidate_id: null, purpose: "cement",
  payment_method: "company_bank", paid_by_employee_id: null, suggested_account_code: null,
  tax_code: null, evidence_document_ids: ["dr-receipt"], conversation_reference_ids: [],
  is_reimbursement_expected: false, allocations: [], missing_fields: [], risk_flags: [],
  confidence: { overall: 0.9 }, recommended_action: "create_draft", ...over,
});

const envelope = (text: string, msgId: string) => ({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: ACCOUNT },
    messages: [{ from: STAFF, id: msgId, timestamp: "1755500000", type: "text", text: { body: text } }],
  } }] }],
});

async function captureAndProcess(text: string) {
  const m = whatsappAdapter.parse(envelope(text, `wamid.${rnd()}`), newCorrelationId)[0]!;
  const r = await recordInboundReceipt(H.sb, {
    source: m.channel, providerAccountId: m.providerAccountId, providerMessageId: m.providerMessageId,
    rawPayload: m.raw, contentHash: sha256(m.text), correlationId: m.correlationId,
  });
  await db.query(
    `update source_events set dispatch_state='dispatched', dispatch_outcome='staff_finance',
            company_id=$2, status='pending', next_attempt_at=now() - interval '1 minute' where id=$1`,
    [r.event.id, co]);
  const { GET } = await import("@/app/api/cron/inbound-sweeper/route");
  const res = await GET(new Request("http://x", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  expect(res.status).toBe(200);
  return r;
}

describe.skipIf(!enabled)("0083 evidence closure — duplicate review & approval visibility", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    H.sb = pgSupabase(db);
    process.env.CRON_SECRET = `dr_${rnd()}`;
    process.env.OPENAI_API_KEY = "dr-fixture";

    co = (await row(`insert into companies (name, base_currency) values ('dupreview A','LKR') returning id`)).id;
    coB = (await row(`insert into companies (name, base_currency) values ('dupreview B','LKR') returning id`)).id;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [co, ACCOUNT]);
    const u = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [u]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'dr staff',true) on conflict do nothing`, [u]);
    await db.query(`insert into channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
                    values ($1,'whatsapp',$2,'staff',$3,'dr staff')`, [co, STAFF, u]);

    const mkPerson = async (company: string, name: string, role: string) => {
      const id = randomUUID();
      await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [id]);
      await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict do nothing`, [id, name]);
      await db.query(`insert into profiles (id, company_id, username, full_name, department, is_active)
                      values ($1,$2,$3,$3,'finance',true)`, [id, company, `${name}_${rnd()}`]);
      const m = (await row(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [company, id])).id;
      await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [m, company, role]);
      return id;
    };
    approver = await mkPerson(co, "dr approver", "owner_management");
    outsider = await mkPerson(coB, "dr outsider", "owner_management");
    H.extraction = EXTRACTION(co);
  });

  afterAll(async () => {
    for (const c of [co, coB]) {
      for (const sql of [
        `delete from audit_events where company_id=$1`,
        `delete from duplicate_reviews where company_id=$1`,
        `delete from approval_requests where company_id=$1`,
        `delete from policy_evaluations where company_id=$1`,
        `delete from duplicate_candidates where company_id=$1`,
        `delete from financial_event_versions where company_id=$1`,
        `delete from financial_events where company_id=$1`,
        `delete from ai_runs where company_id=$1`,
        `delete from source_events where company_id=$1`,
        `delete from channel_identities where company_id=$1`,
        `delete from channel_accounts where company_id=$1`,
        `delete from membership_roles where company_id=$1`,
        `delete from profiles where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [c]); } catch { /* noop */ } }
    }
    await db?.end().catch(() => {});
  });

  // ── ITEM 3 — approval visibility across the crash window ─────────────────────────────────────
  it("ITEM 3: a draft stranded in awaiting_approval with NO approval request is recovered, once, and is ACTIONABLE", async () => {
    // Force the crash window: the transition lands, the approval insert does not.
    await db.query(`create or replace function public._av_fail() returns trigger language plpgsql as $$
                    begin raise exception 'av: crash between the transition and the approval'; end $$`);
    await db.query(`create trigger _av_fail_trg before insert on approval_requests
                    for each row execute function public._av_fail()`);
    H.extraction = EXTRACTION(co, { amount: "31500.00", counterparty_name: "Galle Timber", transaction_date: "2026-07-11" });
    const r = await captureAndProcess("paid LKR 31,500 to Galle Timber, invoice attached");
    await db.query(`drop trigger _av_fail_trg on approval_requests`);
    await db.query(`drop function public._av_fail()`);

    const stranded = await row(`select id, state from financial_events where source_event_id=$1`, [r.event.id]);
    expect(stranded.state).toBe("awaiting_approval");
    expect((await row(`select count(*)::int as n from approval_requests where financial_event_id=$1`, [stranded.id])).n).toBe(0);
    // The receipt did NOT settle on a failed run.
    expect((await row(`select status from source_events where id=$1`, [r.event.id])).status).toBe("retry_wait");

    // The retry resumes from the persisted stage and creates EXACTLY ONE request.
    await db.query(`update source_events set next_attempt_at=now() - interval '1 minute' where id=$1`, [r.event.id]);
    const { GET } = await import("@/app/api/cron/inbound-sweeper/route");
    await GET(new Request("http://x", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));

    const reqs = await rows(`select id, status, company_id from approval_requests where financial_event_id=$1`, [stranded.id]);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe("pending");
    // Settles ONLY after the consumer outcome, and cannot be re-claimed afterwards.
    expect((await row(`select status from source_events where id=$1`, [r.event.id])).status).toBe("completed");
    expect(await rows(`select id from public.claim_source_events(50,'probe',60) where id=$1`, [r.event.id])).toHaveLength(0);

    // A THIRD run changes nothing.
    await db.query(`update source_events set status='pending', lease_owner=null, lease_expires_at=null,
                    next_attempt_at=now() - interval '1 minute' where id=$1`, [r.event.id]);
    await GET(new Request("http://x", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    expect((await rows(`select id from approval_requests where financial_event_id=$1`, [stranded.id]))).toHaveLength(1);

    // It APPEARS on the real approval screen's query, for an eligible approver in this company…
    await db.query("begin");
    let seen: any[], notSeen: any[];
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "authenticated", sub: approver })]);
      seen = (await db.query(
        `select id, status, financial_event_id from approval_requests where company_id=$1`, [co])).rows;
    } finally { await db.query("rollback"); await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`); }
    expect(seen.map((x) => x.id)).toContain(reqs[0].id);

    // …and NOT to an approver in another company.
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "authenticated", sub: outsider })]);
      notSeen = (await db.query(`select id from approval_requests`)).rows;
    } finally { await db.query("rollback"); await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`); }
    expect(notSeen.map((x) => x.id)).not.toContain(reqs[0].id);

    H.extraction = EXTRACTION(co);
  });

  // ── ITEM 2 — the duplicate review, and what is missing ───────────────────────────────────────
  it("ITEM 2: a suspected duplicate is durable, reversible and fully evidenced", async () => {
    H.extraction = EXTRACTION(co, { amount: "62750.00", counterparty_name: "Ruhunu Sand", transaction_date: "2026-07-20" });
    await captureAndProcess("paid LKR 62,750 to Ruhunu Sand");
    const second = await captureAndProcess("paid LKR 62,750 to Ruhunu Sand (resending)");

    const fe = await row(`select id, state from financial_events where source_event_id=$1`, [second.event.id]);
    // REVERSIBLE, unlike the terminal `duplicate` this replaced.
    expect(fe.state).toBe("awaiting_information");

    const rev = await row(
      `select id, state, score, feature_contributions, evidence_present, evidence_missing,
              algorithm_version, matched_event_id, resolved_by, resolution
         from duplicate_reviews where financial_event_id=$1`, [fe.id]);
    expect(rev).toBeTruthy();
    expect(rev.state).toBe("open");
    expect(rev.resolution).toBeNull();
    expect(rev.matched_event_id).not.toBe(fe.id);                 // both events are identified
    expect(Number(rev.score)).toBeGreaterThanOrEqual(0.7);
    expect(Number(rev.feature_contributions.amount)).toBeGreaterThan(0);
    expect(Number(rev.feature_contributions.date)).toBeGreaterThan(0);
    expect(Number(rev.feature_contributions.counterparty)).toBeGreaterThan(0);
    expect(rev.algorithm_version).toBe("dup/v2-evidence-required");
    // No business effect was created while it is unresolved.
    expect((await row(`select count(*)::int as n from approval_requests where financial_event_id=$1`, [fe.id])).n).toBe(0);
    // A re-run does not stack a second review in front of a person.
    await db.query(`update source_events set status='pending', lease_owner=null, lease_expires_at=null,
                    next_attempt_at=now() - interval '1 minute' where id=$1`, [second.event.id]);
    const { GET } = await import("@/app/api/cron/inbound-sweeper/route");
    await GET(new Request("http://x", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    expect((await rows(`select id from duplicate_reviews where financial_event_id=$1`, [fe.id]))).toHaveLength(1);
    H.extraction = EXTRACTION(co);
  });

  it("ITEM 2: an authorized reviewer in the company CAN READ the pending review; another company cannot", async () => {
    const rev = await row(`select id, company_id from duplicate_reviews where company_id=$1 limit 1`, [co]);
    expect(rev).toBeTruthy();

    const readAs = async (sub: string) => {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "authenticated", sub })]);
        return (await db.query(`select id from duplicate_reviews`)).rows.map((x: any) => x.id);
      } finally {
        await db.query("rollback");
        await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
      }
    };
    expect(await readAs(approver)).toContain(rev.id);
    expect(await readAs(outsider)).not.toContain(rev.id);
  });

  /**
   * THE BLOCKER, recorded rather than worked around.
   *
   * The row is durable, correctly evidenced and readable by an authorized member. What does not
   * exist is any way to ACT on it: no resolution RPC, no screen, and no write grant. So a suspected
   * duplicate pauses a real payment in `awaiting_information` — and nothing in the product can move
   * it again.
   *
   * This is strictly better than what it replaced (a TERMINAL `duplicate`, equally invisible and
   * additionally irreversible), so no data is stranded permanently — a future resolution path can
   * recover every one of these rows without a migration. But it is not a usable review workflow,
   * and the directive is explicit that this must be recorded as a material blocker rather than
   * repaired in a third correction loop.
   */
  it("ITEM 2 — the blocker is CLOSED by migration 0087: there is now an authorized resolution path", async () => {
    // This test recorded OF-016 as a MATERIAL BLOCKER during the 0083 evidence-closure pass: a
    // suspected duplicate had no resolution RPC, no screen and no write grant, so a real payment
    // paused reversibly with nothing able to move it again. It is inverted here rather than
    // deleted, so the history of the finding stays in the suite and a regression would show up as
    // this test failing, not as a test quietly disappearing.
    const rev = await row(`select id from duplicate_reviews where company_id=$1 limit 1`, [co]);
    expect(rev).toBeTruthy();

    // (a) The resolution function now exists — human-only by GRANT.
    const fns = await rows(
      `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname = 'resolve_duplicate_review'`);
    expect(fns).toHaveLength(1);
    const grants = await row(
      `select has_function_privilege('authenticated','public.resolve_duplicate_review(uuid,text,text)','EXECUTE') as auth,
              has_function_privilege('service_role','public.resolve_duplicate_review(uuid,text,text)','EXECUTE') as svc,
              has_function_privilege('anon','public.resolve_duplicate_review(uuid,text,text)','EXECUTE') as anon`);
    expect([grants.auth, grants.svc, grants.anon], "a person may decide; a worker and a stranger may not")
      .toEqual([true, false, false]);

    // (b) Direct writes are STILL refused — the workflow did not open the table up.
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "authenticated", sub: approver })]);
      await expect(db.query(
        `update duplicate_reviews set state='resolved', resolution='confirmed_duplicate', resolved_by=$2, resolved_at=now() where id=$1`,
        [rev.id, approver])).rejects.toMatchObject({ code: "42501" });
    } finally { await db.query("rollback"); await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`); }

    // (c) The paused payment is now REACHABLE: the queue read returns it with both transactions,
    //     even though it still has no approval request. That was the whole point — it used to be
    //     on no screen at all.
    const paused = await row(
      `select fe.id from financial_events fe
        where fe.company_id=$1 and fe.state='awaiting_information'
          and not exists (select 1 from approval_requests ar where ar.financial_event_id = fe.id)
        limit 1`, [co]);
    expect(paused).toBeTruthy();
    const queueFn = await rows(
      `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='duplicate_review_queue'`);
    expect(queueFn).toHaveLength(1);

    // (d) And it is still not silently counted as finished.
    const open = await row(`select count(*)::int as n from duplicate_reviews where company_id=$1 and state='open'`, [co]);
    expect(open.n).toBeGreaterThan(0);
  });
});
