/**
 * FOUND-003 correction loop 1 — one provider message, one canonical event, at most one dispatch
 * (migration 0076). Deterministic integration scenarios against a disposable local PostgreSQL, several of them
 * across TWO connections so the concurrency and crash windows are real rather than simulated.
 *
 * THE DEFECT THESE EXIST TO PIN: one inbound message produced two `source_events` rows (the
 * webhook's persist-first key and the ingestion key differed), so the sweeper treated every
 * message — customer orders included — as unprocessed work, and the health signal counted receipts
 * that were never meant to be processed.
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
let db: any, cA: any, cB: any;
let co: string, coOther: string, reviewer: string;
const ACCOUNT = `wa_ident_${rnd()}`;
const OTHER_ACCOUNT = `wa_other_${rnd()}`;

const receipt = (c: any, msgId: string | null, account: string = ACCOUNT, purpose = "inbound_message") =>
  c.query(`select * from public.record_inbound_receipt('whatsapp',$1,$2,$3::jsonb,$4,$5,$6)`,
    [account, msgId, JSON.stringify({ id: msgId, text: "hello" }), `hash_${msgId ?? "none"}`, `cor_${rnd()}`, purpose])
    .then((r: any) => r.rows[0]);

const claim = (c: any, id: string, owner: string, lease = 120) =>
  c.query(`select public.claim_inbound_dispatch($1,$2,$3) as ok`, [id, owner, lease]).then((r: any) => r.rows[0].ok);

const mark = (c: any, id: string, owner: string, outcome: string, company: string | null = null) =>
  c.query(`select * from public.record_inbound_dispatch($1,$2,$3,$4,null,null)`, [id, owner, outcome, company])
    .then((r: any) => r.rows[0]);

const sweeper = (c: any, owner: string) =>
  c.query(`select id from public.claim_source_events(50,$1,120)`, [owner]).then((r: any) => r.rows.map((x: any) => x.id));

describe.skipIf(!enabled)("0076 — canonical inbound identity and at-most-one dispatch (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) }); await c.connect(); return c; };
    db = await mk(); cA = await mk(); cB = await mk();
    for (const c of [db, cA, cB]) await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await db.query(`insert into companies (name, base_currency) values ('identA','LKR') returning id`)).rows[0].id;
    coOther = (await db.query(`insert into companies (name, base_currency) values ('identB','LKR') returning id`)).rows[0].id;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [co, ACCOUNT]);
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coOther, OTHER_ACCOUNT]);
    reviewer = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [reviewer]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'ident reviewer',true) on conflict do nothing`, [reviewer]);
    const m = (await db.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, reviewer])).rows[0].id;
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [m, co]);
  });
  afterAll(async () => {
    for (const c of [co, coOther]) {
      for (const sql of [
        `delete from inbound_reviews where company_id=$1`,
        `delete from source_events where company_id=$1`,
        `delete from channel_accounts where company_id=$1`,
        `delete from membership_roles where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [c]); } catch { /* noop */ } }
    }
    try { await db.query(`delete from source_events where provider_account_id in ($1,$2)`, [ACCOUNT, OTHER_ACCOUNT]); } catch { /* noop */ }
    await Promise.all([cA?.end(), cB?.end(), db?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("FIRST DELIVERY: one message, one row", async () => {
    const id = `wamid.${rnd()}`;
    const r = await receipt(db, id);
    expect(r.created).toBe(true);
    expect(r.dispatch_state).toBe("pending");
    expect(r.event_identity).toContain(`:${id}:`);
    const n = (await db.query(`select count(*)::int c from source_events where provider_message_id=$1`, [id])).rows[0].c;
    expect(n).toBe(1);
  });

  it("EXACT REPLAY before processing: still one row, and it is not re-created", async () => {
    const id = `wamid.${rnd()}`;
    const first = await receipt(db, id);
    const again = await receipt(db, id);
    expect(again.created).toBe(false);
    expect(again.event_id).toBe(first.event_id);
    expect((await db.query(`select count(*)::int c from source_events where provider_message_id=$1`, [id])).rows[0].c).toBe(1);
  });

  it("REPLAY DURING PROCESSING: a live lease refuses the second dispatcher", async () => {
    const id = `wamid.${rnd()}`;
    const r = await receipt(db, id);
    expect(await claim(cA, r.event_id, "worker-A")).toBe(true);
    expect(await claim(cB, r.event_id, "worker-B")).toBe(false); // at most one business dispatch
  });

  it("REPLAY AFTER COMPLETION: no second dispatch, and the marker is not rewritten", async () => {
    const id = `wamid.${rnd()}`;
    const r = await receipt(db, id);
    await claim(db, r.event_id, "w1");
    await mark(db, r.event_id, "w1", "customer_order", co);
    expect(await claim(db, r.event_id, "w2")).toBe(false);
    const replay = await mark(db, r.event_id, "w2", "customer_order", co);
    expect(replay.already).toBe(true);
    await expect(mark(db, r.event_id, "w2", "staff_finance", co)).rejects.toThrow(/already dispatched as/);
  });

  it("TWO CONCURRENT DELIVERIES: two connections, one row, one dispatch", async () => {
    const id = `wamid.${rnd()}`;
    const [a, b] = await Promise.all([receipt(cA, id), receipt(cB, id)]);
    expect(a.event_id).toBe(b.event_id);
    expect([a.created, b.created].filter(Boolean).length).toBe(1); // exactly one creator
    const claims = await Promise.all([claim(cA, a.event_id, "conc-A"), claim(cB, a.event_id, "conc-B")]);
    expect(claims.filter(Boolean).length).toBe(1);
  });

  it("WEBHOOK AND WORKER RACE: the loser does not dispatch", async () => {
    const id = `wamid.${rnd()}`;
    const r = await receipt(db, id);
    const winner = await claim(cA, r.event_id, "sync-route");
    const loser = await claim(cB, r.event_id, "async-worker");
    expect(winner).toBe(true);
    expect(loser).toBe(false);
    await mark(cA, r.event_id, "sync-route", "customer_order", co);
    // The worker's late marker is refused: it does not hold the lease and the row is settled.
    const late = await mark(cB, r.event_id, "async-worker", "customer_order", co);
    expect(late.already).toBe(true);
  });

  it("CRASH after receipt, before dispatch: the expired lease is recovered, once", async () => {
    const id = `wamid.${rnd()}`;
    const r = await receipt(db, id);
    await claim(db, r.event_id, "crashed-worker", 120);
    // The worker died holding the lease.
    await db.query(`update source_events set dispatch_lease_expires_at = now() - interval '1 minute' where id=$1`, [r.event_id]);
    expect(await claim(cA, r.event_id, "recovering-worker")).toBe(true);
    expect(await claim(cB, r.event_id, "third-worker")).toBe(false);
    const row = (await db.query(`select dispatch_attempts, dispatch_owner from source_events where id=$1`, [r.event_id])).rows[0];
    expect(row.dispatch_attempts).toBe(2);
    expect(row.dispatch_owner).toBe("recovering-worker");
  });

  it("CRASH after the downstream effect, before the marker: the retry finds it and finishes", async () => {
    const id = `wamid.${rnd()}`;
    const r = await receipt(db, id);
    await claim(db, r.event_id, "worker-1");
    // The downstream effect exists…
    const first = (await db.query(
      `select * from public.record_inbound_review($1,'whatsapp',$2,'no_finance_classifier','x',$3,'9477','staff','exact','body')`,
      [co, id, r.event_id])).rows[0];
    expect(first.created).toBe(true);
    // …and the process dies before the marker is written.
    await db.query(`update source_events set dispatch_lease_expires_at = now() - interval '1 minute' where id=$1`, [r.event_id]);
    expect(await claim(db, r.event_id, "worker-2")).toBe(true);
    const second = (await db.query(
      `select * from public.record_inbound_review($1,'whatsapp',$2,'no_finance_classifier','x',$3,'9477','staff','exact','body')`,
      [co, id, r.event_id])).rows[0];
    expect(second.created).toBe(false);              // idempotent: no second queue item
    expect(second.review_id).toBe(first.review_id);
    const done = await mark(db, r.event_id, "worker-2", "manual_review", co);
    expect(done.dispatch_state).toBe("manual_review");
    expect((await db.query(`select count(*)::int c from inbound_reviews where company_id=$1 and provider_message_id=$2`, [co, id])).rows[0].c).toBe(1);
  });

  it("RETRY AFTER AN UNCERTAIN RESULT: re-recording the same outcome is safe", async () => {
    const id = `wamid.${rnd()}`;
    const r = await receipt(db, id);
    await claim(db, r.event_id, "w");
    const a = await mark(db, r.event_id, "w", "staff_finance", co);
    const b = await mark(db, r.event_id, "w", "staff_finance", co);
    expect(a.already).toBe(false);
    expect(b.already).toBe(true);       // the caller enqueues on the FIRST only
    expect(a.consumer_ready).toBe(true);
  });

  it("NO PROVIDER MESSAGE ID: never merged with anything, and parked for a person", async () => {
    const a = await receipt(db, null);
    const b = await receipt(db, null);
    expect(a.event_identity).toBeNull();
    expect(a.dispatch_state).toBe("manual_review");
    expect(a.event_id).not.toBe(b.event_id); // two anonymous messages are two events, never merged
  });

  it("SAME TEXT, DIFFERENT PROVIDER IDS: two events", async () => {
    const a = await receipt(db, `wamid.${rnd()}`);
    const b = await receipt(db, `wamid.${rnd()}`);
    expect(a.event_id).not.toBe(b.event_id);
  });

  it("SAME PROVIDER ID, DIFFERENT RECEIVING ACCOUNT OR PURPOSE: different events", async () => {
    const id = `wamid.${rnd()}`;
    const a = await receipt(db, id, ACCOUNT);
    const b = await receipt(db, id, OTHER_ACCOUNT);
    const c = await receipt(db, id, ACCOUNT, "status_update");
    expect(new Set([a.event_id, b.event_id, c.event_id]).size).toBe(3);
  });

  it("THE SWEEPER claims a finance capture and NOTHING else", async () => {
    const capture = await receipt(db, `wamid.${rnd()}`);
    const order = await receipt(db, `wamid.${rnd()}`);
    const undecided = await receipt(db, `wamid.${rnd()}`);
    await claim(db, capture.event_id, "w"); await mark(db, capture.event_id, "w", "staff_finance", co);
    await claim(db, order.event_id, "w"); await mark(db, order.event_id, "w", "customer_order", co);

    const claimed = await sweeper(db, `sweeper_${rnd()}`);
    expect(claimed).toContain(capture.event_id);
    expect(claimed).not.toContain(order.event_id);      // THE DEFECT: this used to be claimable
    expect(claimed).not.toContain(undecided.event_id);
  });

  it("THE SWEEPER never claims a SUPERSEDED row", async () => {
    const survivor = await receipt(db, `wamid.${rnd()}`);
    const redundant = await receipt(db, `wamid.${rnd()}`);
    await claim(db, redundant.event_id, "w"); await mark(db, redundant.event_id, "w", "staff_finance", co);
    await db.query(`update source_events set dispatch_state='superseded', superseded_by=$2 where id=$1`,
      [redundant.event_id, survivor.event_id]);
    const claimed = await sweeper(db, `sweeper_${rnd()}`);
    expect(claimed).not.toContain(redundant.event_id);
  });

  it("HEALTH: unresolved work is counted, and returns to baseline once resolved", async () => {
    const base = (await db.query(`select * from public.inbound_dispatch_health()`)).rows[0];
    const r = await receipt(db, `wamid.${rnd()}`);
    const during = (await db.query(`select * from public.inbound_dispatch_health()`)).rows[0];
    expect(Number(during.awaiting_dispatch)).toBe(Number(base.awaiting_dispatch) + 1);
    expect(Number(during.unattributed)).toBe(Number(base.unattributed) + 1);

    await claim(db, r.event_id, "w");
    await mark(db, r.event_id, "w", "customer_order", co);
    const after = (await db.query(`select * from public.inbound_dispatch_health()`)).rows[0];
    expect(Number(after.awaiting_dispatch)).toBe(Number(base.awaiting_dispatch));
    expect(Number(after.unattributed)).toBe(Number(base.unattributed));
  });

  it("HEALTH is company-scoped and cannot report another tenant's records", async () => {
    const mine = await receipt(db, `wamid.${rnd()}`);
    await claim(db, mine.event_id, "w"); await mark(db, mine.event_id, "w", "staff_finance", co);
    const theirs = await receipt(db, `wamid.${rnd()}`, OTHER_ACCOUNT);
    await claim(db, theirs.event_id, "w"); await mark(db, theirs.event_id, "w", "staff_finance", coOther);

    const a = (await db.query(`select * from public.source_event_backlog($1)`, [co])).rows[0];
    const b = (await db.query(`select * from public.source_event_backlog($1)`, [coOther])).rows[0];
    expect(Number(a.pending)).toBeGreaterThan(0);
    expect(Number(b.pending)).toBe(1);
    // An unscoped call is refused outright, so a cross-tenant count cannot be written by accident.
    await expect(db.query(`select * from public.source_event_backlog(null)`)).rejects.toThrow(/p_company is required/);
  });

  it("a superseded receipt cannot be dispatched, and the lifecycle functions are service-only", async () => {
    const survivor = await receipt(db, `wamid.${rnd()}`);
    const dead = await receipt(db, `wamid.${rnd()}`);
    await db.query(`update source_events set dispatch_state='superseded', superseded_by=$2 where id=$1`, [dead.event_id, survivor.event_id]);
    expect(await claim(db, dead.event_id, "w")).toBe(false);
    await expect(mark(db, dead.event_id, "w", "customer_order", co)).rejects.toThrow(/superseded/);

    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
      for (const sql of [
        `select * from public.record_inbound_receipt('whatsapp','a','b','{}'::jsonb,null,'c','inbound_message')`,
        `select public.claim_inbound_dispatch(gen_random_uuid(),'x',60)`,
        `select * from public.inbound_dispatch_health()`,
      ]) {
        await db.query("savepoint s");
        await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
        await db.query("rollback to savepoint s");
      }
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });
});
