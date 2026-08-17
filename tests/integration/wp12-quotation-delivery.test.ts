/**
 * WP12 — truthful quotation/order delivery state. Live Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0055: a quotation is `queued` (not `sent`) on enqueue, and only the fenced,
 * service-only `complete_outbox_and_advance(outbox_id, lease_owner, provider_message_id)` advances
 * it to `sent` (+ order `quoted` + conversation `quoted` + audit) — atomically, verifying the lease
 * owner, never regressing terminal states, and never crossing company boundaries. Delivery is
 * at-least-once: a wrong-lease/duplicate completion returns false and advances nothing.
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, coB: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
const rnd = () => Math.random().toString(36).slice(2, 12);
async function mkChain(company: string, opts: { qStatus?: string; obStatus?: string; owner?: string; leaseExpired?: boolean } = {}) {
  const conv = (await q(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [company, "9471" + rnd()])).rows[0].id;
  const ord = (await q(`insert into orders (company_id, conversation_id, status) values ($1,$2,'new') returning id`, [company, conv])).rows[0].id;
  const quo = (await q(`insert into quotations (company_id, order_id, quote_number, currency, status, public_token) values ($1,$2,$3,'LKR',$4,$5) returning id`,
    [company, ord, "SQ-" + rnd(), opts.qStatus ?? "queued", "tok_" + rnd()])).rows[0].id;
  const lease = opts.leaseExpired ? `now()-interval '1 minute'` : `now()+interval '2 minutes'`;
  const ob = (await q(
    `insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, lock_owner, locked_at, lease_expires_at, source_type, source_id, message_purpose)
     values ($1,'whatsapp','9471','body',$2,$3,$4, now(), ${lease}, 'quotation',$5,'quotation') returning id`,
    [company, "out_" + rnd(), opts.obStatus ?? "processing", opts.owner ?? null, quo])).rows[0].id;
  return { conv, ord, quo, ob };
}
async function complete(ob: string, owner: string, msgid = "wamid.X"): Promise<boolean> {
  return (await q(`select public.complete_outbox_and_advance($1,$2,$3) as v`, [ob, owner, msgid])).rows[0].v === true;
}
const statusOf = async (table: string, id: string) => (await q(`select status from ${table} where id=$1`, [id])).rows[0].status;

describe.skipIf(!enabled)("WP12 truthful quotation delivery — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    co = (await client.query(`insert into companies (name, base_currency) values ('wp12','LKR') returning id`)).rows[0].id;
    coB = (await client.query(`insert into companies (name, base_currency) values ('wp12b','LKR') returning id`)).rows[0].id;
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("a quotation stays `queued` (never `sent`) until the outbox row is completed", async () => {
    const { quo, ob } = await mkChain(co, { qStatus: "queued", obStatus: "processing", owner: "w1" });
    expect(await statusOf("quotations", quo)).toBe("queued");
    // A provider FAILURE never calls the completion RPC → the quotation must NOT advance.
    await q(`update message_outbox set status='failed', lock_owner=null, lease_expires_at=null, last_error='provider 500' where id=$1`, [ob]);
    expect(await statusOf("quotations", quo)).toBe("queued");
  });

  it("provider success + fenced completion marks quotation `sent`, order `quoted`, conversation `quoted`", async () => {
    const { conv, ord, quo, ob } = await mkChain(co, { owner: "w1" });
    // No outbound message history exists while the send is only queued/processing (WP12 correction A).
    expect((await q(`select count(*)::int c from wa_messages where conversation_id=$1 and direction='outbound'`, [conv])).rows[0].c).toBe(0);
    expect(await complete(ob, "w1", "wamid.OK")).toBe(true);
    expect(await statusOf("quotations", quo)).toBe("sent");
    expect(await statusOf("orders", ord)).toBe("quoted");
    expect(await statusOf("wa_conversations", conv)).toBe("quoted");
    const obRow = (await q(`select status, provider_message_id, sent_at from message_outbox where id=$1`, [ob])).rows[0];
    expect(obRow.status).toBe("sent");
    expect(obRow.provider_message_id).toBe("wamid.OK");
    expect(obRow.sent_at).not.toBeNull();
    expect((await q(`select count(*)::int c from audit_events where entity_type='quotation' and entity_id=$1 and action='quotation.sent'`, [quo])).rows[0].c).toBe(1);
    // Exactly ONE outbound history record is created — on durable send — carrying the provider id.
    const hist = await q(`select body, wa_message_id from wa_messages where conversation_id=$1 and direction='outbound'`, [conv]);
    expect(hist.rows).toHaveLength(1);
    expect(hist.rows[0].wa_message_id).toBe("wamid.OK");
  });

  it("a wrong-lease (or zero-row) completion returns false and advances nothing", async () => {
    const { quo, ob } = await mkChain(co, { owner: "w1" });
    expect(await complete(ob, "not-the-owner")).toBe(false);
    expect(await statusOf("quotations", quo)).toBe("queued");
    expect(await statusOf("message_outbox", ob)).toBe("processing");
  });

  it("the same row completes at most once — no double-advance (idempotent)", async () => {
    const { quo, ob } = await mkChain(co, { owner: "w1" });
    expect(await complete(ob, "w1")).toBe(true);
    expect(await complete(ob, "w1")).toBe(false); // no longer 'processing'
    expect(await statusOf("quotations", quo)).toBe("sent");
    expect((await q(`select count(*)::int c from audit_events where entity_id=$1 and action='quotation.sent'`, [quo])).rows[0].c).toBe(1);
  });

  it("an expired lease reclaimed by a new owner completes truthfully; the old owner cannot", async () => {
    const { quo, ob } = await mkChain(co, { owner: "w_crashed", leaseExpired: true });
    // Simulate the reclaim a later claim_outbox_batch performs: ownership moves to a fresh worker.
    await q(`update message_outbox set lock_owner='w_new', lease_expires_at=now()+interval '2 minutes' where id=$1`, [ob]);
    expect(await complete(ob, "w_crashed")).toBe(false); // old owner no longer owns the lease
    expect(await complete(ob, "w_new")).toBe(true);      // new owner completes exactly once
    expect(await statusOf("quotations", quo)).toBe("sent");
  });

  it("retrying finalisation via the production enqueue RPC is idempotent: second call is a 'duplicate', still one row", async () => {
    const key = "out_dupe_" + rnd();
    const call = `select public.enqueue_outbox_row($1,'whatsapp','9471','b',$2,null,null,null,'quotation',null,'quotation') as v`;
    expect((await q(call, [co, key])).rows[0].v).toBe("enqueued");
    expect((await q(call, [co, key])).rows[0].v).toBe("duplicate"); // a serial retry through the real RPC
    expect((await q(`select count(*)::int c from message_outbox where idempotency_key=$1`, [key])).rows[0].c).toBe(1);
  });

  it("a failed/dead message stays visible for operator recovery", async () => {
    const { ob } = await mkChain(co, { obStatus: "failed" });
    await q(`update message_outbox set status='dead', dead_at=now(), last_error='provider 500' where id=$1`, [ob]);
    const row = (await q(`select status, last_error, dead_at from message_outbox where id=$1 and company_id=$2`, [ob, co])).rows[0];
    expect(row.status).toBe("dead");
    expect(row.last_error).toMatch(/provider 500/);
    expect(row.dead_at).not.toBeNull();
  });

  it("a cross-company source id cannot be linked or advanced", async () => {
    const bChain = await mkChain(coB, { qStatus: "queued" }); // quotation in company B
    // An outbox row in company A whose source_id points at B's quotation.
    const obA = (await q(
      `insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, lock_owner, locked_at, lease_expires_at, source_type, source_id, message_purpose)
       values ($1,'whatsapp','9471','b',$2,'processing','wX', now(), now()+interval '2 minutes','quotation',$3,'quotation') returning id`,
      [co, "out_x_" + rnd(), bChain.quo])).rows[0].id;
    expect(await complete(obA, "wX")).toBe(true);            // the company-A outbox IS marked sent…
    expect(await statusOf("quotations", bChain.quo)).toBe("queued"); // …but B's quotation is untouched
    expect((await q(`select count(*)::int c from audit_events where entity_id=$1 and action='quotation.sent'`, [bChain.quo])).rows[0].c).toBe(0);
  });
});

// ── Concurrency: two workers cannot both complete the same row (row-lock serialisation) ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, c1: any, c2: any;
let cco: string, cOb: string;

describe.skipIf(!enabled)("WP12 completion concurrency — live, two connections", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } }); await c.connect(); return c; };
    setup = await mk();
    cco = (await setup.query(`insert into companies (name, base_currency) values ('wp12c','LKR') returning id`)).rows[0].id;
    const conv = (await setup.query(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [cco, "9471" + rnd()])).rows[0].id;
    const ord = (await setup.query(`insert into orders (company_id, conversation_id, status) values ($1,$2,'new') returning id`, [cco, conv])).rows[0].id;
    const quo = (await setup.query(`insert into quotations (company_id, order_id, quote_number, currency, status, public_token) values ($1,$2,$3,'LKR','queued',$4) returning id`, [cco, ord, "SQ-" + rnd(), "tok_" + rnd()])).rows[0].id;
    cOb = (await setup.query(
      `insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, lock_owner, locked_at, lease_expires_at, source_type, source_id, message_purpose)
       values ($1,'whatsapp','9471','b',$2,'processing','wRace', now(), now()+interval '2 minutes','quotation',$3,'quotation') returning id`,
      [cco, "out_" + rnd(), quo])).rows[0].id;
    c1 = await mk(); c2 = await mk();
  });
  afterAll(async () => {
    try { await c1?.query("rollback"); } catch { /* noop */ }
    try { await c2?.query("rollback"); } catch { /* noop */ }
    for (const sql of [`delete from audit_events where company_id=$1`, `delete from message_outbox where company_id=$1`, `delete from quotations where company_id=$1`, `delete from orders where company_id=$1`, `delete from wa_conversations where company_id=$1`, `delete from companies where id=$1`]) {
      try { await setup.query(sql, [cco]); } catch { /* noop */ }
    }
    await Promise.all([c1?.end(), c2?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("a second concurrent completion of the same row BLOCKS on the row lock (cannot both complete)", async () => {
    const sql = `select public.complete_outbox_and_advance($1,'wRace','wamid.R') as v`;
    await c1.query("begin");
    await c1.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    const r1 = await c1.query(sql, [cOb]); // completes + holds the row lock (uncommitted)
    expect(r1.rows[0].v).toBe(true);
    await c2.query("begin");
    await c2.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await c2.query("set local statement_timeout = '1500ms'");
    let blocked = false;
    try { await c2.query(sql, [cOb]); } catch (e) { blocked = /statement timeout|canceling statement/i.test((e as Error).message); }
    await c1.query("rollback").catch(() => {});
    await c2.query("rollback").catch(() => {});
    expect(blocked).toBe(true);
  });

  it("enqueue_outbox_row is atomic under real concurrency: two connections → one 'enqueued', one 'duplicate', exactly one row", async () => {
    // This exercises the PRODUCTION enqueue RPC (the same one the real application wrapper enqueueOutbox
    // invokes — proven in tests/outbox-enqueue.test.ts) under genuine two-connection concurrency. Its
    // INSERT … ON CONFLICT (idempotency_key) DO NOTHING can never yield two logical rows: whichever
    // connection commits first wins 'enqueued'; the other's insert conflicts → 'duplicate'.
    const key = "out_race_" + rnd();
    const call = `select public.enqueue_outbox_row($1,'whatsapp','9471','b',$2,null,null,null,'quotation',null,'quotation') as v`;
    await c1.query("begin");
    await c1.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    const r1 = await c1.query(call, [cco, key]); // inserts the row (uncommitted) → 'enqueued'
    expect(r1.rows[0].v).toBe("enqueued");

    await c2.query("begin");
    await c2.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    const p2 = c2.query(call, [cco, key]); // races for the same key: blocks on the unique index…
    await c1.query("commit");               // …c1 commits, so c2's insert now conflicts (DO NOTHING)
    const r2 = await p2;
    expect(r2.rows[0].v).toBe("duplicate");  // truthful: the concurrent enqueue is reported a duplicate
    await c2.query("rollback").catch(() => {});

    const cnt = (await setup.query(`select count(*)::int c from message_outbox where company_id=$1 and idempotency_key=$2`, [cco, key])).rows[0].c;
    expect(cnt).toBe(1); // exactly ONE logical row despite the concurrent enqueue
  });
});
