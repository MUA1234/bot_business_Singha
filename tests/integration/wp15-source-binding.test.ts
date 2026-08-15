/**
 * WP15 external-review correction B — the existing-journal path must bind to the SOURCE operation
 * (canonical fingerprint), not merely to a matching idempotency key. Live Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0056: post_customer_invoice / post_supplier_bill reject a retry of the same
 * document + key whose posting date, account codes or source lines differ, and reject a second
 * document that reuses the first document's key AND journal link. An exact retry still returns the
 * original journal. Runs on the service (worker) path so the DOCUMENT binding — not the capability
 * gate — is under test.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, customer: string, supplier: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
async function call(sql: string, params: unknown[] = []): Promise<{ ok: boolean; value?: string; error?: string }> {
  try { const r = await q(sql, params); return { ok: true, value: r.rows[0]?.v }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
const rnd = () => Math.random().toString(36).slice(2, 9);
async function mkInvoice(total: number): Promise<string> {
  const id = (await q(`insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, total_amount, amount_settled, status) values ($1,$2,$3,'LKR','2026-07-01',${total},0,'draft') returning id`, [co, customer, "INV-" + rnd()])).rows[0].id;
  await q(`insert into customer_invoice_lines (invoice_id, company_id, description, unit_price, amount) values ($1,$2,'x',${total},${total})`, [id, co]);
  return id;
}
async function mkBill(total: number): Promise<string> {
  const id = (await q(`insert into supplier_bills (company_id, supplier_id, bill_number, currency, issue_date, total_amount, amount_settled, status) values ($1,$2,$3,'LKR','2026-07-01',${total},0,'draft') returning id`, [co, supplier, "BILL-" + rnd()])).rows[0].id;
  await q(`insert into supplier_bill_lines (bill_id, company_id, description, unit_price, amount) values ($1,$2,'x',${total},${total})`, [id, co]);
  return id;
}
const postInv = (inv: string, key: string, date = "2026-07-15", recv = "1100", inc = "4000") =>
  call(`select public.post_customer_invoice($1,$2,$3,$4,null::uuid,$5,$6) as v`, [co, inv, recv, inc, date, key]);
const postBill = (bill: string, key: string, date = "2026-07-15", exp = "5000", pay = "2000") =>
  call(`select public.post_supplier_bill($1,$2,$3,$4,null::uuid,$5,$6) as v`, [co, bill, exp, pay, date, key]);
const invState = async (inv: string) => (await q(`select journal_id, status from customer_invoices where id=$1`, [inv])).rows[0];

describe.skipIf(!enabled)("WP15 source-binding fingerprint (0056) — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    co = (await client.query(`insert into companies (name, base_currency) values ('wp15sb','LKR') returning id`)).rows[0].id;
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1100','AR','asset'),($1,'1200','AR2','asset'),($1,'2000','AP','liability'),($1,'4000','Sales','income'),($1,'4100','Sales2','income'),($1,'5000','Expense','expense')`, [co]);
    customer = (await client.query(`insert into customers (company_id, name, status) values ($1,'C','active') returning id`, [co])).rows[0].id;
    supplier = (await client.query(`insert into suppliers (company_id, name, status) values ($1,'S','active') returning id`, [co])).rows[0].id;
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("exact retry returns the original journal (idempotent); one journal per key", async () => {
    const inv = await mkInvoice(100);
    const a = await postInv(inv, "sb-ok");
    expect(a.ok).toBe(true);
    const b = await postInv(inv, "sb-ok");
    expect(b.value).toBe(a.value);
    expect((await q(`select count(*)::int c from journal_entries where company_id=$1 and idempotency_key=$2`, [co, "sb-ok"])).rows[0].c).toBe(1);
  });

  it("same invoice + same key + CHANGED DATE is a conflict (not false idempotent success)", async () => {
    const inv = await mkInvoice(100);
    expect((await postInv(inv, "sb-date", "2026-07-15")).ok).toBe(true);
    const r = await postInv(inv, "sb-date", "2026-08-01"); // different date, same key
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/retry conflict|differs from the linked journal/i);
  });

  it("same invoice + same key + CHANGED ACCOUNT CODE is a conflict", async () => {
    const inv = await mkInvoice(100);
    expect((await postInv(inv, "sb-acct", "2026-07-15", "1100", "4000")).ok).toBe(true);
    const r = await postInv(inv, "sb-acct", "2026-07-15", "1200", "4100"); // different accounts, same key
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/retry conflict|differs from the linked journal/i);
  });

  it("a second invoice reusing the first's custom key AND journal link is a conflict", async () => {
    const invA = await mkInvoice(100);
    const pa = await postInv(invA, "sb-shared");
    expect(pa.ok).toBe(true);
    const invB = await mkInvoice(100);
    // Corrupt/adversarial: link B to A's journal and mark issued, then post B with the SAME key.
    await q(`update customer_invoices set journal_id=$1, status='issued' where id=$2`, [pa.value, invB]);
    const r = await postInv(invB, "sb-shared");
    expect(r.ok).toBe(false);
    // The recomputed fingerprint (source_id=B) never matches A's journal → refused.
    expect(r.error).toMatch(/retry conflict|binding mismatch|differs from the linked journal/i);
  });

  it("an altered source line on retry is a conflict with no mutation", async () => {
    const inv = await mkInvoice(100);
    const a = await postInv(inv, "sb-line");
    expect(a.ok).toBe(true);
    // Tamper the source line so header (100) no longer equals the line total (200).
    await q(`update customer_invoice_lines set amount=200 where invoice_id=$1 and company_id=$2`, [inv, co]);
    const r = await postInv(inv, "sb-line");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/<> line total/i);
    const row = await invState(inv);
    expect(row.journal_id).toBe(a.value); // unchanged
    expect(row.status).toBe("issued");
  });

  it("bills: exact retry returns the original; changed date conflicts", async () => {
    const bill = await mkBill(100);
    const a = await postBill(bill, "sb-bill");
    expect(a.ok).toBe(true);
    expect((await postBill(bill, "sb-bill")).value).toBe(a.value); // exact retry
    const r = await postBill(bill, "sb-bill", "2026-08-01"); // changed date
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/retry conflict|differs from the linked journal/i);
  });
});
