/**
 * WP3/WP4 (migration 0044) — canonical idempotency fingerprints, legacy upgrade path, and
 * document lifecycle. Live Postgres, ZERO-PERSISTENCE.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, customer: string, uAcct: string, uEmp: string, empX: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
async function call(sql: string): Promise<{ ok: boolean; value?: string; error?: string }> {
  try { const r = await q(sql); return { ok: true, value: r.rows[0]?.v }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
const LINES_A = `'[{"account_code":"1000","debit":"100","credit":"0"},{"account_code":"4000","debit":"0","credit":"100"}]'::jsonb`;
const LINES_B = `'[{"account_code":"1100","debit":"100","credit":"0"},{"account_code":"4000","debit":"0","credit":"100"}]'::jsonb`;
const pmj = (date: string, ccy: string, memo: string, lines: string, key: string) =>
  `select public.post_manual_journal('${co}','${date}','${ccy}','${memo}','${uAcct}',${lines},'${key}') as v`;
async function mkClaim(amount: number): Promise<string> {
  return (await q(`insert into expense_claims (company_id, employee_id, currency, amount, purpose, status) values ($1,$2,'LKR',${amount},'x','approved') returning id`, [co, empX])).rows[0].id;
}
async function mkInvoice(status: string): Promise<string> {
  return (await q(`insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, total_amount, amount_settled, status) values ($1,$2,$3,'LKR','2026-07-01',100,0,$4) returning id`, [co, customer, "INV-" + Math.random().toString(36).slice(2, 9), status])).rows[0].id;
}

describe.skipIf(!enabled)("idempotency + lifecycle (0044) — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    // Posting RPCs run on the service path; present a service_role JWT (WP17/0049).
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    co = (await client.query(`insert into companies (name, base_currency) values ('wp_il','LKR') returning id`)).rows[0].id;
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'1100','AR','asset'),($1,'2000','AP','liability'),($1,'4000','Sales','income'),($1,'5000','Expense','expense')`, [co]);
    customer = (await client.query(`insert into customers (company_id, name, status) values ($1,'C','active') returning id`, [co])).rows[0].id;
    uAcct = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'il_acct',true) returning id`)).rows[0].id;
    uEmp = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'il_emp',true) returning id`)).rows[0].id;
    empX = (await client.query(`insert into employees (company_id, user_id, name, status) values ($1,$2,'EmpX','active') returning id`, [co, uEmp])).rows[0].id;
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("legacy null-fingerprint row: identical retry upgrades safely; different lines conflict", async () => {
    // Simulate a pre-0044 journal (idem_fingerprint NULL) with a known key + lines.
    const jid = (await q(
      `insert into journal_entries (company_id, posting_date, currency, memo, status, correlation_id, idempotency_key, total_debit, total_credit, posted_at, posted_by)
       values ($1,'2026-07-15','LKR','legacy','posted','corr_leg','LEG1',100,100, now(), $2) returning id`, [co, uAcct])).rows[0].id;
    await q(`insert into journal_lines (journal_id, company_id, account_code, debit, credit, description, line_no) values ($1,$2,'1000',100,0,null,1),($1,$2,'4000',0,100,null,2)`, [jid, co]);
    // Identical retry (same date/currency/memo/lines) → returns the SAME journal + upgrades.
    const same = await call(pmj("2026-07-15", "LKR", "legacy", LINES_A, "LEG1"));
    expect(same.ok).toBe(true);
    expect(same.value).toBe(jid);
    const fp = await q(`select idem_fingerprint from journal_entries where id=$1`, [jid]);
    expect(fp.rows[0].idem_fingerprint).not.toBeNull(); // upgraded
    // Different lines on the same legacy key → conflict.
    const diff = await call(pmj("2026-07-15", "LKR", "legacy", LINES_B, "LEG1"));
    expect(diff.ok).toBe(false);
    expect(diff.error).toMatch(/conflict/i);
  });

  it("canonical fingerprint binds date, currency and lines", async () => {
    const base = await call(pmj("2026-07-15", "LKR", "m", LINES_A, "FP1"));
    expect(base.ok).toBe(true);
    expect((await call(pmj("2026-07-15", "LKR", "m", LINES_A, "FP1"))).value).toBe(base.value); // identical → same
    expect((await call(pmj("2026-07-16", "LKR", "m", LINES_A, "FP1"))).error).toMatch(/conflict/i); // date
    expect((await call(pmj("2026-07-15", "USD", "m", LINES_A, "FP1"))).error).toMatch(/conflict/i); // currency
    expect((await call(pmj("2026-07-15", "LKR", "m", LINES_B, "FP1"))).error).toMatch(/conflict/i); // lines
  });

  it("settlement key binds the source document (different invoice → conflict)", async () => {
    const a = await mkInvoice("issued"), b = await mkInvoice("issued");
    // set them issued with outstanding so settle works
    await q(`update customer_invoices set total_amount=100, amount_settled=0, status='issued' where id in ($1,$2)`, [a, b]);
    const s1 = await call(`select public.settle_customer_invoice('${co}','${a}',50,'1000','1100','${uAcct}','2026-07-15','SKEY') as v`);
    const s2 = await call(`select public.settle_customer_invoice('${co}','${b}',50,'1000','1100','${uAcct}','2026-07-15','SKEY') as v`);
    expect(s1.ok).toBe(true);
    expect(s2.ok).toBe(false);
    expect(s2.error).toMatch(/conflict/i);
  });

  it("one reimbursement key cannot attach to a second claim", async () => {
    const c1 = await mkClaim(50), c2 = await mkClaim(50);
    const r1 = await call(`select public.reimburse_expense_claim('${co}','${c1}','5000','1000','${uAcct}','2026-07-15','RK') as v`);
    const r2 = await call(`select public.reimburse_expense_claim('${co}','${c2}','5000','1000','${uAcct}','2026-07-15','RK') as v`);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/conflict/i);
    const s = await q(`select status from expense_claims where id=$1`, [c2]);
    expect(s.rows[0].status).toBe("approved"); // second claim unchanged
  });

  it("invoice lifecycle: only a draft posts; cancelled is rejected", async () => {
    const cancelled = await mkInvoice("cancelled");
    const bad = await call(`select public.post_customer_invoice('${co}','${cancelled}','1100','4000','${uAcct}','2026-07-15','LC1') as v`);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/cannot be posted from status/i);
    const draft = await mkInvoice("draft");
    const ok = await call(`select public.post_customer_invoice('${co}','${draft}','1100','4000','${uAcct}','2026-07-15','LC2') as v`);
    expect(ok.ok).toBe(true);
    const row = await q(`select status, journal_id from customer_invoices where id=$1`, [draft]);
    expect(row.rows[0].status).toBe("issued");
  });
});
