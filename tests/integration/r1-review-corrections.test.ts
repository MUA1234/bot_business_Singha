/**
 * R1 correction loop 1 — the findings an independent adversarial review of the remediation package
 * returned, each reproduced here BEFORE it was fixed.
 *
 * The two that matter most are both consequences of building a package in sections and not
 * re-checking the earlier ones after the later ones changed shared state:
 *
 *   * §3 built the scheduled drain against the message shape §1 stored. §6 then changed that shape
 *     to Meta's raw message — where `text` is `{ body }`, not a string — and the drain kept reading
 *     it as a string. Every message the drain retried was re-dispatched with its body replaced by
 *     "[object Object]", and the drain reported success. Worse, `record_inbound_dispatch` then
 *     OVERWROTE a committed `staff_finance` outcome with `manual_review`.
 *   * §4 wired a RETRYING caller to `processSourceEvent`, whose own contract says idempotency is
 *     guaranteed upstream by the Inngest function key. It is not guaranteed for the sweeper, and
 *     `createDraft` is an unconditional insert, so any failure after the draft duplicated the
 *     financial event.
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

const H: { sb: any; enqueued: any[]; extraction: Record<string, unknown> | null } =
  { sb: null, enqueued: [], extraction: null };

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
      return { text: JSON.stringify(H.extraction ?? {}), usage: { input_tokens: 5, output_tokens: 5 }, cost_usd: "0.000100" };
    },
  }),
}));

import { pgSupabase } from "./helpers/pg-supabase";
import { whatsappAdapter } from "@/lib/inbound/adapters/whatsapp";
import { recordInboundReceipt } from "@/lib/inbound/receipt";
import { sha256 } from "@/lib/ids";
import { newCorrelationId } from "@/lib/log";

let db: any;
let co: string;
const ACCOUNT = `wa_rc_${rnd()}`;
const STAFF = "94770001234";

const envelope = (from: string, text: string, msgId: string) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "1", phone_number_id: ACCOUNT },
    messages: [{ from, id: msgId, timestamp: "1755500000", type: "text", text: { body: text } }],
  } }] }],
});

/** Persist exactly as the production webhook does — through the adapter. */
async function receiptFor(text: string, msgId = `wamid.${rnd()}`) {
  const m = whatsappAdapter.parse(envelope(STAFF, text, msgId), newCorrelationId)[0]!;
  return recordInboundReceipt(H.sb, {
    source: m.channel,
    providerAccountId: m.providerAccountId,
    providerMessageId: m.providerMessageId,
    rawPayload: m.raw,
    contentHash: sha256(m.text),
    correlationId: m.correlationId,
  });
}

async function runDrain() {
  const { GET } = await import("@/app/api/cron/dispatch-drain/route");
  const res = await GET(new Request("http://x/api/cron/dispatch-drain", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }));
  return { status: res.status, body: await res.json() };
}
async function runSweeper() {
  const { GET } = await import("@/app/api/cron/inbound-sweeper/route");
  const res = await GET(new Request("http://x/api/cron/inbound-sweeper", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }));
  return { status: res.status, body: await res.json() };
}

const row = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];

const EXTRACTION = (companyId: string) => ({
  schema_version: "1.0", event_type: "expense_payment", company_candidate_id: companyId,
  division_candidate_id: null, project_candidate_id: null, site_candidate_id: null,
  transaction_date: "2026-08-01", amount: "45000.00", currency: "LKR",
  counterparty_name: "Acme Cement", counterparty_candidate_id: null, purpose: "cement",
  payment_method: "company_bank", paid_by_employee_id: null, suggested_account_code: null,
  tax_code: null, evidence_document_ids: ["rc-receipt"], conversation_reference_ids: [],
  is_reimbursement_expected: false, allocations: [], missing_fields: [], risk_flags: [],
  confidence: { overall: 0.9 }, recommended_action: "create_draft",
});

describe.skipIf(!enabled)("R1 correction loop 1 (disposable local PostgreSQL)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    H.sb = pgSupabase(db);
    process.env.CRON_SECRET = `rc_${rnd()}`;
    process.env.OPENAI_API_KEY = "rc-fixture";

    co = (await row(`insert into companies (name, base_currency) values ('r1corr','LKR') returning id`)).id;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [co, ACCOUNT]);
    const u = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [u]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'rc staff',true) on conflict do nothing`, [u]);
    await db.query(
      `insert into channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
       values ($1,'whatsapp',$2,'staff',$3,'rc staff')`, [co, STAFF, u]);
    H.extraction = EXTRACTION(co);
  });

  afterAll(async () => {
    for (const sql of [
      `delete from audit_events where company_id=$1`,
      `delete from approval_requests where company_id=$1`,
      `delete from policy_evaluations where company_id=$1`,
      `delete from duplicate_candidates where company_id=$1`,
      `delete from financial_event_versions where company_id=$1`,
      `delete from financial_events where company_id=$1`,
      `delete from inbound_reviews where company_id=$1`,
      `delete from ai_runs where company_id=$1`,
      `delete from source_events where company_id=$1`,
      `delete from task_routing_events where company_id=$1`,
      `delete from task_routing where company_id=$1`,
      `delete from tasks where company_id=$1`,
      `delete from channel_identities where company_id=$1`,
      `delete from channel_accounts where company_id=$1`,
      `delete from companies where id=$1`,
    ]) { try { await db.query(sql, [co]); } catch { /* noop */ } }
    await db?.end().catch(() => {});
  });

  // ── R-01 ──────────────────────────────────────────────────────────────────────────────────────
  it("R-01: the SCHEDULED DRAIN reads the stored message with its real body, not '[object Object]'", async () => {
    const TEXT = "paid LKR 45,000 to Acme Cement for the site";
    const r = await receiptFor(TEXT);
    const drain = await runDrain();
    expect(drain.status).toBe(200);

    // The body reached the dispatcher intact, so identity + classification saw the real message.
    const review = await row(`select body_excerpt, reason_code from inbound_reviews where source_event_id=$1`, [r.event.id]);
    if (review) expect(review.body_excerpt).toBe(TEXT);

    // Nothing anywhere stores the stringified object.
    const corrupted = await row(
      `select count(*)::int as n from inbound_reviews where company_id=$1 and body_excerpt like '%[object Object]%'`, [co]);
    expect(corrupted.n).toBe(0);
  });

  it("R-01b: the drain re-reads a stored message as EXACTLY what the webhook parsed", async () => {
    // This is the property that makes the two paths agree. It is not "both reach staff_finance":
    // production's `classifyFinanceIntent` returns null (owner gate OF-003), so the drain reaches
    // manual_review by design. What must hold is that the drain sees the SAME message — before the
    // fix it saw `text: "[object Object]"`, and a different message can only be decided differently.
    const TEXT = "paid LKR 4,200 to Lanka Hardware for nails";
    const msgId = `wamid.${rnd()}`;
    const parsed = whatsappAdapter.parse(envelope(STAFF, TEXT, msgId), newCorrelationId)[0]!;
    const reread = whatsappAdapter.fromStored(parsed.raw, parsed.providerAccountId, parsed.correlationId);
    expect(reread).toBeTruthy();
    expect(reread!.text).toBe(parsed.text);
    expect(reread!.from).toBe(parsed.from);
    expect(reread!.providerMessageId).toBe(parsed.providerMessageId);
    expect(reread!.providerAccountId).toBe(parsed.providerAccountId);
    expect(reread!.mediaRefs).toEqual(parsed.mediaRefs);
  });

  it("R-01c: a COMMITTED dispatch outcome is never rewritten by a later, different decision", async () => {
    const r = await receiptFor("paid LKR 4,200 to Lanka Hardware for nails");
    await db.query(`select public.claim_inbound_dispatch($1,'w1',120)`, [r.event.id]);
    await db.query(`select * from public.record_inbound_dispatch($1,'w1','staff_finance',$2,null,null)`, [r.event.id, co]);
    await expect(db.query(`select * from public.record_inbound_dispatch($1,'w2','manual_review',$2,null,null)`, [r.event.id, co]))
      .rejects.toThrow(/already dispatched as staff_finance/);
    const after = await row(`select dispatch_outcome from source_events where id=$1`, [r.event.id]);
    expect(after.dispatch_outcome).toBe("staff_finance");
  });

  it("R-10: a receipt from a source with NO adapter is failed, not dispatched as WhatsApp", async () => {
    const r = await db.query(
      `insert into source_events (source, provider_message_id, raw_payload, idempotency_key, correlation_id, provider_account_id, event_identity)
       values ('upload', $1, '{"note":"a bank file row"}'::jsonb, $2, $3, $4, $5) returning id`,
      [`up_${rnd()}`, `idem_${rnd()}`, `cor_${rnd()}`, ACCOUNT, `ev1:upload:${rnd()}`]);
    const id = r.rows[0].id;
    await runDrain();
    const after = await row(`select dispatch_state, last_error_code, company_id from source_events where id=$1`, [id]);
    expect(after.dispatch_state).toBe("failed");
    expect(after.last_error_code).toBe("no_adapter");
    expect(after.company_id).toBeNull();   // never attributed to the WhatsApp account's company
    await db.query(`delete from source_events where id=$1`, [id]);
  });

  // ── R-02 ──────────────────────────────────────────────────────────────────────────────────────
  it("R-02: a RETRIED capture produces exactly ONE financial event, never a second draft", async () => {
    const r = await receiptFor("paid LKR 45,000 to Acme Cement, bill attached");
    await db.query(
      `update source_events set dispatch_state='dispatched', dispatch_outcome='staff_finance',
              company_id=$2, status='pending', next_attempt_at=now() - interval '1 minute' where id=$1`,
      [r.event.id, co]);

    // Fail AFTER the draft exists — exactly the shape OF-013 had, and the shape any downstream
    // failure has. Then let the retry succeed.
    await db.query(`create or replace function public._rc_fail() returns trigger language plpgsql as $$
                    begin raise exception 'rc: downstream failure after the draft'; end $$`);
    await db.query(`create trigger _rc_fail_trg before insert on approval_requests
                    for each row execute function public._rc_fail()`);
    const failed = await runSweeper();
    expect(failed.status).toBe(200);
    const afterFail = await row(`select count(*)::int as n from financial_events where source_event_id=$1`, [r.event.id]);

    await db.query(`drop trigger _rc_fail_trg on approval_requests`);
    await db.query(`drop function public._rc_fail()`);
    await db.query(`update source_events set next_attempt_at=now() - interval '1 minute' where id=$1`, [r.event.id]);
    await runSweeper();

    const total = await row(`select count(*)::int as n from financial_events where source_event_id=$1`, [r.event.id]);
    expect(total.n).toBe(1);
    expect(afterFail.n).toBeLessThanOrEqual(1);
    const versions = await row(`select count(*)::int as n from financial_event_versions
                                 where financial_event_id in (select id from financial_events where source_event_id=$1)`, [r.event.id]);
    expect(versions.n).toBe(1);
  });

  it("R-02b: the database REFUSES a second drafted financial event for one source event", async () => {
    const r = await receiptFor("paid LKR 1,000 for tea");
    await db.query(
      `insert into financial_events (company_id, source_event_id, event_type, state, currency, current_version, correlation_id)
       values ($1,$2,'expense_payment','detected','LKR',1,'rc1')`, [co, r.event.id]);
    await expect(db.query(
      `insert into financial_events (company_id, source_event_id, event_type, state, currency, current_version, correlation_id)
       values ($1,$2,'expense_payment','detected','LKR',1,'rc2')`, [co, r.event.id])).rejects.toThrow();
  });

  // ── R-03 ──────────────────────────────────────────────────────────────────────────────────────
  it("R-03: an automated caller cannot DEACTIVATE or DELETE a human routing decision to get past it", async () => {
    const t = (await row(`insert into tasks (company_id, title, status) values ($1,'rc routing','captured') returning id`, [co])).id;
    const person = randomUUID();
    // The standing HUMAN decision, written as the trusted owner — that is the whole point: a
    // decision a person made, which an automated caller must not be able to step around.
    await db.query(`insert into task_routing (company_id, task_id, routing_state, reason_code, assignee_id, decided_by, decided_by_source)
                    values ($1,$2,'assigned','assigned_by_person',$3,$3,'human')`, [co, t, person]);
    const human = await row(`select id, decided_by_source, is_active from task_routing where task_id=$1 and is_active`, [t]);
    expect(human.decided_by_source).toBe("human");

    // AS service_role — NOT as this connection's own role. This connection is the table owner, for
    // which the positive owner allowlist legitimately returns true, so probing as itself would
    // prove nothing about what a caller can do. (An earlier draft of this very test made that
    // mistake, which is the same one the review found in the extreme suite.)
    for (const sql of [
      `update task_routing set is_active=false where id=$1`,
      `update task_routing set superseded_by=$1 where id=$1`,
      `delete from task_routing where id=$1`,
    ]) {
      await db.query("begin");
      try {
        await db.query("set local role service_role");
        await expect(db.query(sql, [human.id]), sql).rejects.toThrow(/routing boundary|not deletable/i);
      } finally { await db.query("rollback"); }
    }

    // TRUNCATE bypasses row triggers entirely, so it has its own statement-level refusal.
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      // (A foreign key from task_routing_events refuses it first; the statement trigger is the
      // backstop for when nothing references the row.)
      await expect(db.query(`truncate table task_routing`))
        .rejects.toThrow(/cannot be truncated|permission denied|referenced in a foreign key/i);
    } finally { await db.query("rollback"); }

    const still = await row(`select is_active, decided_by_source from task_routing where id=$1`, [human.id]);
    expect(still.is_active).toBe(true);
    expect(still.decided_by_source).toBe("human");

    // …and the AI path still refuses to supersede it, which is the outcome the deactivation was a
    // way around.
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
      const r = await db.query(
        `select routing_state from public.route_task_as_ai($1,$2,'needs_routing','automation tried','rc','m','rc/v1')`, [co, t]);
      // The standing human assignment is returned unchanged rather than replaced.
      expect(r.rows[0].routing_state).toBe("assigned");
    } finally { await db.query("rollback"); }
  });

  // ── R-04 ──────────────────────────────────────────────────────────────────────────────────────
  it("R-04: the test harness binds an array filter as an ARRAY, so duplicate scoring is not silently dead", async () => {
    const notIn = await H.sb.from("financial_events").select("id")
      .not("state", "in", "(rejected,cancelled,duplicate,reversed,superseded)").eq("company_id", co);
    expect(notIn.error).toBeNull();
    const isIn = await H.sb.from("financial_events").select("id").in("state", ["detected", "draft"]).eq("company_id", co);
    expect(isIn.error).toBeNull();
  });

  it("R-04b: two identical captures produce a DUPLICATE CANDIDATE rather than two silent drafts", async () => {
    const mk = async (n: number) => {
      const r = await receiptFor(`paid LKR 45,000 to Acme Cement for cement #${n}`);
      await db.query(
        `update source_events set dispatch_state='dispatched', dispatch_outcome='staff_finance',
                company_id=$2, status='pending', next_attempt_at=now() - interval '1 minute' where id=$1`,
        [r.event.id, co]);
      return r;
    };
    const a = await mk(1);
    await runSweeper();
    const b = await mk(2);
    await runSweeper();

    const feB = await row(`select id, state from financial_events where source_event_id=$1`, [b.event.id]);
    expect(feB).toBeTruthy();
    const cand = await row(
      `select count(*)::int as n from duplicate_candidates where financial_event_id=$1`, [feB.id]);
    expect(cand.n).toBeGreaterThan(0);
    expect(a.event.id).not.toBe(b.event.id);
  });

  // ── R-05 ──────────────────────────────────────────────────────────────────────────────────────
  it("R-05: the adapter's parse is TOTAL — a malformed container never throws away its siblings", () => {
    const good = (id: string) => ({ from: "94770000001", id, timestamp: "1755500000", type: "text", text: { body: "hi" } });
    const batch = {
      entry: [
        { changes: [{ value: { metadata: { phone_number_id: ACCOUNT }, messages: [good("wamid.a")] } }] },
        { changes: { not: "an array" } },
        { changes: [{ value: { metadata: { phone_number_id: ACCOUNT }, messages: [null, good("wamid.c")] } }] },
      ],
    };
    const out = whatsappAdapter.parse(batch, newCorrelationId);
    expect(out.map((m) => m.providerMessageId).sort()).toEqual(["wamid.a", "wamid.c"]);
    for (const bad of [{ entry: { not: "an array" } }, { entry: [{ changes: [{ value: { messages: 42 } }] }] }]) {
      expect(() => whatsappAdapter.parse(bad, newCorrelationId)).not.toThrow();
    }
  });

  it("R-07: the LAST holder of company administration cannot be revoked away", async () => {
    const mk = async (name: string) => {
      const id = randomUUID();
      await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [id]);
      await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict do nothing`, [id, name]);
      const m = (await row(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, id])).id;
      return { id, m };
    };
    const sysadmin = await mk("rc sysadmin");
    const owner = await mk("rc owner");
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'system_administrator')`, [sysadmin.m, co]);
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [owner.m, co]);

    // The only holder of owner_management cannot be stripped of it — the company would be left with
    // nobody able to appoint anyone.
    await expect(db.query(
      `select * from public.admin_set_membership_role($1,$2,'owner_management',false,$3)`, [co, owner.id, sysadmin.id]))
      .rejects.toThrow(/last holder of owner_management/);

    // With a second holder, revoking the first is allowed again.
    const second = await mk("rc second owner");
    await db.query(`select * from public.admin_set_membership_role($1,$2,'owner_management',true,$3)`, [co, second.id, sysadmin.id]);
    await db.query(`select * from public.admin_set_membership_role($1,$2,'owner_management',false,$3)`, [co, owner.id, sysadmin.id]);
    const left = await row(`select count(*)::int as n from membership_roles where company_id=$1 and role_key='owner_management'`, [co]);
    expect(left.n).toBe(1);

    for (const x of [sysadmin, owner, second]) {
      await db.query(`delete from membership_roles where membership_id=$1`, [x.m]);
      await db.query(`delete from memberships where id=$1`, [x.m]);
      await db.query(`delete from users where id=$1`, [x.id]).catch(() => {});
    }
  });

  it("R-11: the harness refuses what it cannot faithfully reproduce, rather than running different SQL", async () => {
    // An embedded PostgREST projection means a JOIN this shim does not build.
    expect(() => H.sb.from("membership_roles").select("role_key, memberships!inner(user_id)"))
      .toThrow(/embedded select is not supported/);
    // An UPDATE with no filter is never what a caller meant.
    const res = await H.sb.from("source_events").update({ status: "processed" });
    expect(res.error?.message ?? "").toMatch(/refusing an UPDATE with no filter/);
  });

  it("R-14: an image CAPTION is the message text, not an empty string", () => {
    const payload = {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: ACCOUNT },
        messages: [{ from: STAFF, id: `wamid.${rnd()}`, timestamp: "1755500000", type: "image",
                     image: { id: "media1", mime_type: "image/jpeg", caption: "paid LKR 90,000 to Acme, receipt attached" } }],
      } }] }],
    };
    const out = whatsappAdapter.parse(payload, newCorrelationId);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("paid LKR 90,000 to Acme, receipt attached");
    expect(out[0]!.mediaRefs[0]!.providerMediaId).toBe("media1");
  });
});
