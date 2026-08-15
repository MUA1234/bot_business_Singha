/**
 * WP9 concurrency evidence — TWO real connections. Proves the FOR UPDATE locks in the new
 * transactional RPCs serialise concurrent operations on the same source row:
 *   - invoice double-post (post_customer_invoice locks the invoice)
 *   - supplier bank-change double-approval (decide_supplier_bank_change locks the change + supplier)
 * While connection #1 holds the in-progress lock, connection #2's same operation BLOCKS
 * (observed via a statement timeout). Combined with idempotency/lifecycle checks, exactly
 * one journal/decision results. Setup rows are committed then cleaned up; both operations
 * are rolled back. Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, c1: any, c2: any;
let co: string, inv: string, change: string, poster: string, checker: string;

async function blocksOnLock(hold: string, holdParams: unknown[], contend: string, contendParams: unknown[]): Promise<boolean> {
  await c1.query("begin");
  await c1.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  await c1.query(hold, holdParams);
  await c2.query("begin");
  await c2.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  await c2.query("set local statement_timeout = '1500ms'");
  let blocked = false;
  try { await c2.query(contend, contendParams); } catch (e) { blocked = /statement timeout|canceling statement/i.test((e as Error).message); }
  await c1.query("rollback").catch(() => {});
  await c2.query("rollback").catch(() => {});
  return blocked;
}

describe.skipIf(!enabled)("finance concurrency — live, two connections", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } }); await c.connect(); return c; };
    setup = await mk();
    co = (await setup.query(`insert into companies (name, base_currency) values ('fconc','LKR') returning id`)).rows[0].id;
    await setup.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1100','AR','asset'),($1,'4000','Sales','income')`, [co]);
    poster = (await setup.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'fc_p',true) returning id`)).rows[0].id;
    checker = (await setup.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'fc_c',true) returning id`)).rows[0].id;
    const cust = (await setup.query(`insert into customers (company_id, name, status) values ($1,'C','active') returning id`, [co])).rows[0].id;
    inv = (await setup.query(`insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, total_amount, amount_settled, status) values ($1,$2,'INV-FC','LKR','2026-07-01',100,0,'draft') returning id`, [co, cust])).rows[0].id;
    await setup.query(`insert into customer_invoice_lines (invoice_id, company_id, description, unit_price, amount) values ($1,$2,'x',100,100)`, [inv, co]); // WP15: header == line total so the post proceeds to the FOR UPDATE lock
    const sup = (await setup.query(`insert into suppliers (company_id, name, status) values ($1,'S','active') returning id`, [co])).rows[0].id;
    change = (await setup.query(`insert into supplier_bank_detail_changes (company_id, supplier_id, new_account_number, requested_by, status) values ($1,$2,'7777',$3,'pending') returning id`, [co, sup, poster])).rows[0].id;
    c1 = await mk(); c2 = await mk();
  });
  afterAll(async () => {
    try { await c1?.query("rollback"); } catch { /* noop */ }
    try { await c2?.query("rollback"); } catch { /* noop */ }
    for (const sql of [`delete from journal_lines where company_id=$1`, `delete from journal_entries where company_id=$1`, `delete from supplier_bank_detail_changes where company_id=$1`, `delete from customer_invoices where company_id=$1`, `delete from customers where company_id=$1`, `delete from suppliers where company_id=$1`, `delete from chart_of_accounts where company_id=$1`, `delete from audit_events where company_id=$1`, `delete from companies where id=$1`]) {
      try { await setup.query(sql, [co]); } catch { /* noop */ }
    }
    try { await setup.query(`delete from users where id in ($1,$2)`, [poster, checker]); } catch { /* noop */ }
    await Promise.all([c1?.end(), c2?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("a second concurrent invoice post BLOCKS on the FOR UPDATE lock", async () => {
    const sql = `select public.post_customer_invoice($1,$2,'1100','4000',$3,'2026-07-15','ipc')`;
    expect(await blocksOnLock(sql, [co, inv, poster], sql, [co, inv, poster])).toBe(true);
  });

  it("a second concurrent bank-change approval BLOCKS on the FOR UPDATE lock", async () => {
    // Worker path (no JWT) so the lock — not the capability check — is what serialises.
    const sql = `select public.decide_supplier_bank_change($1,$2,'approved',$3,null)`;
    expect(await blocksOnLock(sql, [co, change, checker], sql, [co, change, checker])).toBe(true);
  });
});
