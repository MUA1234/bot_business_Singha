/**
 * OF-016 correction loop 2 — the two ways the package still stranded work (migration 0089).
 *
 * J-02: the detector writes ONE review per match, so a payment resembling TWO earlier ones raises
 * two open reviews. Confirming one moved the event to `duplicate`, which is terminal — and the
 * sibling was then resolvable in NEITHER direction, by nobody, forever. That is the "no way out"
 * this whole package exists to close, re-created one layer up, and untested because every earlier
 * test seeded exactly one review per event.
 *
 * J-03: a released payment kept its spent `attempts`, so one ordinary provider error dead-lettered
 * it again — with no second release, because a replay returns the standing decision before
 * re-arming anything.
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
const AUTH = `of16s2_${SUFFIX}`;
const conns: any[] = [];
let co: string, reviewer: string;

const one = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];
const rows = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;

async function mkConn(role?: string) {
  const { default: pg } = await import("pg" as string);
  const c = new pg.Client({
    connectionString: role ? URL.replace(/\/\/[^@]*@/, `//${role}:probe@`) : URL, ssl: mkSsl(URL),
  });
  await c.connect();
  conns.push(c);
  return c;
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

/** One paused payment that resembles `n` earlier ones — so it raises `n` open reviews. */
async function seedMulti(n: number, opts: { attempts?: number; deadLettered?: boolean } = {}) {
  const src = (await one(
    `insert into source_events (source, provider_message_id, raw_payload, idempotency_key, status,
                                dispatch_state, dispatch_outcome, company_id, correlation_id, next_attempt_at, attempts,
                                dead_lettered_at, dead_letter_reason)
     values ('whatsapp',$1,'{}'::jsonb,$2,$3,'dispatched','staff_finance',$4,$5, now(), $6, $7, $8) returning id`,
    [`pm-${rnd()}`, `idem-${rnd()}`, opts.deadLettered ? "dead_letter" : "completed", co, `corr-${rnd()}`,
     opts.attempts ?? 1, opts.deadLettered ? new Date().toISOString() : null,
     opts.deadLettered ? "exhausted" : null])).id;
  const candidate = (await one(
    `insert into financial_events (company_id, source_event_id, event_type, state, amount, currency,
                                   transaction_date, counterparty_name, correlation_id, risk_flags, missing_fields)
     values ($1,$2,'expense','awaiting_information','900.00','LKR','2026-08-10','Supplier',$3,'{}','{}') returning id`,
    [co, src, `corr-${rnd()}`])).id;
  const reviews: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = (await one(
      `insert into financial_events (company_id, event_type, state, amount, currency, transaction_date,
                                     counterparty_name, correlation_id, risk_flags, missing_fields)
       values ($1,'expense','posted','900.00','LKR',$2,'Supplier',$3,'{}','{}') returning id`,
      [co, `2026-0${7 - i}-10`, `corr-${rnd()}`])).id;
    reviews.push((await one(
      `insert into duplicate_reviews (company_id, financial_event_id, matched_event_id, score, algorithm_version)
       values ($1,$2,$3,0.9,'dup/v2-evidence-required') returning id`, [co, candidate, m])).id);
  }
  return { src, candidate, reviews };
}

describe.skipIf(!enabled)("OF-016 — siblings and the retry budget (0089)", () => {
  beforeAll(async () => {
    db = await mkConn();
    await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await db.query(`drop role if exists ${AUTH}`);
    await db.query(`create role ${AUTH} login password 'probe'`);
    await db.query(`grant authenticated to ${AUTH}`);
    co = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16s2 ${SUFFIX}`])).id;
    reviewer = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [reviewer]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'of16s2 reviewer',true) on conflict do nothing`, [reviewer]);
    const m = await one(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, reviewer]);
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'finance_reviewer')`, [m.id, co]);
  });

  afterAll(async () => {
    for (const c of conns.slice(1)) await c.end().catch(() => {});
    for (const sql of [
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

  it("J-02: confirming one of two reviews closes the SIBLING instead of stranding it", async () => {
    const s = await seedMulti(2);
    expect(s.reviews.length).toBe(2);

    const r = await resolveAs(s.reviews[0]!, "confirmed_duplicate", "same receipt twice");
    expect(r.resolution).toBe("confirmed_duplicate");
    expect((await one(`select state from financial_events where id=$1`, [s.candidate])).state).toBe("duplicate");

    const sib = await one(`select state, resolution, resolved_by, resolution_note from duplicate_reviews where id=$1`, [s.reviews[1]]);
    // Before 0089 this stayed `open` on a terminal event and could be resolved by nobody — not the
    // reviewer (the state guard refused both directions), not `service_role` (0087's triggers), not
    // any api role. The queue showed it forever.
    expect(sib.state).toBe("resolved");
    expect(sib.resolution, "and NOT recorded as a human verdict on this pair").toBe("superseded_by_decision");
    expect(sib.resolved_by).toBe(reviewer);
    expect(String(sib.resolution_note)).toContain(s.reviews[0]!);

    const open = await one(`select count(*)::int n from duplicate_reviews where financial_event_id=$1 and state='open'`, [s.candidate]);
    expect(open.n, "the queue returns to zero").toBe(0);
  });

  it("J-02: the supersession is audited as NOT a human verdict", async () => {
    const s = await seedMulti(3);
    await resolveAs(s.reviews[0]!, "confirmed_duplicate", "dupe");
    const au = await rows(
      `select entity_id, payload from audit_events
        where action='finance.duplicate_review_superseded' and entity_id = any($1) order by entity_id`,
      [[s.reviews[1], s.reviews[2]]]);
    expect(au.length, "each superseded sibling gets its own audit row").toBe(2);
    for (const a of au) {
      expect(a.payload.superseded_by_review).toBe(s.reviews[0]);
      expect(String(a.payload.note)).toMatch(/not a human verdict on this pair/i);
    }
    // …and the deciding review's own audit names the siblings it closed.
    const main = await one(
      `select payload from audit_events where entity_id=$1 and action='finance.duplicate_review_resolved'`, [s.reviews[0]]);
    expect((main.payload.superseded_sibling_reviews ?? []).sort()).toEqual([s.reviews[1], s.reviews[2]].sort());
  });

  it("J-02: DISMISSING one review deliberately leaves its siblings OPEN", async () => {
    // A dismissal of one pair says nothing about another. The event returns to `draft`, the
    // pipeline re-scores it against the surviving counterpart and pauses it again, and the reviewer
    // decides that pair on its own merits. Closing them here would be the silent merge this whole
    // line of work exists to prevent.
    const s = await seedMulti(2);
    await resolveAs(s.reviews[0]!, "dismissed_distinct", "different PO");
    const sib = await one(`select state, resolution from duplicate_reviews where id=$1`, [s.reviews[1]]);
    expect([sib.state, sib.resolution]).toEqual(["open", null]);
    expect((await one(`select state from financial_events where id=$1`, [s.candidate])).state).toBe("draft");
  });

  it("J-02: a caller cannot ASK for superseded_by_decision — it is written, never requested", async () => {
    const s = await seedMulti(1);
    const c = await mkConn(AUTH);
    await c.query("begin");
    try {
      await c.query("set local role authenticated");
      await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ role: "authenticated", sub: reviewer })]);
      const e = await c.query(`select * from public.resolve_duplicate_review($1,'superseded_by_decision','x')`, [s.reviews[0]])
        .then(() => null).catch((x: any) => x);
      expect(e?.message).toMatch(/must be confirmed_duplicate or dismissed_distinct/i);
    } finally { await c.query("rollback").catch(() => {}); }
  });

  it("J-03: a release RESTORES the retry budget, and the prior count is kept in the audit", async () => {
    // Preserving `attempts` read as "history is not reset deceptively", but fail_source_event
    // dead-letters at attempts >= max_attempts — so a released event that had already spent its
    // budget died on the first ordinary provider error, with no second release available.
    const s = await seedMulti(1, { attempts: 5, deadLettered: true });
    await resolveAs(s.reviews[0]!, "dismissed_distinct", "release it");

    const src = await one(
      `select status, attempts, dead_lettered_at, dead_letter_reason from source_events where id=$1`, [s.src]);
    expect(src.status).toBe("pending");
    expect(src.attempts, "a deliberate human release gets a real chance, not one attempt").toBe(0);
    expect(src.dead_lettered_at).toBeNull();
    expect(src.dead_letter_reason).toBeNull();

    const au = await one(
      `select payload from audit_events where entity_id=$1 and action='finance.duplicate_review_resolved'`, [s.reviews[0]]);
    expect(au.payload.prior_attempts, "the history is kept where it can be READ").toBe(5);
    expect(au.payload.cleared_dead_letter).toBe(true);
    expect(au.payload.prior_dead_letter_reason).toBe("exhausted");
  });

  it("J-03: a CONFIRMATION does not touch attempts — only a release needs a budget", async () => {
    const s = await seedMulti(1, { attempts: 3 });
    await resolveAs(s.reviews[0]!, "confirmed_duplicate", "dupe");
    const src = await one(`select status, attempts from source_events where id=$1`, [s.src]);
    expect(src.status).toBe("completed");
    expect(src.attempts, "a confirmed duplicate is never processed again, so nothing is restored").toBe(3);
  });
});
