/**
 * WP2 posting hardening — live, ZERO-PERSISTENCE. Proves migration 0035:
 *   - caller idempotency: two posts with the same key return the SAME journal (no dup)
 *   - fail-closed audit: a posted journal writes an audit_events row in the same txn
 *
 * Skipped unless `DATABASE_URL` is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let company: string, poster: string;

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
const lines = JSON.stringify([
  { account_code: "1000", debit: "100", credit: "0", description: "x" },
  { account_code: "4000", debit: "0", credit: "100", description: "y" },
]);
async function post(key: string | null) {
  const r = await q(`select public.post_manual_journal($1,'2026-07-15','LKR','memo',$2,$3::jsonb,$4) as id`, [company, poster, lines, key]);
  return r.rows[0].id as string;
}

describe.skipIf(!enabled)("posting hardening — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    company = (await client.query(`insert into companies (name, base_currency) values ('wp_ph','LKR') returning id`)).rows[0].id;
    poster = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'wp_ph_p',true) returning id`)).rows[0].id;
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'4000','Sales','income')`, [company]);
  });
  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("caller idempotency: same key returns the same journal (no duplicate)", async () => {
    const j1 = await post("idem-key-1");
    const j2 = await post("idem-key-1");
    expect(j2).toBe(j1);
    const n = await q(`select count(*)::int c from journal_entries where company_id=$1 and idempotency_key='idem-key-1'`, [company]);
    expect(n.rows[0].c).toBe(1); // exactly one journal, not two
  });

  it("distinct keys produce distinct journals", async () => {
    const a = await post("idem-key-a");
    const b = await post("idem-key-b");
    expect(a).not.toBe(b);
  });

  it("fail-closed audit: a posted journal writes a journal.posted audit event", async () => {
    const j = await post("idem-key-audit");
    const a = await q(`select count(*)::int c from audit_events where entity_id=$1 and action='journal.posted' and company_id=$2`, [j, company]);
    expect(a.rows[0].c).toBe(1);
  });
});
