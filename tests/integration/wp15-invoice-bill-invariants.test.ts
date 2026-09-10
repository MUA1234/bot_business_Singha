/**
 * WP15 — invoice & bill document invariants. Live Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0052 closes two gaps in post_customer_invoice / post_supplier_bill (0044):
 *   1. the header-vs-line total check only ran `when v_line_total > 0`, so a positive HEADER with
 *      NO detail lines (line total 0) posted a journal with no source lines. Now a post requires
 *      >= 1 line, a positive header, header = line total (unconditional), and no negative line.
 *   2. an existing journal_id was returned as "idempotent success" WITHOUT confirming it is THIS
 *      document's journal. Now the idempotent return happens only when the linked journal exists in
 *      this company, its idempotency_key equals this document's posting key, and the document
 *      lifecycle is consistent; otherwise it is refused (a mismatched/missing link is never returned).
 *
 * A rejected post must change nothing (no journal, document stays draft). The service-role (worker)
 * path is used so the capability gate is bypassed and the DOCUMENT invariants are what is exercised
 * (authority is covered by posting-authority.test.ts).
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { authClaims, seedCapableActor, TEST_ACTOR } from "./helpers/capable-actor";

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
async function mkInvoice(total: number, status = "draft"): Promise<string> {
  return (await q(`insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, total_amount, amount_settled, status) values ($1,$2,$3,'LKR','2026-07-01',${total},0,$4) returning id`, [co, customer, "INV-" + Math.random().toString(36).slice(2, 9), status])).rows[0].id;
}
async function mkBill(total: number, status = "draft"): Promise<string> {
  return (await q(`insert into supplier_bills (company_id, supplier_id, bill_number, currency, issue_date, total_amount, amount_settled, status) values ($1,$2,$3,'LKR','2026-07-01',${total},0,$4) returning id`, [co, supplier, "BILL-" + Math.random().toString(36).slice(2, 9), status])).rows[0].id;
}
async function addInvLine(inv: string, amount: number) {
  await q(`insert into customer_invoice_lines (invoice_id, company_id, description, unit_price, amount) values ($1,$2,'x',${amount},${amount})`, [inv, co]);
}
async function addBillLine(bill: string, amount: number) {
  await q(`insert into supplier_bill_lines (bill_id, company_id, description, unit_price, amount) values ($1,$2,'x',${amount},${amount})`, [bill, co]);
}
const postInv = (inv: string, key: string) =>
  call(`select public.post_customer_invoice($1,$2,'1100','4000',null::uuid,'2026-07-15',$3) as v`, [co, inv, key]);
const postBill = (bill: string, key: string) =>
  call(`select public.post_supplier_bill($1,$2,'5000','2000',null::uuid,'2026-07-15',$3) as v`, [co, bill, key]);
const invState = async (inv: string) => (await q(`select journal_id, status from customer_invoices where id=$1`, [inv])).rows[0];
const billState = async (bill: string) => (await q(`select journal_id, status from supplier_bills where id=$1`, [bill])).rows[0];
const journalCount = async (key: string) => (await q(`select count(*)::int c from journal_entries where company_id=$1 and idempotency_key=$2`, [co, key])).rows[0].c;

describe.skipIf(!enabled)("WP15 invoice/bill document invariants — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    // Posting RPCs run on the service path; present a service_role JWT (WP17/0049) so the DOCUMENT
    // invariants — not the capability gate — are under test.
    await client.query(`select set_config('request.jwt.claims', '${authClaims()}', true)`);
    co = (await client.query(`insert into companies (name, base_currency) values ('wp15','LKR') returning id`)).rows[0].id;
    await seedCapableActor(client, co);
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1100','AR','asset'),($1,'2000','AP','liability'),($1,'4000','Sales','income'),($1,'5000','Expense','expense')`, [co]);
    customer = (await client.query(`insert into customers (company_id, name, status) values ($1,'C','active') returning id`, [co])).rows[0].id;
    supplier = (await client.query(`insert into suppliers (company_id, name, status) values ($1,'S','active') returning id`, [co])).rows[0].id;
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  // ---- gap 1: a document must have real, balanced source lines ----

  it("a header-only invoice (no lines) is refused; no journal, invoice stays draft", async () => {
    const inv = await mkInvoice(100);
    const r = await postInv(inv, "wp15-noline-inv");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no source-document lines/i);
    const row = await invState(inv);
    expect(row.journal_id).toBeNull();
    expect(row.status).toBe("draft");
    expect(await journalCount("wp15-noline-inv")).toBe(0);
  });

  it("a header-only bill (no lines) is refused; no journal, bill stays draft", async () => {
    const bill = await mkBill(100);
    const r = await postBill(bill, "wp15-noline-bill");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no source-document lines/i);
    const row = await billState(bill);
    expect(row.journal_id).toBeNull();
    expect(row.status).toBe("draft");
    expect(await journalCount("wp15-noline-bill")).toBe(0);
  });

  it("a non-positive header total is refused even with a (zero) line", async () => {
    const inv = await mkInvoice(0);
    await addInvLine(inv, 0);
    const r = await postInv(inv, "wp15-zero");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/header total must be positive/i);
    expect((await invState(inv)).status).toBe("draft");
  });

  it("a negative line amount is refused", async () => {
    const inv = await mkInvoice(100);
    await addInvLine(inv, -100);
    const r = await postInv(inv, "wp15-neg");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/negative line amount/i);
    expect((await invState(inv)).journal_id).toBeNull();
  });

  it("a header total that disagrees with the line total is refused; nothing changes", async () => {
    const inv = await mkInvoice(100);
    await addInvLine(inv, 60); // header 100 != lines 60
    const r = await postInv(inv, "wp15-mismatch");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/<> line total/i);
    const row = await invState(inv);
    expect(row.journal_id).toBeNull();
    expect(row.status).toBe("draft");
    expect(await journalCount("wp15-mismatch")).toBe(0);
  });

  it("a bill whose header total disagrees with its lines is refused", async () => {
    const bill = await mkBill(100);
    await addBillLine(bill, 40); // header 100 != lines 40
    const r = await postBill(bill, "wp15-bill-mismatch");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/<> line total/i);
    expect((await billState(bill)).journal_id).toBeNull();
  });

  it("a valid invoice with matching lines posts once and is idempotent", async () => {
    const inv = await mkInvoice(150);
    await addInvLine(inv, 100);
    await addInvLine(inv, 50); // lines sum 150 == header
    const a = await postInv(inv, "wp15-ok");
    expect(a.ok).toBe(true);
    const b = await postInv(inv, "wp15-ok"); // idempotent
    expect(b.value).toBe(a.value);
    const row = await invState(inv);
    expect(row.journal_id).toBe(a.value);
    expect(row.status).toBe("issued");
    expect(await journalCount("wp15-ok")).toBe(1);
  });

  it("a valid bill with a matching line posts and moves to approved", async () => {
    const bill = await mkBill(100);
    await addBillLine(bill, 100);
    const r = await postBill(bill, "wp15-bill-ok");
    expect(r.ok).toBe(true);
    const row = await billState(bill);
    expect(row.journal_id).toBe(r.value);
    expect(row.status).toBe("approved");
  });

  // ---- gap 2: the idempotent return must verify the link is THIS document's journal ----

  it("an existing journal link that belongs to another document is refused (binding mismatch)", async () => {
    // A real journal produced by inv1 under its own key.
    const inv1 = await mkInvoice(100); await addInvLine(inv1, 100);
    const p1 = await postInv(inv1, "wp15-bind-1");
    expect(p1.ok).toBe(true);
    // inv2 is cross-linked to inv1's journal and marked issued — a corrupt state the old code would
    // have returned blindly as success.
    const inv2 = await mkInvoice(100); await addInvLine(inv2, 100);
    await q(`update customer_invoices set journal_id=$1, status='issued' where id=$2`, [p1.value, inv2]);
    const r = await postInv(inv2, "wp15-bind-2");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/binding mismatch/i);
  });

  it("an invoice pointing at another company's journal is refused, not returned as success", async () => {
    // A real journal that exists — but in a DIFFERENT company. The idempotent lookup is scoped
    // `where id=journal and company_id=p_company`, so a cross-company link resolves to no row and
    // the old code's blind `return v_existing` (leaking/attaching a foreign journal) is refused.
    const co2 = (await q(`insert into companies (name, base_currency) values ('wp15-other','LKR') returning id`)).rows[0].id;
    const other = (await q(`insert into journal_entries (company_id, posting_date, currency, memo, status, correlation_id, idempotency_key, total_debit, total_credit, posted_at) values ($1,'2026-07-15','LKR','x','posted','corr_x','OTHERKEY',100,100, now()) returning id`, [co2])).rows[0].id;
    const inv = await mkInvoice(100); await addInvLine(inv, 100);
    await q(`update customer_invoices set journal_id=$1, status='issued' where id=$2`, [other, inv]);
    const r = await postInv(inv, "wp15-cross");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing or cross-company/i);
  });

  it("a journal set with the right key but an inconsistent lifecycle is refused", async () => {
    // Real journal under key wp15-life…
    const seed = await mkInvoice(100); await addInvLine(seed, 100);
    const jp = await postInv(seed, "wp15-life");
    expect(jp.ok).toBe(true);
    // …then a different invoice linked to it but left in 'draft' (journal set, status wrong).
    const inv = await mkInvoice(100); await addInvLine(inv, 100);
    await q(`update customer_invoices set journal_id=$1, status='draft' where id=$2`, [jp.value, inv]);
    const r = await postInv(inv, "wp15-life");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lifecycle inconsistent/i);
  });
});
