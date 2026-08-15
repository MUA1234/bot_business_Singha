/**
 * WP B RPC concurrency — live, TWO real connections. Proves the FOR UPDATE lock in
 * reverse_journal (0039) serialises a concurrent double-reverse: while connection #1
 * holds an in-progress reversal of a journal, connection #2's reversal of the SAME
 * journal BLOCKS on the lock (observed via a statement timeout). Combined with the
 * idempotency-on-key behaviour (see accounting-rpc-hardening), this guarantees exactly
 * one reversal journal even under a race.
 *
 * Setup rows are committed then cleaned up; both reversal transactions are rolled back,
 * so no journals persist. Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, c1: any, c2: any;
let company: string, poster: string, journal: string;

describe.skipIf(!enabled)("reversal concurrency — live, two connections", () => {
  beforeAll(async () => {
    if (process.env.PRODUCTION_DB_HOST && URL.includes(process.env.PRODUCTION_DB_HOST)) {
      throw new Error("refusing to run write/commit integration tests against the production database host");
    }
    const { default: pg } = await import("pg" as string);
    const mk = async () => {
      const c = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
      await c.connect();
      return c;
    };
    setup = await mk();
    // setup autocommits (no txn), so set the service_role claim at SESSION level for its
    // service-path post below (WP17/0049).
    await setup.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    company = (await setup.query(`insert into companies (name, base_currency) values ('wp_revconc','LKR') returning id`)).rows[0].id;
    poster = (await setup.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'wp_revconc_p',true) returning id`)).rows[0].id;
    await setup.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'1100','AR','asset')`, [company]);
    // Post a journal to reverse (worker path — no JWT).
    journal = (
      await setup.query(
        `select public.post_manual_journal($1,'2026-07-15','LKR','conc', $2,
           '[{"account_code":"1000","debit":"100","credit":"0"},{"account_code":"1100","debit":"0","credit":"100"}]'::jsonb, 'JCONC') as id`,
        [company, poster],
      )
    ).rows[0].id;
    c1 = await mk();
    c2 = await mk();
  });

  afterAll(async () => {
    try { await c1?.query("rollback"); } catch { /* noop */ }
    try { await c2?.query("rollback"); } catch { /* noop */ }
    for (const sql of [
      `delete from journal_lines where company_id=$1`,
      `delete from journal_entries where company_id=$1`,
      `delete from chart_of_accounts where company_id=$1`,
      `delete from audit_events where company_id=$1`,
      `delete from companies where id=$1`,
    ]) {
      try { await setup.query(sql, [company]); } catch { /* noop */ }
    }
    try { await setup.query(`delete from users where id=$1`, [poster]); } catch { /* noop */ }
    await Promise.all([c1?.end(), c2?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("a second concurrent reversal BLOCKS on the FOR UPDATE lock", async () => {
    await c1.query("begin");
    await c1.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await c1.query(`select public.reverse_journal($1,$2,$3,'2026-07-16','R1')`, [company, journal, poster]);

    await c2.query("begin");
    await c2.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await c2.query("set local statement_timeout = '1500ms'");
    let blocked = false;
    try {
      await c2.query(`select public.reverse_journal($1,$2,$3,'2026-07-16','R2')`, [company, journal, poster]);
    } catch (e) {
      blocked = /statement timeout|canceling statement/i.test((e as Error).message);
    }
    expect(blocked).toBe(true);
  });
});
