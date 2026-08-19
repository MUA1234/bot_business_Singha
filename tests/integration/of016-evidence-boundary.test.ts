/**
 * OF-016 correction loop 1 — the EVIDENCE boundary around a human decision (migration 0088).
 *
 * Migration 0087 got the RESOLUTION boundary right and left the evidence boundary half-built. The
 * independent review found four ways round it, all reproduced on a disposable local PostgreSQL 16
 * before being fixed. Every probe here runs as `service_role`, because that is the one api-adjacent
 * role holding DML on this table — a probe aimed at `authenticated` is stopped by the ACL and
 * proves nothing about the trigger, which is the mistake an earlier test in this package made.
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
const AUTH = `of16e_auth_${SUFFIX}`;
const SVC = `of16e_svc_${SUFFIX}`;
const conns: any[] = [];
let coA: string, coB: string, reviewer: string;

const one = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];
const failed = async (c: any, sql: string, p: any[] = []) =>
  c.query(sql, p).then(() => null).catch((e: any) => e);

async function mkConn(role?: string) {
  const { default: pg } = await import("pg" as string);
  const c = new pg.Client({
    connectionString: role ? URL.replace(/\/\/[^@]*@/, `//${role}:probe@`) : URL, ssl: mkSsl(URL),
  });
  await c.connect();
  conns.push(c);
  return c;
}

async function seed(company = coA, matchedCompany = coA) {
  const src = (await one(
    `insert into source_events (source, provider_message_id, raw_payload, idempotency_key, status,
                                dispatch_state, dispatch_outcome, company_id, correlation_id, next_attempt_at, attempts)
     values ('whatsapp',$1,'{}'::jsonb,$2,'completed','dispatched','staff_finance',$3,$4, now(), 1) returning id`,
    [`pm-${rnd()}`, `idem-${rnd()}`, company, `corr-${rnd()}`])).id;
  const earlier = (await one(
    `insert into financial_events (company_id, event_type, state, amount, currency, transaction_date,
                                   counterparty_name, purpose, correlation_id, risk_flags, missing_fields)
     values ($1,'expense','posted','5000.00','LKR','2026-08-10','Acme','supplies',$2,'{}','{}') returning id`,
    [matchedCompany, `corr-${rnd()}`])).id;
  const candidate = (await one(
    `insert into financial_events (company_id, source_event_id, event_type, state, amount, currency,
                                   transaction_date, counterparty_name, correlation_id, risk_flags, missing_fields)
     values ($1,$2,'expense','awaiting_information','5000.00','LKR','2026-08-10','Acme',$3,'{}','{}') returning id`,
    [company, src, `corr-${rnd()}`])).id;
  return { src, earlier, candidate };
}

async function openReview(company: string, candidate: string, earlier: string) {
  return (await one(
    `insert into duplicate_reviews (company_id, financial_event_id, matched_event_id, score, algorithm_version)
     values ($1,$2,$3,0.9,'dup/v2-evidence-required') returning id`, [company, candidate, earlier])).id;
}

async function resolveAs(reviewId: string, resolution: string, reason = "because") {
  const c = await mkConn(AUTH);
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ role: "authenticated", sub: reviewer })]);
  const r = (await c.query(`select * from public.resolve_duplicate_review($1,$2,$3)`, [reviewId, resolution, reason])).rows[0];
  await c.query("commit");
  return r;
}

describe.skipIf(!enabled)("OF-016 — the evidence boundary (0088)", () => {
  beforeAll(async () => {
    db = await mkConn();
    await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    for (const [n, r] of [[AUTH, "authenticated"], [SVC, "service_role"]] as const) {
      await db.query(`drop role if exists ${n}`);
      await db.query(`create role ${n} login password 'probe'`);
      await db.query(`grant ${r} to ${n}`);
    }
    coA = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16e A ${SUFFIX}`])).id;
    coB = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16e B ${SUFFIX}`])).id;
    reviewer = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [reviewer]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'of16e reviewer',true) on conflict do nothing`, [reviewer]);
    const m = await one(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [coA, reviewer]);
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'finance_reviewer')`, [m.id, coA]);
  });

  afterAll(async () => {
    for (const c of conns.slice(1)) await c.end().catch(() => {});
    for (const cid of [coA, coB]) {
      for (const sql of [
        `delete from duplicate_reviews where company_id=$1`,
        `delete from financial_events where company_id=$1`,
        `delete from source_events where company_id=$1`,
        `delete from membership_roles where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [cid]); } catch { /* noop */ } }
    }
    for (const n of [AUTH, SVC]) { try { await db.query(`drop role if exists ${n}`); } catch { /* noop */ } }
    await db.end().catch(() => {});
  });

  // ── H-02 ───────────────────────────────────────────────────────────────────────────────────
  it("H-02: service_role cannot FABRICATE a resolved review by inserting one", async () => {
    const s = await seed();
    const svc = await mkConn(SVC);
    await svc.query("begin");
    try {
      await svc.query("set local role service_role");
      const e = await failed(svc,
        `insert into duplicate_reviews (company_id, financial_event_id, matched_event_id, score,
                                        algorithm_version, state, resolution, resolved_by, resolved_at, resolution_note)
         values ($1,$2,$3,0.9,'v','resolved','dismissed_distinct',$4, now(),'FORGED — no human decided this')`,
        [coA, s.candidate, s.earlier, reviewer]);
      expect(e?.message, "a decision must be made by the person who made it")
        .toMatch(/may only be CREATED as an open suspicion/i);
    } finally { await svc.query("rollback").catch(() => {}); }

    const n = await one(`select count(*)::int n from duplicate_reviews where financial_event_id=$1`, [s.candidate]);
    expect(n.n, "nothing was written").toBe(0);
  });

  it("H-02: service_role CAN still raise an OPEN suspicion — the pipeline must keep working", async () => {
    // The boundary must not break the producer. The pipeline writes these rows as the service role.
    const s = await seed();
    const svc = await mkConn(SVC);
    await svc.query("begin");
    try {
      await svc.query("set local role service_role");
      const e = await failed(svc,
        `insert into duplicate_reviews (company_id, financial_event_id, matched_event_id, score, algorithm_version)
         values ($1,$2,$3,0.9,'dup/v2-evidence-required')`, [coA, s.candidate, s.earlier]);
      expect(e, "an open suspicion is exactly what the detector is supposed to write").toBeNull();
      await svc.query("commit");
    } catch { await svc.query("rollback").catch(() => {}); throw new Error("open insert should succeed"); }
    const row = await one(`select state, resolution from duplicate_reviews where financial_event_id=$1`, [s.candidate]);
    expect([row.state, row.resolution]).toEqual(["open", null]);
  });

  // ── H-03 ───────────────────────────────────────────────────────────────────────────────────
  it("H-03a: service_role cannot TRUNCATE the evidence table", async () => {
    const svc = await mkConn(SVC);
    await svc.query("begin");
    try {
      await svc.query("set local role service_role");
      const e = await failed(svc, `truncate duplicate_reviews`);
      // BEFORE ROW triggers do not fire for TRUNCATE — 0066 says so in as many words — so this
      // needs a statement-level guard, and before 0088 there was none.
      expect(e?.message).toMatch(/not truncatable/i);
    } finally { await svc.query("rollback").catch(() => {}); }
  });

  it("H-03b: a RESOLVED review cannot be cascaded away by deleting its financial event", async () => {
    const s = await seed();
    const rev = await openReview(coA, s.candidate, s.earlier);
    await resolveAs(rev, "confirmed_duplicate", "dupe");

    const svc = await mkConn(SVC);
    await svc.query("begin");
    try {
      await svc.query("set local role service_role");
      for (const target of [s.candidate, s.earlier]) {
        // A savepoint per probe: the first refusal aborts the transaction, so without this the
        // second probe would only ever see "current transaction is aborted" and prove nothing.
        await svc.query("savepoint p");
        const e = await failed(svc, `delete from financial_events where id=$1`, [target]);
        await svc.query("rollback to savepoint p");
        expect(e?.message, "deleting either side would erase the decision")
          .toMatch(/carries 1 resolved duplicate review/i);
      }
    } finally { await svc.query("rollback").catch(() => {}); }
    expect((await one(`select count(*)::int n from duplicate_reviews where id=$1`, [rev])).n).toBe(1);
  });

  it("H-03b: an OPEN suspicion still cascades — pre-decision cleanup keeps working", async () => {
    // The distinction that makes the guard right rather than merely strict: an unresolved
    // candidacy is not a decision, and deleting a draft event should take it along.
    const s = await seed();
    const rev = await openReview(coA, s.candidate, s.earlier);
    const svc = await mkConn(SVC);
    await svc.query("begin");
    try {
      await svc.query("set local role service_role");
      const e = await failed(svc, `delete from financial_events where id=$1`, [s.candidate]);
      expect(e, "an open suspicion must not block an authorised delete").toBeNull();
      const left = (await svc.query(`select count(*)::int n from duplicate_reviews where id=$1`, [rev])).rows[0].n;
      expect(left, "and it goes with it").toBe(0);
    } finally { await svc.query("rollback").catch(() => {}); }
  });

  // ── H-06 ───────────────────────────────────────────────────────────────────────────────────
  it("H-06: a review whose matched event belongs to ANOTHER company cannot even be written", async () => {
    const s = await seed(coA, coB);   // candidate in A, matched event in B
    const e = await failed(db,
      `insert into duplicate_reviews (company_id, financial_event_id, matched_event_id, score, algorithm_version)
       values ($1,$2,$3,0.9,'v')`, [coA, s.candidate, s.earlier]);
    // The composite FK is the structural guarantee — CLAUDE.md requires cross-company leakage to be
    // proven impossible, not merely filtered out on the way to the screen.
    expect(e?.message, "the schema itself refuses it").toMatch(/duplicate_reviews_matched_company_fk|violates foreign key/i);
  });

  it("H-06: the queue joins on the company, so a mismatched row could not render either", async () => {
    const def = (await one(
      `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='duplicate_review_queue'`)).def as string;
    expect(def).toMatch(/c\.id = r\.financial_event_id and c\.company_id = r\.company_id/);
    expect(def).toMatch(/m\.id = r\.matched_event_id\s+and m\.company_id = r\.company_id/);
  });

  // ── H-08 ───────────────────────────────────────────────────────────────────────────────────
  it("H-08: releasing an event whose source was DEAD-LETTERED clears the stamp and records it", async () => {
    const s = await seed();
    await db.query(
      `update source_events set status='dead_letter', attempts=5, dead_lettered_at=now(),
              dead_letter_reason='exhausted' where id=$1`, [s.src]);
    const rev = await openReview(coA, s.candidate, s.earlier);
    await resolveAs(rev, "dismissed_distinct", "release it");

    const src = await one(
      `select status, dead_lettered_at, dead_letter_reason, attempts from source_events where id=$1`, [s.src]);
    // Before 0088 this was `pending` while still carrying `dead_lettered_at` and
    // `dead_letter_reason='exhausted'` — a claimable row wearing a terminal stamp, a state
    // fail_source_event and complete_source_event both refuse to produce.
    expect(src.status).toBe("pending");
    expect(src.dead_lettered_at, "the terminal stamp is cleared, not left contradicting the status").toBeNull();
    expect(src.dead_letter_reason).toBeNull();
    expect(src.attempts, "history is still not reset").toBe(5);

    const au = await one(
      `select payload from audit_events where entity_id=$1 and action='finance.duplicate_review_resolved'`, [rev]);
    expect(au.payload.cleared_dead_letter, "and the trail says a dead letter was revived").toBe(true);
    expect(au.payload.prior_dead_letter_reason).toBe("exhausted");
  });

  it("H-08: a release that did NOT revive a dead letter says so honestly", async () => {
    const s = await seed();
    const rev = await openReview(coA, s.candidate, s.earlier);
    await resolveAs(rev, "dismissed_distinct", "ordinary release");
    const au = await one(
      `select payload from audit_events where entity_id=$1 and action='finance.duplicate_review_resolved'`, [rev]);
    expect(au.payload.cleared_dead_letter).toBe(false);
    expect(au.payload.prior_dead_letter_reason).toBeNull();
  });
});
