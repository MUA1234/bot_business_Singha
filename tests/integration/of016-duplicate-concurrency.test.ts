/**
 * OF-016 — concurrency, lock order and exactly-once resume. Real connections, no mocks.
 *
 * The documented global lock order, shared with the finance worker, is
 *
 *     source_events  →  financial_events  →  duplicate_reviews  →  approval_requests / payments
 *
 * The source event goes first because it is the processing LINEARIZATION object: `claim_source_events`
 * takes `for update skip locked` on it before anything else, so a reviewer holding that lock makes
 * a worker SKIP the row rather than queue behind it. Everything below tests that claim rather than
 * asserting it — including the AB-BA pairings that would deadlock if any actor went the other way.
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
const AUTH = `of16c_auth_${SUFFIX}`;
const conns: any[] = [];
let co: string, rev1: string, rev2: string;

const one = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];

async function mkConn(role?: string) {
  const { default: pg } = await import("pg" as string);
  const cs = role ? URL.replace(/\/\/[^@]*@/, `//${role}:probe@`) : URL;
  const c = new pg.Client({ connectionString: cs, ssl: mkSsl(URL) });
  await c.connect();
  conns.push(c);
  return c;
}
const failed = async (c: any, sql: string, p: any[] = []) =>
  c.query(sql, p).then((r: any) => ({ ok: r })).catch((e: any) => ({ err: e }));

async function asHuman(c: any, sub: string) {
  await c.query("set local role authenticated");
  await c.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ role: "authenticated", sub })]);
}
async function asWorker(c: any) {
  await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',true)`);
}

async function mkUser(name: string): Promise<string> {
  const id = randomUUID();
  await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [id]);
  await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict do nothing`, [id, name]);
  return id;
}

async function seed() {
  const src = (await one(
    `insert into source_events (source, provider_message_id, raw_payload, idempotency_key, status,
                                dispatch_state, dispatch_outcome, company_id, correlation_id,
                                next_attempt_at, attempts)
     values ('whatsapp',$1,'{}'::jsonb,$2,'completed','dispatched','staff_finance',$3,$4, now(), 1)
     returning id`, [`pm-${rnd()}`, `idem-${rnd()}`, co, `corr-${rnd()}`])).id;
  const earlier = (await one(
    `insert into financial_events (company_id, source_event_id, event_type, state, amount, currency,
                                   transaction_date, counterparty_name, correlation_id, risk_flags, missing_fields)
     values ($1,null,'expense','posted','1000.00','LKR','2026-08-10','Acme',$2,'{}','{}') returning id`,
    [co, `corr-${rnd()}`])).id;
  const candidate = (await one(
    `insert into financial_events (company_id, source_event_id, event_type, state, amount, currency,
                                   transaction_date, counterparty_name, correlation_id, risk_flags, missing_fields)
     values ($1,$2,'expense','awaiting_information','1000.00','LKR','2026-08-10','Acme',$3,'{}','{}') returning id`,
    [co, src, `corr-${rnd()}`])).id;
  const review = (await one(
    `insert into duplicate_reviews (company_id, financial_event_id, matched_event_id, score,
                                    feature_contributions, evidence_present, evidence_missing, algorithm_version)
     values ($1,$2,$3,0.95,'{}'::jsonb,'{amount,date}','{counterparty}','dup/v2-evidence-required')
     returning id`, [co, candidate, earlier])).id;
  return { src, earlier, candidate, review };
}

describe.skipIf(!enabled)("OF-016 — concurrency and lock order", () => {
  beforeAll(async () => {
    db = await mkConn();
    await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await db.query(`drop role if exists ${AUTH}`);
    await db.query(`create role ${AUTH} login password 'probe'`);
    await db.query(`grant authenticated, service_role to ${AUTH}`);

    co = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16c ${SUFFIX}`])).id;
    rev1 = await mkUser("of16c reviewer one");
    rev2 = await mkUser("of16c reviewer two");
    for (const u of [rev1, rev2]) {
      const m = await one(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, u]);
      await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'finance_reviewer')`, [m.id, co]);
    }
  });

  afterAll(async () => {
    for (const c of conns) await c.end().catch(() => {});
    const clean = await mkConn();
    await clean.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    for (const sql of [
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

  it("two reviewers choosing the SAME result: one decides, the other is told it already stands", async () => {
    const s = await seed();
    const a = await mkConn(AUTH), b = await mkConn(AUTH);
    await a.query("begin"); await asHuman(a, rev1);
    await b.query("begin"); await asHuman(b, rev2);
    await b.query("set local statement_timeout = '8s'");

    // A decides and HOLDS the transaction open, so B must block on the row locks.
    const ra = (await a.query(
      `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','A: same invoice')`, [s.review])).rows[0];
    expect(ra.replayed).toBe(false);

    const pending = b.query(
      `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','B: same invoice')`, [s.review]);
    await a.query("commit");
    const rb = (await pending).rows[0];
    // B saw A's committed decision under the lock and reported it rather than writing a second one.
    expect(rb.replayed).toBe(true);
    expect(rb.resolution).toBe("confirmed_duplicate");
    await b.query("rollback");

    const n = (await db.query(
      `select count(*)::int n from audit_events where entity_id=$1 and action='finance.duplicate_review_resolved'`,
      [s.review])).rows[0].n;
    expect(n, "exactly one decision was recorded").toBe(1);
  });

  it("two reviewers choosing CONFLICTING results: the first commit wins, the second is not applied", async () => {
    const s = await seed();
    const a = await mkConn(AUTH), b = await mkConn(AUTH);
    await a.query("begin"); await asHuman(a, rev1);
    await b.query("begin"); await asHuman(b, rev2);
    await b.query("set local statement_timeout = '8s'");

    await a.query(`select * from public.resolve_duplicate_review($1,'dismissed_distinct','A: genuinely two orders')`, [s.review]);
    const pending = b.query(`select * from public.resolve_duplicate_review($1,'confirmed_duplicate','B: it is a dupe')`, [s.review]);
    await a.query("commit");
    const rb = (await pending).rows[0];
    expect(rb.replayed).toBe(true);
    expect(rb.resolution, "A's decision stands").toBe("dismissed_distinct");
    await b.query("rollback");

    const fe = (await db.query(`select state from financial_events where id=$1`, [s.candidate])).rows[0];
    expect(fe.state, "and the event went where A sent it").toBe("draft");
  });

  it("a reviewer inside the RPC makes the WORKER SKIP the row — no blocking, no deadlock", async () => {
    const s = await seed();
    // Claimable, as it is right after a dismissal — so the only thing that can keep the worker off
    // it is the reviewer's lock.
    await db.query(`update source_events set status='pending', next_attempt_at=now(), lease_owner=null where id=$1`, [s.src]);

    const rev = await mkConn(AUTH), worker = await mkConn(AUTH);
    await rev.query("begin"); await asHuman(rev, rev1);
    // The RPC itself takes source_events → financial_events → duplicate_reviews. The reviewer has
    // no table privilege of its own, so this is the ONLY way to hold those locks as a human — and
    // therefore the only faithful test. Held open, uncommitted.
    await rev.query(`select * from public.resolve_duplicate_review($1,'dismissed_distinct','holding')`, [s.review]);

    await worker.query("begin");
    await worker.query("set local role service_role");
    await asWorker(worker);
    await worker.query("set local statement_timeout = '5s'");
    // `for update skip locked` must SKIP, not block. If this ever blocks, the claim is queueing
    // behind human review and the lock-order argument is wrong.
    const claimed = await failed(worker, `select id from public.claim_source_events(50, $1, 60)`, [`w-${rnd()}`]);
    expect(claimed.err, "the worker must not block behind a reviewer").toBeUndefined();
    expect((claimed.ok?.rows ?? []).map((r: any) => r.id),
      "and it must not claim a row a reviewer is deciding").not.toContain(s.src);
    await worker.query("rollback");

    // Once the reviewer commits, the SAME worker cycle picks it up normally.
    await rev.query("commit");
    const w2 = await mkConn(AUTH);
    await w2.query("begin");
    await w2.query("set local role service_role");
    await asWorker(w2);
    const got = (await w2.query(`select id from public.claim_source_events(50,$1,60)`, [`w2-${rnd()}`])).rows.map((r: any) => r.id);
    expect(got, "and it becomes claimable the moment the decision commits").toContain(s.src);
    await w2.query("rollback");
  });

  it("AB-BA: an actor taking the locks in the OPPOSITE order deadlocks — and the shipped order does not", async () => {
    // The first version of this test was inert. It gave each of six reviewers its OWN review, so
    // they never contended, and its only other actor called `claim_source_events`, which is
    // `for update skip locked` and by construction never waits. The review proved it by INVERTING
    // the RPC's lock order in a clone and watching all 7 tests still pass.
    //
    // This one earns the claim. It puts a deliberate inverting actor — duplicate_reviews first,
    // then financial_events — against the real RPC on the SAME rows, and asserts the deadlock
    // detector fires. That is the positive control: it proves the arrangement CAN produce a
    // deadlock, so the negative result below means something.
    const s = await seed();
    const inverter = await mkConn();          // superuser: the only session that can lock these directly
    const reviewer = await mkConn(AUTH);
    await inverter.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);

    await inverter.query("begin");
    await inverter.query("set local statement_timeout = '10s'");
    // WRONG ORDER on purpose: the review before the event.
    await inverter.query(`select id from duplicate_reviews where id=$1 for update`, [s.review]);

    await reviewer.query("begin");
    await asHuman(reviewer, rev1);
    await reviewer.query("set local statement_timeout = '10s'");
    // The RPC takes source_events → financial_events → duplicate_reviews, so it will hold the
    // financial event and then wait for the review the inverter is holding.
    const rpc = failed(reviewer,
      `select * from public.resolve_duplicate_review($1,'confirmed_duplicate','ab-ba probe')`, [s.review]);

    // Give the RPC time to take its first two locks, then close the cycle from the other side.
    await new Promise((r) => setTimeout(r, 400));
    const inv = await failed(inverter, `select id from financial_events where id=$1 for update`, [s.candidate]);
    const rpcResult = await rpc;

    const messages = [inv.err?.message ?? "", rpcResult.err?.message ?? ""].join(" | ");
    expect(messages, "an inverting actor MUST be able to deadlock — otherwise this test proves nothing")
      .toMatch(/deadlock/i);
    await inverter.query("rollback").catch(() => {});
    await reviewer.query("rollback").catch(() => {});
    await inverter.end().catch(() => {});
  });

  it("every actor that follows the documented order contends on the SAME rows without deadlocking", async () => {
    // The negative result the positive control above makes meaningful: with everyone taking
    // source_events → financial_events → duplicate_reviews, real contention on ONE review — many
    // reviewers plus workers — produces no deadlock at all.
    const s = await seed();
    await db.query(`update source_events set status='pending', next_attempt_at=now() where id=$1`, [s.src]);

    const reviewers = await Promise.all([0, 1, 2, 3, 4, 5].map(() => mkConn(AUTH)));
    const workers = await Promise.all([0, 1, 2].map(() => mkConn(AUTH)));

    const revWork = reviewers.map(async (c, i) => {
      await c.query("begin");
      await asHuman(c, i % 2 === 0 ? rev1 : rev2);
      await c.query("set local statement_timeout = '15s'");
      // ALL SIX on the same review, which is what "contending on the same rows" has to mean.
      const r = await failed(c,
        `select * from public.resolve_duplicate_review($1,$2,'stress')`,
        [s.review, i % 2 === 0 ? "dismissed_distinct" : "confirmed_duplicate"]);
      await c.query("commit").catch(() => c.query("rollback").catch(() => {}));
      return r;
    });
    const workWork = workers.map(async (c) => {
      await c.query("begin");
      await c.query("set local role service_role");
      await asWorker(c);
      await c.query("set local statement_timeout = '15s'");
      const r = await failed(c, `select id from public.claim_source_events(50,$1,30)`, [`stress-${rnd()}`]);
      await c.query("rollback").catch(() => {});
      return r;
    });

    const results = await Promise.all([...revWork, ...workWork]);
    const deadlocks = results.filter((r) => /deadlock/i.test(r.err?.message ?? ""));
    expect(deadlocks.map((d) => d.err.message), "no actor may take the locks in the other order").toEqual([]);

    // Exactly ONE decision stands, and the other five reviewers were told so.
    const row = (await db.query(`select state, resolution from duplicate_reviews where id=$1`, [s.review])).rows[0];
    expect(row.state).toBe("resolved");
    const audits = (await db.query(
      `select count(*)::int n from audit_events where entity_id=$1 and action='finance.duplicate_review_resolved'`,
      [s.review])).rows[0].n;
    expect(audits, "six concurrent reviewers, one decision, one audit row").toBe(1);
  });

  it("a STALE worker cannot resume a payment after a reviewer confirmed the duplicate", async () => {
    const s = await seed();
    // The worker claims first — it is already mid-flight when the human decides.
    const worker = await mkConn(AUTH);
    await worker.query("begin");
    await worker.query("set local role service_role");
    await asWorker(worker);
    const lease = `stale-${rnd()}`;
    await worker.query(`update source_events set status='processing', lease_owner=$2,
                        lease_expires_at = now() + interval '60 seconds' where id=$1`, [s.src, lease]);
    await worker.query("commit");

    const rev = await mkConn(AUTH);
    await rev.query("begin"); await asHuman(rev, rev1);
    await rev.query(`select * from public.resolve_duplicate_review($1,'confirmed_duplicate','human decided')`, [s.review]);
    await rev.query("commit");

    // The confirmation cleared the lease and settled the row, so the stale worker's own row is no
    // longer claimable and the event is terminal — there is nothing left for it to do.
    const src = (await db.query(`select status, lease_owner from source_events where id=$1`, [s.src])).rows[0];
    expect(src.status).toBe("completed");
    expect(src.lease_owner).toBeNull();
    const fe = (await db.query(`select state from financial_events where id=$1`, [s.candidate])).rows[0];
    expect(fe.state).toBe("duplicate");

    // And a fresh claim cycle does not pick it up again.
    const w2 = await mkConn(AUTH);
    await w2.query("begin");
    await w2.query("set local role service_role");
    await asWorker(w2);
    const got = (await w2.query(`select id from public.claim_source_events(50, $1, 60)`, [`w2-${rnd()}`])).rows.map((r: any) => r.id);
    expect(got).not.toContain(s.src);
    await w2.query("rollback");
  });

  it("a dismissal makes the source event claimable EXACTLY once", async () => {
    const s = await seed();
    const rev = await mkConn(AUTH);
    await rev.query("begin"); await asHuman(rev, rev1);
    await rev.query(`select * from public.resolve_duplicate_review($1,'dismissed_distinct','two real orders')`, [s.review]);
    await rev.query("commit");

    const w1 = await mkConn(AUTH), w2 = await mkConn(AUTH);
    for (const w of [w1, w2]) {
      await w.query("begin");
      await w.query("set local role service_role");
      await asWorker(w);
    }
    const got1 = (await w1.query(`select id from public.claim_source_events(50,$1,60)`, [`a-${rnd()}`])).rows.map((r: any) => r.id);
    const got2 = (await w2.query(`select id from public.claim_source_events(50,$1,60)`, [`b-${rnd()}`])).rows.map((r: any) => r.id);
    expect(got1.filter((i: string) => i === s.src).length + got2.filter((i: string) => i === s.src).length,
      "exactly one worker gets it").toBe(1);
    await w1.query("commit"); await w2.query("rollback");
  });

  it("crash AFTER the resolution commits but BEFORE the worker runs: the decision survives", async () => {
    const s = await seed();
    const rev = await mkConn(AUTH);
    await rev.query("begin"); await asHuman(rev, rev1);
    await rev.query(`select * from public.resolve_duplicate_review($1,'dismissed_distinct','distinct')`, [s.review]);
    await rev.query("commit");
    await rev.end().catch(() => {});   // the reviewer's session dies here

    const after = (await db.query(
      `select r.state, r.resolution, fe.state as fe_state, se.status as se_status
         from duplicate_reviews r
         join financial_events fe on fe.id = r.financial_event_id
         join source_events se on se.id = fe.source_event_id
        where r.id=$1`, [s.review])).rows[0];
    expect([after.state, after.resolution, after.fe_state, after.se_status])
      .toEqual(["resolved", "dismissed_distinct", "draft", "pending"]);
  });
});
