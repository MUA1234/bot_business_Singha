/**
 * OF-016 — the authorized resolution workflow for a suspected-duplicate payment.
 *
 * Migration 0083 paused the payment honestly and left it there: no RPC, no screen, no write grant.
 * These tests prove the product at `be2f13e` CANNOT resolve a pending candidate and that migration
 * 0087 can, without loosening any boundary FOUND-006 established.
 *
 * Every authorization probe runs from a GENUINE login role, never from the suite's superuser with
 * `SET ROLE`. `auth.uid()`, `current_user` and `session_user` all answer differently inside a
 * SECURITY DEFINER body, and a test that probes as itself cannot tell the difference — two earlier
 * assertions in this repository were satisfied by the wrong mechanism for exactly that reason.
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
const ROLES = {
  auth: `of16_auth_${SUFFIX}`,
  anon: `of16_anon_${SUFFIX}`,
  svc: `of16_svc_${SUFFIX}`,
};
const conns: any[] = [];

/** Company A (the payment), company B (an unrelated company for cross-company probes). */
let coA: string, coB: string;
/** reviewer: capable in A. plain: member of A with no capability. inactiveRev: capable but inactive.
 *  otherRev: capable in B only. */
let reviewer: string, plain: string, inactiveRev: string, otherRev: string;

const q = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;
const one = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];

async function connectAs(role: string) {
  const { default: pg } = await import("pg" as string);
  const c = new pg.Client({ connectionString: URL.replace(/\/\/[^@]*@/, `//${role}:probe@`), ssl: mkSsl(URL) });
  await c.connect();
  conns.push(c);
  return c;
}
const failed = async (c: any, sql: string, p: any[] = []) =>
  c.query(sql, p).then(() => null).catch((e: any) => e);

/** Act as a specific human through a specific database role, the way a request does. */
async function asHuman(c: any, dbRole: string, sub: string | null) {
  await c.query(`set local role ${dbRole}`);
  await c.query(`select set_config('request.jwt.claims', $1, true)`,
    [sub === null ? JSON.stringify({ role: dbRole }) : JSON.stringify({ role: dbRole, sub })]);
}

async function mkUser(name: string): Promise<string> {
  const id = randomUUID();
  await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [id]);
  await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict do nothing`, [id, name]);
  return id;
}
async function mkMember(user: string, company: string, role: string, status = "active") {
  const m = await one(
    `insert into memberships (company_id, user_id, status) values ($1,$2,$3) returning id`,
    [company, user, status]);
  await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`,
    [m.id, company, role]);
}

/**
 * A complete paused candidate: a source event, an earlier financial event, the candidate financial
 * event in `awaiting_information`, and the `duplicate_reviews` row 0083 would have written.
 * Deliberately built with 0083's own columns and vocabulary — nothing here is new-format data.
 */
async function seedPausedCandidate(company: string, opts: { amount?: string; when?: string } = {}) {
  const amount = opts.amount ?? "45000.00";
  const when = opts.when ?? "2026-08-10";
  const src = (await one(
    `insert into source_events (source, provider_message_id, raw_payload, idempotency_key, status,
                                dispatch_state, dispatch_outcome, company_id, correlation_id,
                                next_attempt_at, attempts)
     values ('whatsapp',$1,'{}'::jsonb,$2,'completed','dispatched','staff_finance',$3,$4, now(), 2)
     returning id`, [`pm-${rnd()}`, `idem-${rnd()}`, company, `corr-${rnd()}`])).id;
  const earlier = (await one(
    `insert into financial_events (company_id, source_event_id, event_type, state, amount, currency,
                                   transaction_date, counterparty_name, correlation_id, risk_flags, missing_fields)
     values ($1,null,'expense','posted',$2,'LKR',$3,'Acme Supplies',$4,'{}','{}') returning id`,
    [company, amount, when, `corr-${rnd()}`])).id;
  const candidate = (await one(
    `insert into financial_events (company_id, source_event_id, event_type, state, amount, currency,
                                   transaction_date, counterparty_name, correlation_id, risk_flags, missing_fields)
     values ($1,$2,'expense','awaiting_information',$3,'LKR',$4,'Acme Supplies',$5,'{}','{}') returning id`,
    [company, src, amount, when, `corr-${rnd()}`])).id;
  const review = (await one(
    `insert into duplicate_reviews (company_id, financial_event_id, matched_event_id, score,
                                    feature_contributions, evidence_present, evidence_missing, algorithm_version)
     values ($1,$2,$3,0.9200,'{"amount":0.5,"date":0.3,"counterparty":0.12}'::jsonb,
             '{amount,date,counterparty}','{}','dup/v2-evidence-required') returning id`,
    [company, candidate, earlier])).id;
  return { src, earlier, candidate, review };
}

describe.skipIf(!enabled)("OF-016 — duplicate-review resolution", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);

    for (const [kind, name] of Object.entries(ROLES)) {
      await db.query(`drop role if exists ${name}`);
      await db.query(`create role ${name} login password 'probe'`);
      await db.query(`grant ${kind === "auth" ? "authenticated" : kind === "anon" ? "anon" : "service_role"} to ${name}`);
    }

    coA = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16 A ${SUFFIX}`])).id;
    coB = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16 B ${SUFFIX}`])).id;

    reviewer    = await mkUser("of16 reviewer");
    plain       = await mkUser("of16 plain member");
    inactiveRev = await mkUser("of16 inactive reviewer");
    otherRev    = await mkUser("of16 other-company reviewer");

    await mkMember(reviewer,    coA, "finance_reviewer");
    await mkMember(plain,       coA, "staff_submitter");
    await mkMember(inactiveRev, coA, "finance_reviewer", "ended");
    await mkMember(otherRev,    coB, "finance_reviewer");
  });

  afterAll(async () => {
    for (const c of conns) await c.end().catch(() => {});
    for (const sql of [
      `delete from duplicate_reviews where company_id = any($1)`,
      `delete from financial_events where company_id = any($1)`,
      `delete from source_events where company_id = any($1)`,
      `delete from membership_roles where company_id = any($1)`,
      `delete from memberships where company_id = any($1)`,
      `delete from companies where id = any($1)`,
    ]) { try { await db.query(sql, [[coA, coB]]); } catch { /* noop */ } }
    for (const n of Object.values(ROLES)) { try { await db.query(`drop role if exists ${n}`); } catch { /* noop */ } }
    await db.end().catch(() => {});
  });

  // ── visibility ──────────────────────────────────────────────────────────────────────────────
  it("an authorized reviewer sees the pending item, with both transactions and the evidence", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", reviewer);
      const rows = (await c.query(`select * from public.duplicate_review_queue($1)`, [coA])).rows;
      const mine = rows.find((r: any) => r.review_id === s.review);
      expect(mine, "the reviewer must see the pending review").toBeTruthy();
      expect(mine.state).toBe("open");
      expect(Number(mine.score)).toBeCloseTo(0.92, 4);
      expect(mine.candidate_event_id).toBe(s.candidate);
      expect(mine.matched_event_id).toBe(s.earlier);
      // Both sides carry their own money and counterparty — the reviewer decides from evidence.
      expect(String(mine.candidate_amount)).toMatch(/^45000/);
      expect(String(mine.matched_amount)).toMatch(/^45000/);
      expect(mine.candidate_currency).toBe("LKR");
      expect(mine.candidate_counterparty).toBe("Acme Supplies");
      expect(mine.candidate_state).toBe("awaiting_information");
      expect(mine.feature_contributions).toMatchObject({ amount: 0.5, date: 0.3, counterparty: 0.12 });
      expect(mine.algorithm_version).toBe("dup/v2-evidence-required");
    } finally { await c.query("rollback"); }
  });

  it("a member WITHOUT the capability sees nothing", async () => {
    await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", plain);
      const rows = (await c.query(`select * from public.duplicate_review_queue($1)`, [coA])).rows;
      expect(rows).toEqual([]);
    } finally { await c.query("rollback"); }
  });

  it("a reviewer from another company can neither see nor resolve it", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", otherRev);
      expect((await c.query(`select * from public.duplicate_review_queue($1)`, [coA])).rows).toEqual([]);
      await c.query("savepoint s");
      const e = await failed(c,
        `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','x')`, [s.review]);
      await c.query("rollback to savepoint s");
      expect(e?.message).toMatch(/do not hold finance\.duplicate\.resolve/i);
    } finally { await c.query("rollback"); }
  });

  it("a member whose membership has ENDED is refused, even holding the role", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", inactiveRev);
      expect((await c.query(`select * from public.duplicate_review_queue($1)`, [coA])).rows).toEqual([]);
      const e = await failed(c, `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','x')`, [s.review]);
      expect(e?.message).toMatch(/do not hold finance\.duplicate\.resolve/i);
    } finally { await c.query("rollback"); }
  });

  it("anonymous is refused — it cannot even reach the function", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.anon);
    await c.query("begin");
    try {
      await c.query("set local role anon");
      const e = await failed(c, `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','x')`, [s.review]);
      expect(e?.message).toMatch(/permission denied for function resolve_duplicate_review/i);
    } finally { await c.query("rollback"); }
  });

  it("SERVICE ROLE cannot forge a human decision — the grant excludes it", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.svc);
    await c.query("begin");
    try {
      await c.query("set local role service_role");
      // Even carrying a real reviewer's subject, the call is refused at the ACL: a decision that
      // names a person must be made by that person.
      await c.query(`select set_config('request.jwt.claims',$1,true)`,
        [JSON.stringify({ role: "service_role", sub: reviewer })]);
      const e = await failed(c, `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','x')`, [s.review]);
      expect(e?.message).toMatch(/permission denied for function resolve_duplicate_review/i);
    } finally { await c.query("rollback"); }
  });

  it("an authenticated caller with NO subject is refused", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", null);
      const e = await failed(c, `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','x')`, [s.review]);
      expect(e?.message).toMatch(/no authenticated subject/i);
    } finally { await c.query("rollback"); }
  });

  it("a reason is required", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", reviewer);
      const e = await failed(c, `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','   ')`, [s.review]);
      expect(e?.message).toMatch(/reason is required/i);
    } finally { await c.query("rollback"); }
  });

  // ── the two decisions ───────────────────────────────────────────────────────────────────────
  it("CONFIRMED duplicate: links to the original, settles the source, creates no business effect", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", reviewer);
      const r = (await c.query(
        `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','same invoice sent twice')`,
        [s.review])).rows[0];
      expect(r.resolution).toBe("confirmed_duplicate");
      expect(r.replayed).toBe(false);

      const fe = (await c.query(`select state, duplicate_of_event_id from financial_events where id=$1`, [s.candidate])).rows[0];
      expect(fe.state).toBe("duplicate");
      expect(fe.duplicate_of_event_id).toBe(s.earlier);

      // The ORIGINAL is untouched — a confirmation never rewrites the event it points at.
      const orig = (await c.query(`select state from financial_events where id=$1`, [s.earlier])).rows[0];
      expect(orig.state).toBe("posted");

      // No longer claimable by the worker.
      const src = (await c.query(`select status, lease_owner, lease_expires_at from source_events where id=$1`, [s.src])).rows[0];
      expect(src.status).toBe("completed");
      expect(src.lease_owner).toBeNull();

      // No draft payment, approval, task, journal or message was created.
      for (const [t, col] of [["approval_requests", "financial_event_id"], ["payments", "source_event_id"]] as const) {
        const n = (await c.query(`select count(*)::int n from ${t} where ${col} = $1`,
          [t === "payments" ? s.src : s.candidate])).rows[0].n;
        expect(n, `${t} must be untouched`).toBe(0);
      }

      // Audited, naming the real human and the reason.
      const au = (await c.query(
        `select actor_type, actor_id, payload from audit_events
          where entity_id = $1 and action='finance.duplicate_review_resolved'`, [s.review])).rows[0];
      expect(au.actor_type).toBe("user");
      expect(au.actor_id).toBe(reviewer);
      expect(au.payload.reason).toBe("same invoice sent twice");
      expect(au.payload.resolution).toBe("confirmed_duplicate");
    } finally { await c.query("rollback"); }
  });

  it("DISMISSED distinct: the payment resumes and the source event becomes claimable exactly once", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", reviewer);
      const before = (await c.query(`select attempts from source_events where id=$1`, [s.src])).rows[0].attempts;
      const r = (await c.query(
        `select * from public.resolve_duplicate_review($1,'dismissed_distinct','different PO, genuinely two orders')`,
        [s.review])).rows[0];
      expect(r.resolution).toBe("dismissed_distinct");

      const fe = (await c.query(`select state, duplicate_of_event_id from financial_events where id=$1`, [s.candidate])).rows[0];
      expect(fe.state).toBe("draft");
      expect(fe.duplicate_of_event_id).toBeNull();

      const src = (await c.query(
        `select status, lease_owner, lease_expires_at, processed_at, attempts, next_attempt_at <= now() as due
           from source_events where id=$1`, [s.src])).rows[0];
      expect(src.status).toBe("pending");
      expect(src.lease_owner).toBeNull();
      expect(src.processed_at).toBeNull();
      expect(src.due).toBe(true);
      // The RETRY BUDGET is restored (0089/J-03). Preserving `attempts` read as "history is not
      // reset deceptively", but `fail_source_event` dead-letters at attempts >= max_attempts, so a
      // released event that had already spent its budget died on the first ordinary provider error
      // — with no second release available, because a replay returns the standing decision before
      // re-arming anything. The prior count is carried into the audit payload instead, where it can
      // be read rather than silently killing the release.
      expect(src.attempts).toBe(0);
      const au = await c.query(
        `select payload from audit_events where entity_id=$1 and action='finance.duplicate_review_resolved'`,
        [s.review]);
      expect(au.rows[0].payload.prior_attempts, "the history is kept where it can be read").toBe(before);
    } finally { await c.query("rollback"); }
  });

  it("a dismissed pair is EXCLUDED from later scoring — the release must survive one pass", async () => {
    // Without this the pipeline would re-score the same pair, raise the same suspicion and
    // re-pause the payment the reviewer just released. The exclusion is the store's query.
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", reviewer);
      await c.query(`select * from public.resolve_duplicate_review($1,'dismissed_distinct','distinct')`, [s.review]);
      const dismissed = (await c.query(
        `select matched_event_id from duplicate_reviews
          where financial_event_id=$1 and state='resolved' and resolution='dismissed_distinct'`,
        [s.candidate])).rows.map((r: any) => r.matched_event_id);
      expect(dismissed).toEqual([s.earlier]);
    } finally { await c.query("rollback"); }
  });

  // ── replay and immutability ─────────────────────────────────────────────────────────────────
  it("an identical replay returns the standing decision and changes nothing", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", reviewer);
      const first = (await c.query(
        `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','r1')`, [s.review])).rows[0];
      const again = (await c.query(
        `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','r2 — different text')`, [s.review])).rows[0];
      expect(first.replayed).toBe(false);
      expect(again.replayed).toBe(true);
      expect(again.resolution).toBe("confirmed_duplicate");
      const note = (await c.query(`select resolution_note from duplicate_reviews where id=$1`, [s.review])).rows[0];
      expect(note.resolution_note, "the standing reason is not overwritten").toBe("r1");
      const n = (await c.query(
        `select count(*)::int n from audit_events where entity_id=$1 and action='finance.duplicate_review_resolved'`,
        [s.review])).rows[0].n;
      expect(n, "a replay must not add a second audit row").toBe(1);
    } finally { await c.query("rollback"); }
  });

  it("a CONFLICTING replay does not overwrite — the first decision stands", async () => {
    const s = await seedPausedCandidate(coA);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", reviewer);
      await c.query(`select * from public.resolve_duplicate_review($1,'dismissed_distinct','released')`, [s.review]);
      const conflicting = (await c.query(
        `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','changed my mind')`, [s.review])).rows[0];
      expect(conflicting.replayed).toBe(true);
      expect(conflicting.resolution, "the standing decision wins").toBe("dismissed_distinct");
      const fe = (await c.query(`select state from financial_events where id=$1`, [s.candidate])).rows[0];
      expect(fe.state, "and the event stays where the first decision put it").toBe("draft");
    } finally { await c.query("rollback"); }
  });

  it("a resolved review is immutable — and the SERVICE role, which CAN write the table, is refused", async () => {
    // Two different mechanisms, asserted separately, because conflating them is how a test comes
    // to prove nothing. `authenticated` holds NO table DML at all, so it is stopped by the ACL and
    // the trigger is never reached — that is checked here as an ACL fact. `service_role` DOES hold
    // UPDATE and DELETE (Supabase default privileges), so it is the only caller that actually
    // exercises the immutability trigger, and it is refused by the trigger's own message.
    const s2 = await seedPausedCandidate(coA);
    const human = await connectAs(ROLES.auth);
    await human.query("begin");
    await asHuman(human, "authenticated", reviewer);
    await human.query(`select * from public.resolve_duplicate_review($1,'confirmed_duplicate','done')`, [s2.review]);
    await human.query("commit");

    // (a) the api role cannot reach the table at all
    const priv = (await db.query(
      `select has_table_privilege('authenticated','public.duplicate_reviews','UPDATE') as u,
              has_table_privilege('authenticated','public.duplicate_reviews','DELETE') as d,
              has_table_privilege('service_role','public.duplicate_reviews','UPDATE') as su`)).rows[0];
    expect([priv.u, priv.d], "an api role holds no DML on the evidence table").toEqual([false, false]);
    expect(priv.su, "service_role does hold DML — so the trigger is the control that matters").toBe(true);

    // (b) the trigger refuses the caller that CAN write
    const svc = await connectAs(ROLES.svc);
    // NO try/catch around the assertion. The first version of this block ended with
    // `rollback to savepoint sp` — a savepoint it never created — wrapped in a bare `catch {}`,
    // so the failing rollback swallowed the AssertionError with it. The review proved the test was
    // inert by reverting the very control it claims to prove and watching all 17 tests still pass.
    // A test that cannot fail is worse than no test: it reports safety it never checked.
    await svc.query("begin");
    try {
      await svc.query("set local role service_role");
      const upd = await failed(svc, `update duplicate_reviews set resolution_note='tampered' where id=$1`, [s2.review]);
      expect(upd?.message, "a resolved decision is immutable").toMatch(/is resolved .* a terminal decision is immutable/i);
    } finally { await svc.query("rollback").catch(() => {}); }

    await svc.query("begin");
    try {
      await svc.query("set local role service_role");
      const del = await failed(svc, `delete from duplicate_reviews where id=$1`, [s2.review]);
      expect(del?.message, "evidence is not deletable").toMatch(/not deletable/i);
    } finally { await svc.query("rollback").catch(() => {}); }

    // (c) an OPEN review is equally protected from a direct write — the RPC is the only writer
    const s3 = await seedPausedCandidate(coA);
    await svc.query("begin");
    try {
      await svc.query("set local role service_role");
      const e = await failed(svc,
        `update duplicate_reviews set state='resolved', resolution='confirmed_duplicate',
                resolved_by=$2, resolved_at=now(), resolution_note='forged' where id=$1`,
        [s3.review, reviewer]);
      expect(e?.message).toMatch(/resolved through resolve_duplicate_review, not by direct write/i);
    } finally { await svc.query("rollback").catch(() => {}); }

    // No cleanup of audit_events here — it is append-only, which is itself the point.
  });

  it("the paused event must be in awaiting_information — anything else fails closed", async () => {
    const s = await seedPausedCandidate(coA);
    await db.query(`update financial_events set state='approved' where id=$1`, [s.candidate]);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", reviewer);
      const e = await failed(c, `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','x')`, [s.review]);
      expect(e?.message).toMatch(/only an event paused in\s+awaiting_information/i);
    } finally { await c.query("rollback"); }
    await db.query(`delete from duplicate_reviews where id=$1`, [s.review]);
  });

  it("CONFIRMING over existing financial evidence fails closed rather than deleting it", async () => {
    const s = await seedPausedCandidate(coA);
    await db.query(
      `insert into approval_requests (company_id, financial_event_id, status, approvals_required, submitted_by_source)
       values ($1,$2,'pending',1,'system')`, [coA, s.candidate]);
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await asHuman(c, "authenticated", reviewer);
      await c.query("savepoint s");
      const e = await failed(c, `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','dupe')`, [s.review]);
      await c.query("rollback to savepoint s");
      expect(e?.message).toMatch(/inconsistent: this paused event already has 1 approval/i);
      // Nothing was deleted, and the review is still open for a person to deal with properly.
      const still = (await c.query(`select state from duplicate_reviews where id=$1`, [s.review])).rows[0];
      expect(still.state).toBe("open");
    } finally { await c.query("rollback"); }
    await db.query(`delete from approval_requests where financial_event_id=$1`, [s.candidate]);
  });

  // ── the discriminating claim: the product at be2f13e could not do this ──────────────────────
  it("DISCRIMINATION: before 0087 there was no resolution path at all", async () => {
    // The three things 0087 adds. On a database at 0086 every one of these is absent, which is
    // precisely why a paused payment could not be released.
    const fns = (await q(
      `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('resolve_duplicate_review','duplicate_review_queue')
        order by 1`)).map((r: any) => r.proname);
    expect(fns).toEqual(["duplicate_review_queue", "resolve_duplicate_review"]);

    const cap = (await q(`select key from permissions where key='finance.duplicate.resolve'`)).length;
    expect(cap).toBe(1);

    const col = (await q(
      `select column_name from information_schema.columns
        where table_name='financial_events' and column_name='duplicate_of_event_id'`)).length;
    expect(col).toBe(1);
  });
});
