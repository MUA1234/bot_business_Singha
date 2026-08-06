/**
 * WP4 outbox idempotency — live against real Postgres, ZERO-PERSISTENCE. Proves the
 * transactional outbox's unique idempotency_key makes a duplicate enqueue a no-op
 * (a re-trigger / retry can never deliver twice), and that next_retry_at exists for
 * backoff (migration 0031).
 *
 * Skipped unless `DATABASE_URL` is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let company: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try {
    const r = await client.query(sql, params);
    await client.query("release savepoint s");
    return r;
  } catch (e) {
    await client.query("rollback to savepoint s");
    throw e;
  }
}
const ins = `insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status) values ($1,'whatsapp','94770000000','hi',$2,'pending')`;

describe.skipIf(!enabled)("outbox idempotency — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    company = (await client.query(`insert into companies (name, base_currency) values ('wp_ob','LKR') returning id`)).rows[0].id;
  });
  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("a duplicate idempotency_key is rejected (no double send)", async () => {
    await q(ins, [company, "out_dup1"]);
    let threw = false;
    try {
      await q(ins, [company, "out_dup1"]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // a different key enqueues fine
    await q(ins, [company, "out_dup2"]);
  });

  it("message_outbox has next_retry_at for backoff (0031)", async () => {
    const { rows } = await client.query(
      `select count(*)::int n from information_schema.columns where table_name='message_outbox' and column_name='next_retry_at'`,
    );
    expect(rows[0].n).toBe(1);
  });
});
