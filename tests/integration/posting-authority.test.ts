/**
 * WP2 posting authority — live Postgres, ZERO-PERSISTENCE. Proves the capability gate that
 * a user-triggered RPC enforces via auth.uid() (the authenticated-RPC path), independent of
 * RLS_WRITES: a finance_reviewer may CREATE a draft but may NOT post; an accountant may
 * post; a SUSPENDED accountant may not. p_by spoofing + actor identity are covered in
 * accounting-rpc-hardening.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, customer: string, supplier: string, uReviewer: string, uAcct: string, uSusp: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
async function asUser(u: string) {
  await client.query("set local role authenticated");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: u, role: "authenticated" })]);
}
async function asSuper() { await client.query("reset role"); await client.query(`select set_config('request.jwt.claims','',true)`); }
async function canDo(u: string, sql: string, params: unknown[] = []): Promise<boolean> {
  await asUser(u); let ok = true; try { await q(sql, params); } catch { ok = false; } await asSuper(); return ok;
}
async function callAs(u: string, sql: string): Promise<{ ok: boolean; error?: string }> {
  await asUser(u); let r: { ok: boolean; error?: string } = { ok: true };
  try { await q(sql); } catch (e) { r = { ok: false, error: (e as Error).message }; }
  await asSuper(); return r;
}
async function mkInvoice(): Promise<string> {
  return (await q(`insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, total_amount, amount_settled, status) values ($1,$2,$3,'LKR','2026-07-01',100,0,'draft') returning id`, [co, customer, "INV-" + Math.random().toString(36).slice(2, 9)])).rows[0].id;
}
async function mkBill(): Promise<string> {
  return (await q(`insert into supplier_bills (company_id, supplier_id, bill_number, currency, issue_date, total_amount, amount_settled, status) values ($1,$2,$3,'LKR','2026-07-01',100,0,'draft') returning id`, [co, supplier, "BILL-" + Math.random().toString(36).slice(2, 9)])).rows[0].id;
}

describe.skipIf(!enabled)("WP2 posting authority — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    co = (await client.query(`insert into companies (name, base_currency) values ('wp2','LKR') returning id`)).rows[0].id;
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1100','AR','asset'),($1,'4000','Sales','income'),($1,'2000','AP','liability'),($1,'5000','Expense','expense')`, [co]);
    customer = (await client.query(`insert into customers (company_id, name, status) values ($1,'C','active') returning id`, [co])).rows[0].id;
    supplier = (await client.query(`insert into suppliers (company_id, name, status) values ($1,'S','active') returning id`, [co])).rows[0].id;
    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    uReviewer = await mkUser("wp2_rev"); uAcct = await mkUser("wp2_acct"); uSusp = await mkUser("wp2_susp");
    const mkMem = async (u: string, role: string, status = "active") => {
      const id = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,$3) returning id`, [co, u, status])).rows[0].id;
      await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [id, co, role]);
    };
    await mkMem(uReviewer, "finance_reviewer");
    await mkMem(uAcct, "accountant");
    await mkMem(uSusp, "accountant", "suspended");
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("finance_reviewer can create a draft invoice but cannot post it", async () => {
    const inv = await mkInvoice();
    // reviewer holds finance.invoice.create → can create a draft line
    expect(await canDo(uReviewer, `insert into customer_invoice_lines (invoice_id, company_id, description, quantity, unit_price, amount) values ($1,$2,'x',1,100,100)`, [inv, co])).toBe(true);
    // …but not finance.invoice.post → cannot post
    const r = await callAs(uReviewer, `select public.post_customer_invoice('${co}','${inv}','1100','4000','${uReviewer}','2026-07-15','p') as v`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/finance\.invoice\.post/i);
  });

  it("an accountant can post an invoice; a suspended accountant cannot", async () => {
    const inv1 = await mkInvoice();
    const acct = await callAs(uAcct, `select public.post_customer_invoice('${co}','${inv1}','1100','4000','${uAcct}','2026-07-15','pa') as v`);
    expect(acct.ok).toBe(true);
    const inv2 = await mkInvoice();
    const susp = await callAs(uSusp, `select public.post_customer_invoice('${co}','${inv2}','1100','4000','${uSusp}','2026-07-15','ps') as v`);
    expect(susp.ok).toBe(false);
    expect(susp.error).toMatch(/finance\.invoice\.post/i); // suspended membership → capability not granted
  });

  it("finance_reviewer cannot post a supplier bill; an accountant can", async () => {
    const b1 = await mkBill();
    const rev = await callAs(uReviewer, `select public.post_supplier_bill('${co}','${b1}','5000','2000','${uReviewer}','2026-07-15','b') as v`);
    expect(rev.ok).toBe(false);
    expect(rev.error).toMatch(/finance\.bill\.post/i);
    const b2 = await mkBill();
    const acct = await callAs(uAcct, `select public.post_supplier_bill('${co}','${b2}','5000','2000','${uAcct}','2026-07-15','ba') as v`);
    expect(acct.ok).toBe(true);
  });
});
