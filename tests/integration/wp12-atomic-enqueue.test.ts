/**
 * WP12 FINAL review, correction 1 — the ATOMIC quotation enqueue RPC (migration 0063) and the
 * DB-boundary quotation lifecycle. Live Postgres.
 *
 * The linearization point is the `SELECT … FOR UPDATE` on the company-scoped quotation row inside
 * `enqueue_quotation_outbox`. Under that single lock the RPC either creates a NEW pending outbox row and
 * advances ready→queued in the SAME transaction, or reports terminal / not_ready / stale / duplicate /
 * inconsistent — so a concurrent terminal transition can never leave a live pending row for a terminal
 * quotation, and two concurrent finalisers create exactly one logical row.
 *
 * These tests exercise the PRODUCTION RPC directly (not a mock, not a raw insert), including two real
 * PostgreSQL connections for the genuine races the review requires.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 12);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
async function seedQuotation(conn: any, company: string, status: string, total = "100", currency = "LKR") {
  const conv = (await conn.query(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [company, "9471" + rnd()])).rows[0].id;
  const ord = (await conn.query(`insert into orders (company_id, conversation_id, customer_phone, status) values ($1,$2,'9471','new') returning id`, [company, conv])).rows[0].id;
  const quo = (await conn.query(`insert into quotations (company_id, order_id, quote_number, currency, status, total, public_token) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [company, ord, "SQ-" + rnd(), currency, status, total, "tok_" + rnd()])).rows[0].id;
  // One priced item matching the stored total — 0067's enqueue guard requires the live item sum to equal
  // the expected total UNCONDITIONALLY (an item-less "ready" seed would now be `stale`).
  await conn.query(`insert into quotation_items (quotation_id, company_id, description, quantity, unit_price, currency, line_total, status) values ($1,$2,'item',1,$3,$4,$3,'priced')`,
    [quo, company, total, currency]);
  return { conv, ord, quo };
}
const ENQ = `select public.enqueue_quotation_outbox($1,$2,'9471','body',$3,$4,$5,'whatsapp','quotation') as v`;
const countRows = async (conn: any, key: string) => (await conn.query(`select count(*)::int c from message_outbox where idempotency_key=$1`, [key])).rows[0].c;
const statusOf = async (conn: any, quo: string) => (await conn.query(`select status from quotations where id=$1`, [quo])).rows[0].status;

describe.skipIf(!enabled)("0063 atomic quotation enqueue — single-connection (live, zero-persistence)", () => {
  let co: string, coB: string;
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    co = (await client.query(`insert into companies (name, base_currency) values ('atomic','LKR') returning id`)).rows[0].id;
    coB = (await client.query(`insert into companies (name, base_currency) values ('atomicB','LKR') returning id`)).rows[0].id;
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("terminal transition after the app read (quotation already sent) → 'terminal', zero new rows", async () => {
    const { quo } = await seedQuotation(client, co, "sent");
    const key = "k_" + rnd();
    const r = await q(ENQ, [co, quo, key, "100", "LKR"]);
    expect(r.rows[0].v).toBe("terminal");
    expect(await countRows(client, key)).toBe(0);
    expect(await statusOf(client, quo)).toBe("sent");
  });

  it.each(["accepted", "rejected"])("an already-%s quotation → 'terminal', zero mutation, zero row", async (st) => {
    const { quo } = await seedQuotation(client, co, st);
    const key = "k_" + rnd();
    expect((await q(ENQ, [co, quo, key, "100", "LKR"])).rows[0].v).toBe("terminal");
    expect(await countRows(client, key)).toBe(0);
    expect(await statusOf(client, quo)).toBe(st);
  });

  it("not_ready: a draft/awaiting_price quotation is never enqueued", async () => {
    for (const st of ["draft", "awaiting_price"]) {
      const { quo } = await seedQuotation(client, co, st);
      const key = "k_" + rnd();
      expect((await q(ENQ, [co, quo, key, "100", "LKR"])).rows[0].v, st).toBe("not_ready");
      expect(await countRows(client, key), st).toBe(0);
    }
  });

  it("stale: the total changed since the caller built the message → NOT queued, zero row", async () => {
    const { quo } = await seedQuotation(client, co, "ready", "100");
    const key = "k_" + rnd();
    const r = await q(ENQ, [co, quo, key, "999", "LKR"]); // expected 999 != current 100
    expect(r.rows[0].v).toBe("stale");
    expect(await countRows(client, key)).toBe(0);
    expect(await statusOf(client, quo)).toBe("ready");
  });

  it("stale: a currency mismatch is also rejected", async () => {
    const { quo } = await seedQuotation(client, co, "ready", "100", "LKR");
    const key = "k_" + rnd();
    expect((await q(ENQ, [co, quo, key, "100", "USD"])).rows[0].v).toBe("stale");
    expect(await countRows(client, key)).toBe(0);
  });

  it("enqueued: a ready quotation → one row AND queued, atomically coupled", async () => {
    const { quo } = await seedQuotation(client, co, "ready", "100");
    const key = "k_" + rnd();
    expect((await q(ENQ, [co, quo, key, "100", "LKR"])).rows[0].v).toBe("enqueued");
    expect(await countRows(client, key)).toBe(1);
    expect(await statusOf(client, quo)).toBe("queued");
    // coupling invariant: the row exists iff the quotation is queued/sent
    const rowExists = (await countRows(client, key)) === 1;
    const queued = (await statusOf(client, quo)) === "queued";
    expect(rowExists).toBe(queued);
  });

  it("atomicity: a rollback after the RPC undoes BOTH the row and the ready→queued flip", async () => {
    const { quo } = await seedQuotation(client, co, "ready", "100");
    const key = "k_" + rnd();
    await client.query("savepoint atom");
    expect((await client.query(ENQ, [co, quo, key, "100", "LKR"])).rows[0].v).toBe("enqueued");
    expect(await countRows(client, key)).toBe(1);
    expect(await statusOf(client, quo)).toBe("queued");
    await client.query("rollback to savepoint atom"); // simulate a transaction failure after the insert
    expect(await countRows(client, key)).toBe(0);       // row gone…
    expect(await statusOf(client, quo)).toBe("ready");  // …and status back to ready — never a partial state
  });

  it("duplicate: an existing queued quotation reconciles its EXACT existing row, no new enqueue", async () => {
    const { quo } = await seedQuotation(client, co, "queued", "100");
    const key = "k_" + rnd();
    await q(`insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, source_type, source_id, message_purpose) values ($1,'whatsapp','9471','b',$2,'pending','quotation',$3,'quotation')`, [co, key, quo]);
    const r = await q(ENQ, [co, quo, key, "100", "LKR"]);
    expect(r.rows[0].v).toBe("duplicate");
    expect(await countRows(client, key)).toBe(1); // no new row
    expect(await statusOf(client, quo)).toBe("queued");
  });

  it("inconsistent: a queued quotation whose key row is missing → fail closed", async () => {
    const { quo } = await seedQuotation(client, co, "queued", "100");
    const key = "k_" + rnd(); // no outbox row for this key
    expect((await q(ENQ, [co, quo, key, "100", "LKR"])).rows[0].v).toBe("inconsistent");
  });

  it("inconsistent: the idempotency key belongs to a DIFFERENT company/source → fail closed, no new row", async () => {
    const { quo: quoB } = await seedQuotation(client, coB, "queued", "100"); // company B row owns the key
    const key = "k_" + rnd();
    await q(`insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, source_type, source_id, message_purpose) values ($1,'whatsapp','9471','b',$2,'pending','quotation',$3,'quotation')`, [coB, key, quoB]);
    const { quo: quoA } = await seedQuotation(client, co, "ready", "100"); // company A tries the same key
    const r = await q(ENQ, [co, quoA, key, "100", "LKR"]);
    expect(r.rows[0].v).toBe("inconsistent");
    expect(await countRows(client, key)).toBe(1);           // only B's row; A created none
    expect(await statusOf(client, quoA)).toBe("ready");     // A unchanged
  });

  it("cross-company: enqueue for a quotation not in the caller's company → inconsistent", async () => {
    const { quo: quoB } = await seedQuotation(client, coB, "ready", "100");
    const key = "k_" + rnd();
    expect((await q(ENQ, [co, quoB, key, "100", "LKR"])).rows[0].v).toBe("inconsistent"); // wrong company
    expect(await countRows(client, key)).toBe(0);
  });

  it("lifecycle: a queued quotation cannot be directly accepted or rejected (trigger)", async () => {
    const { quo } = await seedQuotation(client, co, "queued", "100");
    for (const bad of ["accepted", "rejected"]) {
      let blocked = false;
      try { await q(`update quotations set status=$2 where id=$1`, [quo, bad]); }
      catch (e) { blocked = /illegal quotation status transition|lifecycle/i.test((e as Error).message); }
      expect(blocked, bad).toBe(true);
    }
  });

  it("lifecycle: the legal progression ready→queued→sent→accepted is allowed", async () => {
    const { quo } = await seedQuotation(client, co, "ready", "100");
    await q(`update quotations set status='queued' where id=$1`, [quo]);
    await q(`update quotations set status='sent', sent_at=now() where id=$1`, [quo]);
    await q(`update quotations set status='accepted' where id=$1`, [quo]);
    expect(await statusOf(client, quo)).toBe("accepted");
  });
});

// ── Two real connections: the genuine terminal-vs-enqueue and duplicate-finaliser races ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, c1: any, c2: any;
let cco: string;

describe.skipIf(!enabled)("0063 atomic quotation enqueue — two-connection races (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } }); await c.connect(); await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`); return c; };
    setup = await mk();
    cco = (await setup.query(`insert into companies (name, base_currency) values ('atomicRace','LKR') returning id`)).rows[0].id;
    c1 = await mk(); c2 = await mk();
  });
  afterAll(async () => {
    try { await c1?.query("rollback"); } catch { /* noop */ }
    try { await c2?.query("rollback"); } catch { /* noop */ }
    for (const sql of [`delete from message_outbox where company_id=$1`, `delete from quotations where company_id=$1`, `delete from orders where company_id=$1`, `delete from wa_conversations where company_id=$1`, `delete from companies where id=$1`]) {
      try { await setup.query(sql, [cco]); } catch { /* noop */ }
    }
    await Promise.all([c1?.end(), c2?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("terminal WINS the race: a concurrent sent transition commits first → enqueue returns 'terminal', zero rows", async () => {
    const { quo } = await seedQuotation(setup, cco, "ready", "100");
    const key = "k_" + rnd();
    await c1.query("begin");
    await c1.query(`update quotations set status='sent', sent_at=now() where id=$1 and status='ready'`, [quo]); // holds the row lock
    await c2.query("begin");
    const p2 = c2.query(ENQ, [cco, quo, key, "100", "LKR"]); // blocks on the quotation row lock
    await c1.query("commit");                                 // terminal wins
    const r2 = await p2;
    expect(r2.rows[0].v).toBe("terminal");
    await c2.query("commit").catch(() => {});
    expect(await countRows(setup, key)).toBe(0);              // no live pending row for a terminal quotation
    expect(await statusOf(setup, quo)).toBe("sent");
  });

  it("enqueue WINS the race: it commits first → one row + queued; a concurrent direct queued→accepted then FAILS", async () => {
    const { quo } = await seedQuotation(setup, cco, "ready", "100");
    const key = "k_" + rnd();
    await c1.query("begin");
    const r1 = await c1.query(ENQ, [cco, quo, key, "100", "LKR"]); // enqueues + queued, holds the lock
    expect(r1.rows[0].v).toBe("enqueued");
    await c2.query("begin");
    const p2 = c2.query(`update quotations set status='accepted' where id=$1`, [quo]); // blocks on the lock
    await c1.query("commit");                                                          // enqueue wins → queued
    let blocked = false;
    try { await p2; } catch (e) { blocked = /illegal quotation status transition|lifecycle/i.test((e as Error).message); }
    await c2.query("rollback").catch(() => {});
    expect(blocked).toBe(true);                     // queued→accepted is illegal once enqueue won
    expect(await countRows(setup, key)).toBe(1);    // exactly one row
    expect(await statusOf(setup, quo)).toBe("queued");
  });

  it("two concurrent finalisers → exactly one logical outbox row (one enqueued, one duplicate)", async () => {
    const { quo } = await seedQuotation(setup, cco, "ready", "100");
    const key = "k_" + rnd();
    await c1.query("begin");
    const r1 = await c1.query(ENQ, [cco, quo, key, "100", "LKR"]); // enqueues, holds the lock
    expect(r1.rows[0].v).toBe("enqueued");
    await c2.query("begin");
    const p2 = c2.query(ENQ, [cco, quo, key, "100", "LKR"]); // blocks on the lock
    await c1.query("commit");
    const r2 = await p2;                                      // sees queued under the lock → duplicate
    expect(r2.rows[0].v).toBe("duplicate");
    await c2.query("commit").catch(() => {});
    expect(await countRows(setup, key)).toBe(1);             // exactly one logical row
    expect(await statusOf(setup, quo)).toBe("queued");
  });
});
