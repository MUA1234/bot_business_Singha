/**
 * WP1 RLS coverage guard — live against real Postgres, READ-ONLY. Asserts that every
 * company-scoped table (has a `company_id` column) has:
 *   - row level security ENABLED, and
 *   - a SELECT (or ALL) read policy — the prerequisite for moving app reads off the
 *     service-role client onto the authenticated RLS client (§WP1 cutover).
 *
 * A table that trips this is either an isolation hole (RLS off) or would return empty
 * under the authenticated client (RLS on, no read policy). Intentional exceptions are
 * allowlisted with a reason.
 *
 * Skipped unless `DATABASE_URL` is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// Tables that intentionally have NO user read policy (worker/service-role only).
const NO_READ_POLICY_OK = new Set<string>(["dead_letter_events", "ai_model_attempts"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

describe.skipIf(!enabled)("RLS coverage on company-scoped tables — live, read-only", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
  });
  afterAll(async () => {
    if (client) await client.end().catch(() => {});
  });

  it("every company-scoped table has RLS enabled", async () => {
    const { rows } = await client.query(`
      select c.relname
      from information_schema.columns col
      join pg_class c on c.relname = col.table_name and c.relkind = 'r'
      where col.table_schema = 'public' and col.column_name = 'company_id'
        and c.relnamespace = 'public'::regnamespace and c.relrowsecurity = false`);
    const disabled = rows.map((r: { relname: string }) => r.relname);
    expect(disabled, `RLS disabled on: ${disabled.join(", ")}`).toEqual([]);
  });

  it("every company-scoped table has a read policy (except worker-only allowlist)", async () => {
    const scoped = (
      await client.query(`select distinct table_name from information_schema.columns where table_schema='public' and column_name='company_id'`)
    ).rows.map((r: { table_name: string }) => r.table_name);
    const withRead = new Set(
      (await client.query(`select tablename from pg_policies where schemaname='public' and cmd in ('SELECT','ALL')`)).rows.map(
        (r: { tablename: string }) => r.tablename,
      ),
    );
    const missing = scoped.filter((t: string) => !withRead.has(t) && !NO_READ_POLICY_OK.has(t));
    expect(missing, `company-scoped tables missing a read policy: ${missing.join(", ")}`).toEqual([]);
  });

  it("audits a healthy number of scoped tables (sanity)", async () => {
    const { rows } = await client.query(`select count(distinct table_name)::int n from information_schema.columns where table_schema='public' and column_name='company_id'`);
    expect(rows[0].n).toBeGreaterThan(100);
  });
});
