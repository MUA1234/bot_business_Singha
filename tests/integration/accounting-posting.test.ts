/**
 * WP2 accounting posting controls — live against real Postgres, ZERO-PERSISTENCE
 * (transaction + savepoints + ROLLBACK). Exercises the atomic `post_manual_journal`
 * RPC (migration 0015) end-to-end and proves it enforces, in the database:
 *   - balanced journals post; unbalanced are rejected (§WP2 "balanced/unbalanced")
 *   - a closed/locked period rejects posting (§WP2 "closed/locked period")
 *   - unknown/inactive account and <2 lines are rejected
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
async function post(dateIso: string, lines: unknown[]): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const r = await q(`select public.post_manual_journal($1::uuid,$2::date,'LKR','test',$3::uuid,$4::jsonb) as id`, [
      company,
      dateIso,
      poster,
      JSON.stringify(lines),
    ]);
    return { ok: true, id: r.rows[0].id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
const L = (code: string, debit: number, credit: number) => ({ account_code: code, debit: String(debit), credit: String(credit), description: "x" });

describe.skipIf(!enabled)("accounting posting controls — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    company = (await client.query(`insert into companies (name, base_currency) values ('wp_acc','LKR') returning id`)).rows[0].id;
    poster = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'wp_acc_poster',true) returning id`)).rows[0].id;
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'4000','Sales','income')`, [company]);
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("posts a balanced journal (header + 2 lines) — no period", async () => {
    const res = await post("2026-07-15", [L("1000", 100, 0), L("4000", 0, 100)]);
    expect(res.ok).toBe(true);
    const lines = await q(`select count(*)::int n from journal_lines where journal_id = $1`, [res.id]);
    expect(lines.rows[0].n).toBe(2);
  });

  it("rejects an unbalanced journal", async () => {
    const res = await post("2026-07-15", [L("1000", 100, 0), L("4000", 0, 90)]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unbalanced/i);
  });

  it("rejects an unknown/inactive account", async () => {
    const res = await post("2026-07-15", [L("1000", 100, 0), L("9999", 0, 100)]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found or inactive/i);
  });

  it("rejects a single-line journal", async () => {
    const res = await post("2026-07-15", [L("1000", 100, 0)]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/at least two lines/i);
  });

  it("rejects posting into a CLOSED period", async () => {
    const fy = (await client.query(`insert into fiscal_years (company_id, name, start_date, end_date) values ($1,'FY26','2026-01-01','2026-12-31') returning id`, [company])).rows[0].id;
    await client.query(`insert into accounting_periods (company_id, fiscal_year_id, name, start_date, end_date, status) values ($1,$2,'Aug26','2026-08-01','2026-08-31','closed')`, [company, fy]);
    const res = await post("2026-08-15", [L("1000", 100, 0), L("4000", 0, 100)]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/closed|locked/i);
  });
});
