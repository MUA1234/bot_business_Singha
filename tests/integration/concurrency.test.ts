/**
 * WP2 concurrency — live, TWO real connections. Proves migration 0037's `FOR UPDATE`
 * row lock serialises concurrent settlements: while connection #1 holds an in-progress
 * settlement of an invoice, connection #2's settlement of the SAME invoice BLOCKS on
 * the lock (observed via a statement timeout). Without the lock, #2 would read a stale
 * amount and over-settle.
 *
 * Setup rows are committed and cleaned up in afterAll; both settlement transactions are
 * ROLLED BACK, so no journals/payments persist. Skipped unless `DATABASE_URL` is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { authClaims, seedCapableActor, TEST_ACTOR } from "./helpers/capable-actor";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, c1: any, c2: any;
let company: string, poster: string, invoice: string;

const settle = (amount: number) =>
  `select public.settle_customer_invoice($1,$2,${amount},'1000','1100',$3,'2026-07-15')`;

describe.skipIf(!enabled)("settlement concurrency — live, two connections", () => {
  beforeAll(async () => {
    // Production safety guard: these tests COMMIT then delete rows — never run them
    // against the production database host.
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
    company = (await setup.query(`insert into companies (name, base_currency) values ('wp_conc','LKR') returning id`)).rows[0].id;
    await seedCapableActor(setup, company);
    poster = TEST_ACTOR;   // FOUND-006/0086: the acting human is the JWT subject
    await setup.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'1100','AR','asset')`, [company]);
    const customer = (await setup.query(`insert into customers (company_id, name) values ($1,'Conc') returning id`, [company])).rows[0].id;
    invoice = (
      await setup.query(
        `insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, total_amount, amount_settled, status)
         values ($1, $2, 'INV-CONC','LKR','2026-07-01',100,0,'issued') returning id`,
        [company, customer],
      )
    ).rows[0].id;
    c1 = await mk();
    c2 = await mk();
  });

  afterAll(async () => {
    try { await c1?.query("rollback"); } catch { /* noop */ }
    try { await c2?.query("rollback"); } catch { /* noop */ }
    // Cleanup committed setup rows (no posted journals persisted — both txns rolled back).
    for (const sql of [
      `delete from payments where company_id=$1`,
      `delete from customer_invoices where company_id=$1`,
      `delete from chart_of_accounts where company_id=$1`,
      `delete from customers where company_id=$1`,
      `delete from memberships where company_id=$1`,
      `delete from companies where id=$1`,
    ]) {
      try { await setup.query(sql, [company]); } catch { /* noop */ }
    }
    try { await setup.query(`delete from users where id=$1`, [poster]); } catch { /* noop */ }
    await Promise.all([c1?.end(), c2?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("a second concurrent settlement BLOCKS on the FOR UPDATE lock", async () => {
    // #1 begins a settlement and holds the invoice row lock (not committed).
    await c1.query("begin");
    await c1.query(`select set_config('request.jwt.claims', '${authClaims()}', true)`);
    await c1.query(settle(100), [company, invoice, poster]);

    // #2 tries the same invoice with a short statement timeout — it must block, then time out.
    await c2.query("begin");
    await c2.query(`select set_config('request.jwt.claims', '${authClaims()}', true)`);
    await c2.query("set local statement_timeout = '1500ms'");
    let blocked = false;
    try {
      await c2.query(settle(100), [company, invoice, poster]);
    } catch (e) {
      // 57014 = query canceled (statement timeout) → it was waiting on #1's lock.
      blocked = /statement timeout|canceling statement/i.test((e as Error).message);
    }
    expect(blocked).toBe(true);
  });
});
