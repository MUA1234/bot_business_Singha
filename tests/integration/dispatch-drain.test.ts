/**
 * R1 §3 / OF-001 — the dispatch drain against a disposable local PostgreSQL.
 *
 * The unit scenarios prove the drain's ordering, deadline and accounting with injected ports. These
 * prove the parts only a real database can: that the LEASE is what stops two overlapping runs from
 * touching the same receipt, that a crashed run's work is recovered exactly once, that a release
 * hands the attempt back, and that a drain cannot reach across tenants.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any, cA: any, cB: any;
let co: string, coB: string;
const ACCOUNT = `wa_drain_${rnd()}`;
const ACCOUNT_B = `wa_drainb_${rnd()}`;

const receipt = (c: any, account = ACCOUNT) =>
  c.query(`select * from public.record_inbound_receipt('whatsapp',$1,$2,'{"from":"9477","text":"hi"}'::jsonb,'h',$3,'inbound_message')`,
    [account, `wamid.${rnd()}`, `cor_${rnd()}`]).then((r: any) => r.rows[0]);
const claimBatch = (c: any, owner: string, limit = 25, lease = 120) =>
  c.query(`select id, dispatch_attempts from public.claim_inbound_dispatch_batch($1,$2,$3)`, [limit, owner, lease])
    .then((r: any) => r.rows);
const state = (id: string) =>
  db.query(`select dispatch_state, dispatch_owner, dispatch_attempts, company_id from source_events where id=$1`, [id])
    .then((r: any) => r.rows[0]);

describe.skipIf(!enabled)("0076/0079 — the dispatch drain's lease behaviour (disposable local PostgreSQL)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) }); await c.connect(); return c; };
    db = await mk(); cA = await mk(); cB = await mk();
    for (const c of [db, cA, cB]) await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await db.query(`insert into companies (name, base_currency) values ('drainA','LKR') returning id`)).rows[0].id;
    coB = (await db.query(`insert into companies (name, base_currency) values ('drainB','LKR') returning id`)).rows[0].id;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [co, ACCOUNT]);
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coB, ACCOUNT_B]);
  });
  afterAll(async () => {
    for (const a of [ACCOUNT, ACCOUNT_B]) { try { await db.query(`delete from source_events where provider_account_id=$1`, [a]); } catch { /* noop */ } }
    for (const c of [co, coB]) {
      for (const sql of [`delete from channel_accounts where company_id=$1`, `delete from companies where id=$1`]) {
        try { await db.query(sql, [c]); } catch { /* noop */ }
      }
    }
    await Promise.all([cA?.end(), cB?.end(), db?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("TWO OVERLAPPING RUNS: a receipt is claimed by exactly one", async () => {
    const r = await receipt(db);
    const [a, b] = await Promise.all([claimBatch(cA, "run-A"), claimBatch(cB, "run-B")]);
    const mine = [...a, ...b].filter((x: any) => x.id === r.event_id);
    expect(mine).toHaveLength(1);
    const row = await state(r.event_id);
    expect(row.dispatch_state).toBe("dispatching");
    expect(["run-A", "run-B"]).toContain(row.dispatch_owner);
  });

  it("a LIVE lease is invisible to the next run", async () => {
    const r = await receipt(db);
    await claimBatch(cA, "holder", 25, 300);
    const second = await claimBatch(cB, "later");
    expect(second.map((x: any) => x.id)).not.toContain(r.event_id);
  });

  it("WORKER CRASH: the expired lease is recovered, once, and the attempt still counted", async () => {
    const r = await receipt(db);
    await claimBatch(cA, "crashed", 25, 120);
    const before = await state(r.event_id);
    expect(before.dispatch_attempts).toBe(1);

    await db.query(`update source_events set dispatch_lease_expires_at = now() - interval '1 minute' where id=$1`, [r.event_id]);
    const [x, y] = await Promise.all([claimBatch(cA, "recover-A"), claimBatch(cB, "recover-B")]);
    const recovered = [...x, ...y].filter((i: any) => i.id === r.event_id);
    expect(recovered).toHaveLength(1);
    const after = await state(r.event_id);
    expect(after.dispatch_attempts).toBe(2); // a crash still consumes an attempt — poison rows drain
  });

  it("RELEASE hands the receipt back UNCHARGED, and the next run picks it up", async () => {
    const r = await receipt(db);
    await claimBatch(cA, "deadline-run", 25, 300);
    expect((await state(r.event_id)).dispatch_attempts).toBe(1);

    expect((await cA.query(`select public.release_inbound_dispatch($1,'deadline-run') as ok`, [r.event_id])).rows[0].ok).toBe(true);
    const released = await state(r.event_id);
    expect(released.dispatch_state).toBe("pending");
    expect(released.dispatch_owner).toBeNull();
    expect(released.dispatch_attempts).toBe(0);   // the attempt is GIVEN BACK

    const next = await claimBatch(cB, "next-run");
    expect(next.map((x: any) => x.id)).toContain(r.event_id);
  });

  it("release refuses a foreign owner, a settled receipt, and an untrusted caller", async () => {
    const r = await receipt(db);
    await claimBatch(cA, "owner-A", 25, 300);
    await expect(db.query(`select public.release_inbound_dispatch($1,'owner-B')`, [r.event_id]))
      .rejects.toMatchObject({ code: "55P03" });

    const settled = await receipt(db);
    await db.query(`select public.claim_inbound_dispatch($1,'w',120)`, [settled.event_id]);
    await db.query(`select * from public.record_inbound_dispatch($1,'w','customer_order',$2,null,null)`, [settled.event_id, co]);
    expect((await db.query(`select public.release_inbound_dispatch($1,'w') as ok`, [settled.event_id])).rows[0].ok).toBe(false);

    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
      await expect(db.query(`select public.release_inbound_dispatch($1,'w')`, [settled.event_id]))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });

  it("BACKOFF: a failed dispatch is not immediately re-claimable, and exhaustion parks it for a person", async () => {
    const r = await receipt(db);
    await db.query(`select public.claim_inbound_dispatch($1,'w',120)`, [r.event_id]);
    const st = (await db.query(`select public.fail_inbound_dispatch($1,'w','x','boom',5) as s`, [r.event_id])).rows[0].s;
    expect(st).toBe("failed");
    const soon = await claimBatch(db, "eager");
    expect(soon.map((x: any) => x.id)).not.toContain(r.event_id); // waiting out its backoff

    // Exhaust the budget: a receipt nobody can dispatch ends with a PERSON, not in a silent void.
    await db.query(`update source_events set next_attempt_at = now() - interval '1 hour', dispatch_attempts = 9 where id=$1`, [r.event_id]);
    await db.query(`select public.claim_inbound_dispatch($1,'w2',120)`, [r.event_id]);
    const final = (await db.query(`select public.fail_inbound_dispatch($1,'w2','x','still broken',5) as s`, [r.event_id])).rows[0].s;
    expect(final).toBe("manual_review");
  });

  it("STARVATION: a poison receipt does not block newer work", async () => {
    const poison = await receipt(db);
    await db.query(`select public.claim_inbound_dispatch($1,'w',120)`, [poison.event_id]);
    await db.query(`select public.fail_inbound_dispatch($1,'w','x','poison',5)`, [poison.event_id]);
    const fresh = await receipt(db);
    const batch = await claimBatch(db, "fair", 5);
    const ids = batch.map((x: any) => x.id);
    expect(ids).toContain(fresh.event_id);
    expect(ids).not.toContain(poison.event_id); // its backoff moved it out of eligibility
  });

  it("TENANT ISOLATION: a drain claims receipts for whichever company they belong to, and never mixes them", async () => {
    const mine = await receipt(db, ACCOUNT);
    const theirs = await receipt(db, ACCOUNT_B);
    for (const [ev, company] of [[mine, co], [theirs, coB]] as const) {
      await db.query(`select public.claim_inbound_dispatch($1,'w',120)`, [ev.event_id]);
      await db.query(`select * from public.record_inbound_dispatch($1,'w','customer_order',$2,null,null)`, [ev.event_id, company]);
    }
    expect((await state(mine.event_id)).company_id).toBe(co);
    expect((await state(theirs.event_id)).company_id).toBe(coB);
    // And a company-scoped backlog counts ONLY its own work. One capture each, then each company's
    // backlog must report exactly its own — never the other's, and never both.
    const mineCap = await receipt(db, ACCOUNT);
    await db.query(`select public.claim_inbound_dispatch($1,'w',120)`, [mineCap.event_id]);
    await db.query(`select * from public.record_inbound_dispatch($1,'w','staff_finance',$2,null,null)`, [mineCap.event_id, co]);

    const a = (await db.query(`select * from public.source_event_backlog($1)`, [co])).rows[0];
    const b = (await db.query(`select * from public.source_event_backlog($1)`, [coB])).rows[0];
    expect(Number(a.pending)).toBe(1);
    expect(Number(b.pending)).toBe(0);   // the other tenant's capture is invisible here
  });

  it("the batch claim is service-only", async () => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
      await expect(db.query(`select * from public.claim_inbound_dispatch_batch(5,'x',60)`))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });
});
