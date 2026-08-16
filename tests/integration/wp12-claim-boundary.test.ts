/**
 * WP12 FINAL review — finding 1: the scheduled drain (`claim_outbox_batch`) must not be able to send a
 * STALE quotation-outbox row. A quotation-delivery row is now claimable ONLY when its linked quotation is
 * committed `queued` (the proof that the atomic enqueue / exact recovery actually succeeded). A row left
 * `pending` after `enqueue_quotation_outbox` returned `inconsistent` (stale payload) stays behind a
 * `ready` quotation and is therefore unclaimable — it can never be leased, sent, or advanced `ready→sent`.
 *
 * Generic (non-quotation) outbox rows keep the original retry / lease / SKIP-LOCKED eligibility. The RPC
 * stays service-only. These tests use REAL PostgreSQL roles: the drain runs as `service_role` (as the
 * scheduler does), and `authenticated` is proven unable to call it at all.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 12);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, coOther: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}

// Run each test in its own savepoint so the claim mutations (rows → processing) and the seeds never leak
// into another test — every test reasons about EXACTLY the rows it created.
async function isolate(fn: () => Promise<void>) {
  await client.query("savepoint t");
  try { await fn(); } finally { await client.query("rollback to savepoint t"); }
}

async function seedQuotation(company: string, status: string, total = "100", currency = "LKR") {
  const conv = (await q(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [company, "9471" + rnd()])).rows[0].id;
  const ord = (await q(`insert into orders (company_id, conversation_id, customer_phone, status) values ($1,$2,'9471','new') returning id`, [company, conv])).rows[0].id;
  const quo = (await q(`insert into quotations (company_id, order_id, quote_number, currency, status, total, public_token) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [company, ord, "SQ-" + rnd(), currency, status, total, "tok_" + rnd()])).rows[0].id;
  return quo as string;
}

// Insert a raw outbox row with full control over the delivery-identity fields; returns { id, key }.
async function insertOutbox(o: {
  company?: string; status?: string; source_type?: string | null; source_id?: string | null;
  message_purpose?: string | null; channel?: string; recipient?: string; body?: string;
  next_retry_at?: string | null; lock_owner?: string | null; lease_expires_at?: string | null;
}): Promise<{ id: string; key: string }> {
  const key = "k_" + rnd();
  const r = await q(
    `insert into message_outbox
       (company_id, channel, recipient, body, idempotency_key, status, attempts,
        source_type, source_id, message_purpose, next_retry_at, lock_owner, lease_expires_at)
     values ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12) returning id`,
    [o.company ?? co, o.channel ?? "whatsapp", o.recipient ?? "9471", o.body ?? "body", key,
     o.status ?? "pending", o.source_type ?? null, o.source_id ?? null, o.message_purpose ?? null,
     o.next_retry_at ?? null, o.lock_owner ?? null, o.lease_expires_at ?? null]);
  return { id: r.rows[0].id, key };
}

// The scheduled drain, run as the REAL service_role (as the worker does). Returns the claimed rows.
async function claimAsService(owner = "drain-" + rnd(), limit = 500): Promise<Array<{ id: string; status: string }>> {
  await client.query("savepoint cl");
  try {
    await client.query("set local role service_role");
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    const r = await client.query(`select id, status from public.claim_outbox_batch($1,$2,120)`, [limit, owner]);
    await client.query("reset role");
    await client.query("release savepoint cl");
    return r.rows;
  } catch (e) { await client.query("rollback to savepoint cl"); throw e; }
}

const statusOf = async (quo: string) => (await q(`select status from quotations where id=$1`, [quo])).rows[0].status;
const outboxStatusOf = async (id: string) => (await q(`select status from message_outbox where id=$1`, [id])).rows[0].status;
const ENQ = `select public.enqueue_quotation_outbox($1,$2,$3,$4,$5,$6,$7,'whatsapp','quotation') as v`;

describe.skipIf(!enabled)("0065 claim boundary — a quotation row is claimable only when its quotation is `queued` (live, real roles)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    co = (await client.query(`insert into companies (name, base_currency) values ('claimA','LKR') returning id`)).rows[0].id;
    coOther = (await client.query(`insert into companies (name, base_currency) values ('claimB','LKR') returning id`)).rows[0].id;
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  // ── core gate: `ready` (not yet queued) → unclaimable ──
  it("a consistent pending quotation row whose quotation is `ready` is NOT claimable, and stays pending", async () => {
    await isolate(async () => {
      const quo = await seedQuotation(co, "ready");
      const { id } = await insertOutbox({ source_type: "quotation", message_purpose: "quotation", source_id: quo });
      const claimed = await claimAsService();
      expect(claimed.map(r => r.id)).not.toContain(id);
      expect(await outboxStatusOf(id)).toBe("pending"); // untouched — not leased, not drained
    });
  });

  it("the SAME row becomes claimable only after exact recovery advances the quotation `ready→queued`", async () => {
    await isolate(async () => {
      const quo = await seedQuotation(co, "ready", "120");
      // an exact legacy pending row (matches the enqueue payload the app will present)
      const { id, key } = await insertOutbox({ source_type: "quotation", message_purpose: "quotation", source_id: quo, body: "body-120" });
      // while ready → unclaimable
      expect((await claimAsService()).map(r => r.id)).not.toContain(id);
      expect(await outboxStatusOf(id)).toBe("pending");
      // exact recovery → duplicate, quotation ready→queued
      expect((await q(ENQ, [co, quo, "9471", "body-120", key, "120", "LKR"])).rows[0].v).toBe("duplicate");
      expect(await statusOf(quo)).toBe("queued");
      // now claimable
      const claimed = await claimAsService();
      expect(claimed.map(r => r.id)).toContain(id);
      expect(await outboxStatusOf(id)).toBe("processing");
    });
  });

  // ── the headline finding-1 scenario: a STALE row must never be drained ──
  it("a STALE existing row → enqueue `inconsistent`, quotation stays `ready`, and the stale row is never claimed or drained", async () => {
    await isolate(async () => {
      const quo = await seedQuotation(co, "ready", "120");
      // a pre-existing pending row carrying the OLD body (100); the quotation was later repriced to 120
      const { id, key } = await insertOutbox({ source_type: "quotation", message_purpose: "quotation", source_id: quo, body: "body-100" });
      expect((await q(ENQ, [co, quo, "9471", "body-120", key, "120", "LKR"])).rows[0].v).toBe("inconsistent");
      expect(await statusOf(quo)).toBe("ready"); // never queued
      const claimed = await claimAsService();
      expect(claimed.map(r => r.id)).not.toContain(id); // scheduled drain cannot pick up the stale row
      expect(await outboxStatusOf(id)).toBe("pending"); // still pending — never leased/sent
    });
  });

  it.each([
    ["wrong recipient", { recipient: "9999" }],
    ["wrong channel", { channel: "email" }],
    ["wrong body", { body: "body-999" }],
  ])("a `ready` quotation with a mismatched pending row (%s) is unclaimable and enqueue is `inconsistent`", async (_label, overrides) => {
    await isolate(async () => {
      const quo = await seedQuotation(co, "ready", "120");
      const { id, key } = await insertOutbox({ source_type: "quotation", message_purpose: "quotation", source_id: quo, body: "body-120", ...(overrides as object) });
      expect((await q(ENQ, [co, quo, "9471", "body-120", key, "120", "LKR"])).rows[0].v).toBe("inconsistent");
      expect((await claimAsService()).map(r => r.id)).not.toContain(id);
      expect(await outboxStatusOf(id)).toBe("pending");
      expect(await statusOf(quo)).toBe("ready");
    });
  });

  // ── malformed / cross-identity rows are unclaimable EVEN IF a queued quotation exists (fail closed) ──
  it("a malformed quotation-purpose row (source_type='quotation', purpose≠'quotation') is unclaimable even with a queued quotation", async () => {
    await isolate(async () => {
      const quo = await seedQuotation(co, "queued");
      const { id } = await insertOutbox({ source_type: "quotation", message_purpose: "reminder", source_id: quo });
      expect((await claimAsService()).map(r => r.id)).not.toContain(id); // fails the quotation branch, fails the generic branch
      expect(await outboxStatusOf(id)).toBe("pending");
    });
  });

  it("a malformed row (source_type≠'quotation', purpose='quotation') is unclaimable even with a queued quotation", async () => {
    await isolate(async () => {
      const quo = await seedQuotation(co, "queued");
      const { id } = await insertOutbox({ source_type: "email", message_purpose: "quotation", source_id: quo });
      expect((await claimAsService()).map(r => r.id)).not.toContain(id);
      expect(await outboxStatusOf(id)).toBe("pending");
    });
  });

  it("a cross-company row (row in company A referencing a queued quotation in company B) is unclaimable", async () => {
    await isolate(async () => {
      const quoB = await seedQuotation(coOther, "queued");
      const { id } = await insertOutbox({ company: co, source_type: "quotation", message_purpose: "quotation", source_id: quoB });
      expect((await claimAsService()).map(r => r.id)).not.toContain(id); // exists() requires q.company_id = row.company_id
      expect(await outboxStatusOf(id)).toBe("pending");
    });
  });

  it("a quotation-purpose row with a NULL source_id is unclaimable", async () => {
    await isolate(async () => {
      const { id } = await insertOutbox({ source_type: "quotation", message_purpose: "quotation", source_id: null });
      expect((await claimAsService()).map(r => r.id)).not.toContain(id);
      expect(await outboxStatusOf(id)).toBe("pending");
    });
  });

  it("a quotation-purpose row whose source_id points at no quotation is unclaimable", async () => {
    await isolate(async () => {
      const { id } = await insertOutbox({ source_type: "quotation", message_purpose: "quotation", source_id: "00000000-0000-0000-0000-000000000000" });
      expect((await claimAsService()).map(r => r.id)).not.toContain(id);
      expect(await outboxStatusOf(id)).toBe("pending");
    });
  });

  // ── generic (non-quotation) rows keep the original claimability ──
  it("ordinary non-quotation outbox rows remain claimable (both fields non-quotation, or null)", async () => {
    await isolate(async () => {
      const a = await insertOutbox({ source_type: "reminder", message_purpose: "reminder" });
      const b = await insertOutbox({ source_type: null, message_purpose: null });
      const c = await insertOutbox({ source_type: "broadcast", message_purpose: "marketing", source_id: "11111111-1111-1111-1111-111111111111" });
      const claimed = (await claimAsService()).map(r => r.id);
      expect(claimed).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
      for (const { id } of [a, b, c]) expect(await outboxStatusOf(id)).toBe("processing");
    });
  });

  // ── retry / lease eligibility is preserved AND still gated by the queued quotation ──
  it("a FAILED quotation row is re-claimable only when due AND the quotation is `queued`", async () => {
    await isolate(async () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const future = new Date(Date.now() + 3600_000).toISOString();
      const quoQueued = await seedQuotation(co, "queued");
      const quoReady = await seedQuotation(co, "ready");
      const dueQueued = await insertOutbox({ status: "failed", next_retry_at: past, source_type: "quotation", message_purpose: "quotation", source_id: quoQueued });
      const dueReady = await insertOutbox({ status: "failed", next_retry_at: past, source_type: "quotation", message_purpose: "quotation", source_id: quoReady });
      const notDue = await insertOutbox({ status: "failed", next_retry_at: future, source_type: "quotation", message_purpose: "quotation", source_id: quoQueued });
      const claimed = (await claimAsService()).map(r => r.id);
      expect(claimed).toContain(dueQueued.id);      // due + queued → retried
      expect(claimed).not.toContain(dueReady.id);   // due but quotation only ready → still gated out
      expect(claimed).not.toContain(notDue.id);     // queued but not yet due → retry backoff preserved
    });
  });

  it("a lease-EXPIRED processing quotation row is re-claimable only when the quotation is `queued`", async () => {
    await isolate(async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const quoQueued = await seedQuotation(co, "queued");
      const quoReady = await seedQuotation(co, "ready");
      const expiredQueued = await insertOutbox({ status: "processing", lock_owner: "stale-worker", lease_expires_at: past, source_type: "quotation", message_purpose: "quotation", source_id: quoQueued });
      const expiredReady = await insertOutbox({ status: "processing", lock_owner: "stale-worker", lease_expires_at: past, source_type: "quotation", message_purpose: "quotation", source_id: quoReady });
      const claimed = (await claimAsService()).map(r => r.id);
      expect(claimed).toContain(expiredQueued.id);
      expect(claimed).not.toContain(expiredReady.id);
    });
  });

  // ── end-to-end: the gate does not break the happy path; completion still advances queued→sent ──
  it("happy path: enqueue → queued → claim leases the row → completion advances queued→sent", async () => {
    await isolate(async () => {
      const quo = await seedQuotation(co, "ready", "100");
      const key = "k_" + rnd();
      expect((await q(ENQ, [co, quo, "9471", "body", key, "100", "LKR"])).rows[0].v).toBe("enqueued");
      expect(await statusOf(quo)).toBe("queued");
      const obId = (await q(`select id from message_outbox where idempotency_key=$1`, [key])).rows[0].id;
      const owner = "drain-e2e";
      const claimed = (await claimAsService(owner)).map(r => r.id);
      expect(claimed).toContain(obId); // now claimable
      expect(await outboxStatusOf(obId)).toBe("processing");
      // completion (fenced, service-only) advances queued→sent
      await client.query("savepoint cp");
      await client.query("set local role service_role");
      await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
      const done = await client.query(`select public.complete_outbox_and_advance($1,$2,'wamid.OK') as v`, [obId, owner]);
      await client.query("reset role");
      await client.query("release savepoint cp");
      expect(done.rows[0].v).toBe(true);
      expect(await statusOf(quo)).toBe("sent");
      expect(await outboxStatusOf(obId)).toBe("sent");
    });
  });

  // ── service-only: the drain is not callable by authenticated ──
  it("claim_outbox_batch is service-only: `authenticated` is refused (42501); `service_role` succeeds", async () => {
    await isolate(async () => {
      // authenticated → permission denied
      await client.query("savepoint p1");
      let code: string | undefined;
      try {
        await client.query("set local role authenticated");
        await client.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
        await client.query(`select public.claim_outbox_batch(1,'probe',120)`);
        await client.query("reset role");
      } catch (e) { code = (e as { code?: string }).code; await client.query("rollback to savepoint p1"); }
      expect(code).toBe("42501");
      // service_role → allowed (no throw)
      await expect(claimAsService()).resolves.toBeDefined();
    });
  });
});
