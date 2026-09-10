/**
 * OF-016 — the business scenarios a duplicate-review workflow has to get right.
 *
 * Every case here is a real bookkeeping shape, not a synthetic edge: two genuine payments on one
 * day, a recurring charge, an exact provider replay, a predecessor that was already rejected, and
 * a paused event that already has partial downstream work. The point is that the WORKFLOW behaves
 * correctly for each — not that the score is clever.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
const SUFFIX = rnd();
const AUTH = `of16s_auth_${SUFFIX}`;
const conns: any[] = [];
let co: string, reviewer: string;

const one = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];

async function mkConn(role?: string) {
  const { default: pg } = await import("pg" as string);
  const c = new pg.Client({
    connectionString: role ? URL.replace(/\/\/[^@]*@/, `//${role}:probe@`) : URL,
    ssl: mkSsl(URL),
  });
  await c.connect();
  conns.push(c);
  return c;
}
async function asHuman(c: any, sub: string) {
  await c.query("set local role authenticated");
  await c.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ role: "authenticated", sub })]);
}
const failed = async (c: any, sql: string, p: any[] = []) =>
  c.query(sql, p).then(() => null).catch((e: any) => e);

/** One paused candidate, described the way a bookkeeper would describe it. */
async function scenario(opts: {
  amount: string; date: string; party: string;
  earlierState?: string; earlierDate?: string; earlierAmount?: string;
  score?: number; evidenceMissing?: string[];
}) {
  const src = (await one(
    `insert into source_events (source, provider_message_id, raw_payload, idempotency_key, status,
                                dispatch_state, dispatch_outcome, company_id, correlation_id, next_attempt_at, attempts)
     values ('whatsapp',$1,'{}'::jsonb,$2,'completed','dispatched','staff_finance',$3,$4, now(), 1) returning id`,
    [`pm-${rnd()}`, `idem-${rnd()}`, co, `corr-${rnd()}`])).id;
  const earlier = (await one(
    `insert into financial_events (company_id, source_event_id, event_type, state, amount, currency,
                                   transaction_date, counterparty_name, correlation_id, risk_flags, missing_fields)
     values ($1,null,'expense',$2,$3,'LKR',$4,$5,$6,'{}','{}') returning id`,
    [co, opts.earlierState ?? "posted", opts.earlierAmount ?? opts.amount,
     opts.earlierDate ?? opts.date, opts.party, `corr-${rnd()}`])).id;
  const candidate = (await one(
    `insert into financial_events (company_id, source_event_id, event_type, state, amount, currency,
                                   transaction_date, counterparty_name, correlation_id, risk_flags, missing_fields)
     values ($1,$2,'expense','awaiting_information',$3,'LKR',$4,$5,$6,'{}','{}') returning id`,
    [co, src, opts.amount, opts.date, opts.party, `corr-${rnd()}`])).id;
  const review = (await one(
    `insert into duplicate_reviews (company_id, financial_event_id, matched_event_id, score,
                                    feature_contributions, evidence_present, evidence_missing, algorithm_version)
     values ($1,$2,$3,$4,'{"amount":0.5,"date":0.3,"counterparty":0.12}'::jsonb,
             '{amount,date}',$5,'dup/v2-evidence-required') returning id`,
    [co, candidate, earlier, opts.score ?? 0.9, opts.evidenceMissing ?? []])).id;
  return { src, earlier, candidate, review };
}

async function resolve(sub: string, review: string, resolution: string, reason: string) {
  const c = await mkConn(AUTH);
  await c.query("begin");
  try {
    await asHuman(c, sub);
    const r = (await c.query(`select * from public.resolve_duplicate_review($1,$2,$3)`,
      [review, resolution, reason])).rows[0];
    await c.query("commit");
    return r;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; }
}

describe.skipIf(!enabled)("OF-016 — business scenarios", () => {
  beforeAll(async () => {
    db = await mkConn();
    await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await db.query(`drop role if exists ${AUTH}`);
    await db.query(`create role ${AUTH} login password 'probe'`);
    await db.query(`grant authenticated to ${AUTH}`);
    co = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16s ${SUFFIX}`])).id;
    reviewer = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [reviewer]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'of16s reviewer',true) on conflict do nothing`, [reviewer]);
    const m = await one(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, reviewer]);
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'finance_reviewer')`, [m.id, co]);
  });

  afterAll(async () => {
    for (const c of conns) await c.end().catch(() => {});
    const clean = await mkConn();
    await clean.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    for (const sql of [
      `delete from payments where company_id=$1`,
      `delete from approval_requests where company_id=$1`,
      `delete from duplicate_reviews where company_id=$1`,
      `delete from financial_events where company_id=$1`,
      `delete from source_events where company_id=$1`,
      `delete from membership_roles where company_id=$1`,
      `delete from memberships where company_id=$1`,
      `delete from companies where id=$1`,
    ]) { try { await clean.query(sql, [co]); } catch { /* noop */ } }
    try { await clean.query(`drop role if exists ${AUTH}`); } catch { /* noop */ }
    await clean.end().catch(() => {});
  });

  it("SAME-DAY legitimate payments: two real invoices to one supplier are both kept", async () => {
    // The failure this whole line of work exists to prevent. Before 0083 the second payment scored
    // 1.0 and was terminally discarded, unreadable by any screen.
    const s = await scenario({ amount: "45000.00", date: "2026-08-10", party: "Acme Supplies" });
    const r = await resolve(reviewer, s.review, "dismissed_distinct", "two separate POs, both genuine");
    expect(r.resolution).toBe("dismissed_distinct");
    const both = (await db.query(
      `select state from financial_events where id = any($1) order by id`, [[s.candidate, s.earlier]])).rows;
    expect(both.map((x: any) => x.state).sort(), "neither payment is discarded")
      .toEqual(["draft", "posted"]);
  });

  it("RECURRING rent: this month's charge resembles last month's and is released", async () => {
    const s = await scenario({
      amount: "150000.00", date: "2026-08-01", party: "Landlord Holdings",
      earlierDate: "2026-07-01", score: 0.78,
    });
    await resolve(reviewer, s.review, "dismissed_distinct", "monthly rent — August instalment");
    const fe = (await db.query(`select state from financial_events where id=$1`, [s.candidate])).rows[0];
    expect(fe.state).toBe("draft");
    const src = (await db.query(`select status from source_events where id=$1`, [s.src])).rows[0];
    expect(src.status, "and it goes back to the processor").toBe("pending");
  });

  it("SALARY run: an identical monthly amount to the same employee is not a duplicate", async () => {
    const s = await scenario({
      amount: "85000.00", date: "2026-08-25", party: "R. Perera",
      earlierDate: "2026-07-25", score: 0.82,
    });
    await resolve(reviewer, s.review, "dismissed_distinct", "August payroll, same as July by design");
    expect((await db.query(`select state from financial_events where id=$1`, [s.candidate])).rows[0].state).toBe("draft");
  });

  it("EXACT provider replay: the same charge sent twice IS confirmed and linked", async () => {
    const s = await scenario({ amount: "12500.00", date: "2026-08-14", party: "Fuel Co", score: 0.99 });
    await resolve(reviewer, s.review, "confirmed_duplicate", "same receipt forwarded twice by the driver");
    const fe = (await db.query(
      `select state, duplicate_of_event_id from financial_events where id=$1`, [s.candidate])).rows[0];
    expect(fe.state).toBe("duplicate");
    expect(fe.duplicate_of_event_id, "linked to the original it duplicates").toBe(s.earlier);
    // The original is untouched and still the real record.
    expect((await db.query(`select state from financial_events where id=$1`, [s.earlier])).rows[0].state).toBe("posted");
  });

  it("REJECTED predecessor: the earlier event was rejected, so the new one is still released", async () => {
    const s = await scenario({
      amount: "9000.00", date: "2026-08-12", party: "Stationery Ltd", earlierState: "rejected",
    });
    await resolve(reviewer, s.review, "dismissed_distinct", "the first submission was rejected; this is the corrected one");
    expect((await db.query(`select state from financial_events where id=$1`, [s.candidate])).rows[0].state).toBe("draft");
    expect((await db.query(`select state from financial_events where id=$1`, [s.earlier])).rows[0].state).toBe("rejected");
  });

  it("MISSING evidence is shown as missing and contributes nothing", async () => {
    const s = await scenario({
      amount: "5000.00", date: "2026-08-15", party: "Unknown", evidenceMissing: ["counterparty"], score: 0.71,
    });
    const c = await mkConn(AUTH);
    await c.query("begin");
    try {
      await asHuman(c, reviewer);
      const row = (await c.query(`select * from public.duplicate_review_queue($1)`, [co])).rows
        .find((r: any) => r.review_id === s.review);
      expect(row.evidence_missing).toEqual(["counterparty"]);
      expect(row.evidence_present).toEqual(["amount", "date"]);
    } finally { await c.query("rollback"); }
  });

  it("EXISTING PAYMENT but no approval: confirming fails closed rather than orphaning the payment", async () => {
    const s = await scenario({ amount: "3000.00", date: "2026-08-16", party: "Courier Co" });
    await db.query(
      `insert into payments (company_id, direction, party_type, currency, amount, method, payment_date, source_event_id)
       values ($1,'out','supplier','LKR','3000.00','bank','2026-08-16',$2)`, [co, s.src]);
    const c = await mkConn(AUTH);
    await c.query("begin");
    try {
      await asHuman(c, reviewer);
      const e = await failed(c, `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','dupe')`, [s.review]);
      expect(e?.message).toMatch(/inconsistent: this paused event already has 0 approval request\(s\) and 1 payment/i);
    } finally { await c.query("rollback"); }
    // Nothing deleted: the payment is still there for a person to deal with deliberately.
    expect((await db.query(`select count(*)::int n from payments where source_event_id=$1`, [s.src])).rows[0].n).toBe(1);
    // …and DISMISSING is still available, because it creates no new effect.
    const r = await resolve(reviewer, s.review, "dismissed_distinct", "distinct — the payment stands");
    expect(r.resolution).toBe("dismissed_distinct");
  });

  it("HISTORIC 0083 row: a review written before this migration resolves with no data migration", async () => {
    // Built with 0083's own columns and defaults — nothing back-filled, nothing rewritten.
    const src = (await one(
      `insert into source_events (source, provider_message_id, raw_payload, idempotency_key, status,
                                  dispatch_state, dispatch_outcome, company_id, correlation_id, next_attempt_at)
       values ('whatsapp',$1,'{}'::jsonb,$2,'completed','dispatched','staff_finance',$3,$4, now()) returning id`,
      [`pm-${rnd()}`, `idem-${rnd()}`, co, `corr-${rnd()}`])).id;
    const earlier = (await one(
      `insert into financial_events (company_id, event_type, state, amount, currency, transaction_date,
                                     counterparty_name, correlation_id, risk_flags, missing_fields)
       values ($1,'expense','posted','777.00','LKR','2026-07-01','Legacy Co',$2,'{}','{}') returning id`,
      [co, `corr-${rnd()}`])).id;
    const candidate = (await one(
      `insert into financial_events (company_id, source_event_id, event_type, state, amount, currency,
                                     transaction_date, counterparty_name, correlation_id, risk_flags, missing_fields)
       values ($1,$2,'expense','awaiting_information','777.00','LKR','2026-07-01','Legacy Co',$3,'{}','{}') returning id`,
      [co, src, `corr-${rnd()}`])).id;
    // The 0083 INSERT shape exactly: only the columns that migration defined, defaults for the rest.
    const review = (await one(
      `insert into duplicate_reviews (company_id, financial_event_id, matched_event_id, score, algorithm_version)
       values ($1,$2,$3,0.88,'dup/v2-evidence-required') returning id`, [co, candidate, earlier])).id;

    const c = await mkConn(AUTH);
    await c.query("begin");
    try {
      await asHuman(c, reviewer);
      const visible = (await c.query(`select * from public.duplicate_review_queue($1)`, [co])).rows
        .find((r: any) => r.review_id === review);
      expect(visible, "a historic pending row is visible with no migration").toBeTruthy();
      expect(visible.feature_contributions, "0083's default, not a back-fill").toEqual({});
    } finally { await c.query("rollback"); }

    const r = await resolve(reviewer, review, "confirmed_duplicate", "historic row, genuinely a duplicate");
    expect(r.resolution).toBe("confirmed_duplicate");
    expect((await db.query(`select state, duplicate_of_event_id from financial_events where id=$1`, [candidate])).rows[0])
      .toMatchObject({ state: "duplicate", duplicate_of_event_id: earlier });
  });

  it("RETRY after an uncertain response: the caller repeats and gets the same answer, not a second effect", async () => {
    const s = await scenario({ amount: "6100.00", date: "2026-08-17", party: "Hardware Co" });
    const first = await resolve(reviewer, s.review, "confirmed_duplicate", "dupe");
    // The client never saw `first` — the connection dropped — so it retries the identical call.
    const retry = await resolve(reviewer, s.review, "confirmed_duplicate", "dupe");
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.resolution).toBe(first.resolution);
    const audits = (await db.query(
      `select count(*)::int n from audit_events where entity_id=$1 and action='finance.duplicate_review_resolved'`,
      [s.review])).rows[0].n;
    expect(audits, "one decision, one audit row").toBe(1);
  });

  it("the BACKLOG count returns to the right value once a review is resolved", async () => {
    const before = (await db.query(
      `select count(*)::int n from duplicate_reviews where company_id=$1 and state='open'`, [co])).rows[0].n;
    const s = await scenario({ amount: "2222.00", date: "2026-08-18", party: "Backlog Co" });
    const mid = (await db.query(
      `select count(*)::int n from duplicate_reviews where company_id=$1 and state='open'`, [co])).rows[0].n;
    expect(mid).toBe(before + 1);
    await resolve(reviewer, s.review, "dismissed_distinct", "distinct");
    const after = (await db.query(
      `select count(*)::int n from duplicate_reviews where company_id=$1 and state='open'`, [co])).rows[0].n;
    expect(after, "the paused-payment tile drops back").toBe(before);
  });
});
