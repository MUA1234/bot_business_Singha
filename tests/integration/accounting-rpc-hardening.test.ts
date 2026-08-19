/**
 * WP B accounting-RPC hardening — live Postgres, ZERO-PERSISTENCE (BEGIN … ROLLBACK).
 * Proves migration 0039's guarantees for settlement/journal/reversal RPCs (brief §6):
 *   - same idempotency key, same request → one journal + one payment, applied once;
 *   - same key, changed amount → rejected as a CONFLICT;
 *   - a failed RPC does NOT consume the key → a retry completes;
 *   - partial settlements cannot exceed the outstanding balance;
 *   - a caller without the finance capability is rejected AT THE RPC (authenticated);
 *   - the actor cannot be spoofed (posted_by is auth.uid(), not p_by);
 *   - anonymous callers are rejected;
 *   - a closed period is rejected;
 *   - a failed settle leaves NO journal/payment and the invoice unchanged (atomic).
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { authClaims, seedCapableActor, TEST_ACTOR } from "./helpers/capable-actor";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let company: string, customer: string, supplier: string, uAcct: string, uStaff: string;

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
async function asUser(userId: string) {
  await client.query("set local role authenticated");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: "authenticated" })]);
}
async function asAnon() {
  await client.query("set local role authenticated"); // has EXECUTE; body then rejects the 'anon' JWT role
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "anon" })]);
}
async function asWorker() {
  await client.query("reset role");
  await client.query(`select set_config('request.jwt.claims', '${authClaims()}', true)`);
}
async function call(sql: string, params: unknown[] = []): Promise<{ ok: boolean; value?: string; error?: string }> {
  try {
    const r = await q(sql, params);
    return { ok: true, value: r.rows[0]?.v };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
async function mkInvoice(total: number): Promise<string> {
  return (
    await q(
      `insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, total_amount, amount_settled, status)
       values ($1,$2,$3,'LKR','2026-07-01',${total},0,'issued') returning id`,
      [company, customer, "INV-" + Math.random().toString(36).slice(2, 10)],
    )
  ).rows[0].id;
}
async function mkBill(total: number): Promise<string> {
  return (
    await q(
      `insert into supplier_bills (company_id, supplier_id, bill_number, currency, issue_date, total_amount, amount_settled, status)
       values ($1,$2,$3,'LKR','2026-07-01',${total},0,'approved') returning id`,
      [company, supplier, "BILL-" + Math.random().toString(36).slice(2, 10)],
    )
  ).rows[0].id;
}
const settleCI = (inv: string, amt: number, key: string | null, by?: string) =>
  `select public.settle_customer_invoice('${company}','${inv}',${amt},'1000','1100','${by ?? uAcct}','2026-07-15'${key === null ? "" : `,'${key}'`}) as v`;

describe.skipIf(!enabled)("WP B accounting RPC hardening — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    company = (await client.query(`insert into companies (name, base_currency) values ('wp_b','LKR') returning id`)).rows[0].id;
    await seedCapableActor(client, company, TEST_ACTOR, "accountant");
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'1100','AR','asset'),($1,'2000','AP','liability')`, [company]);
    customer = (await client.query(`insert into customers (company_id, name, status) values ($1,'CusB','active') returning id`, [company])).rows[0].id;
    supplier = (await client.query(`insert into suppliers (company_id, name, status) values ($1,'SupB','active') returning id`, [company])).rows[0].id;
    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    uAcct = TEST_ACTOR;   // FOUND-006/0086: p_by must be the authenticated subject
    uStaff = await mkUser("wp_b_staff");
    const mkMem = async (u: string, role: string) => {
      const id = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [company, u])).rows[0].id;
      await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [id, company, role]);
    };
        await mkMem(uStaff, "staff_submitter");
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("same idempotency key + same request → one journal, one payment, applied once", async () => {
    const inv = await mkInvoice(500);
    await asWorker();
    const r1 = await call(settleCI(inv, 100, "K1"));
    const r2 = await call(settleCI(inv, 100, "K1"));
    await asWorker();
    expect(r1.ok && r2.ok).toBe(true);
    expect(r1.value).toBe(r2.value); // same journal id
    const j = await q(`select count(*)::int n from journal_entries where company_id=$1 and idempotency_key='K1'`, [company]);
    const pmt = await q(`select count(*)::int n from payments where company_id=$1 and idempotency_key='K1'`, [company]);
    const settled = await q(`select amount_settled from customer_invoices where id=$1`, [inv]);
    expect(j.rows[0].n).toBe(1);
    expect(pmt.rows[0].n).toBe(1);
    expect(Number(settled.rows[0].amount_settled)).toBe(100); // NOT 200
  });

  it("same key + changed amount → rejected as conflict", async () => {
    const inv = await mkInvoice(500);
    await asWorker();
    const r1 = await call(settleCI(inv, 100, "K2"));
    const r2 = await call(settleCI(inv, 200, "K2"));
    await asWorker();
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/conflict|different amount/i);
  });

  it("a failed RPC does not consume the key → retry completes", async () => {
    const inv = await mkInvoice(500);
    await asWorker();
    // First attempt fails on a bad AR account code → whole op rolls back, key unconsumed.
    const bad = await call(`select public.settle_customer_invoice('${company}','${inv}',100,'1000','9999','${uAcct}','2026-07-15','K3') as v`);
    const good = await call(settleCI(inv, 100, "K3"));
    await asWorker();
    expect(bad.ok).toBe(false);
    expect(good.ok).toBe(true);
    const settled = await q(`select amount_settled from customer_invoices where id=$1`, [inv]);
    expect(Number(settled.rows[0].amount_settled)).toBe(100);
  });

  it("partial settlements cannot exceed the outstanding balance", async () => {
    const inv = await mkInvoice(500);
    await asWorker();
    const a = await call(settleCI(inv, 300, "P1"));
    const b = await call(settleCI(inv, 300, "P2")); // 300 + 300 > 500
    await asWorker();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/exceeds outstanding/i);
  });

  it("authenticated caller without the finance capability is rejected; accountant succeeds", async () => {
    const inv = await mkInvoice(500);
    await asUser(uStaff);
    const staff = await call(settleCI(inv, 100, "C1", uStaff));
    await asUser(uAcct);
    const acct = await call(settleCI(inv, 100, "C2", uAcct));
    await asWorker();
    expect(staff.ok).toBe(false);
    expect(staff.error).toMatch(/capability finance\.receipt\.record/i);
    expect(acct.ok).toBe(true);
  });

  it("the actor cannot be spoofed — a mismatched p_by is rejected; a matching one posts as auth.uid()", async () => {
    const inv = await mkInvoice(500);
    await asUser(uAcct);
    // p_by = uStaff but the authenticated actor is uAcct → rejected (WP2.3).
    const spoof = await call(`select public.settle_customer_invoice('${company}','${inv}',100,'1000','1100','${uStaff}','2026-07-15','SPOOF') as v`);
    // p_by = uAcct (matches) → succeeds, actor derived from auth.uid().
    const ok = await call(`select public.settle_customer_invoice('${company}','${inv}',100,'1000','1100','${uAcct}','2026-07-15','SPOOFOK') as v`);
    await asWorker();
    expect(spoof.ok).toBe(false);
    expect(spoof.error).toMatch(/actor mismatch/i);
    expect(ok.ok).toBe(true);
    const j = await q(`select posted_by from journal_entries where id=$1`, [ok.value]);
    expect(j.rows[0].posted_by).toBe(uAcct);
  });

  it("anonymous callers are rejected", async () => {
    const inv = await mkInvoice(500);
    await asAnon();
    const r = await call(settleCI(inv, 100, "ANON"));
    await asWorker();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not permitted|access denied/i); // WP17/0049: anon role rejected fail-closed
  });

  it("a closed accounting period is rejected", async () => {
    const inv = await mkInvoice(500);
    const fy = (await q(`insert into fiscal_years (company_id, name, start_date, end_date) values ($1,'FYB','2026-01-01','2026-12-31') returning id`, [company])).rows[0].id;
    await q(`insert into accounting_periods (company_id, fiscal_year_id, name, start_date, end_date, status) values ($1,$2,'AugB','2026-08-01','2026-08-31','closed')`, [company, fy]);
    await asWorker();
    const r = await call(`select public.settle_customer_invoice('${company}','${inv}',100,'1000','1100','${uAcct}','2026-08-15','CLOSED') as v`);
    await asWorker();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/closed|locked/i);
  });

  it("a failed settle is atomic — no journal, no payment, invoice unchanged", async () => {
    const inv = await mkInvoice(500);
    await asWorker();
    const bad = await call(`select public.settle_customer_invoice('${company}','${inv}',100,'1000','9999','${uAcct}','2026-07-15','ATOM') as v`);
    await asWorker();
    expect(bad.ok).toBe(false);
    const j = await q(`select count(*)::int n from journal_entries where company_id=$1 and idempotency_key='ATOM'`, [company]);
    const pmt = await q(`select count(*)::int n from payments where company_id=$1 and idempotency_key='ATOM'`, [company]);
    const settled = await q(`select amount_settled from customer_invoices where id=$1`, [inv]);
    expect(j.rows[0].n).toBe(0);
    expect(pmt.rows[0].n).toBe(0);
    expect(Number(settled.rows[0].amount_settled)).toBe(0);
  });

  it("reversal is idempotent — a repeated reverse returns the same reversal journal", async () => {
    await asWorker();
    const posted = await call(`select public.post_manual_journal('${company}','2026-07-15','LKR','rev-test','${uAcct}','[{"account_code":"1000","debit":"50","credit":"0"},{"account_code":"1100","debit":"0","credit":"50"}]'::jsonb,'JPOST1') as v`);
    const jid = posted.value;
    const rev1 = await call(`select public.reverse_journal('${company}','${jid}','${uAcct}','2026-07-16','REV1') as v`);
    const rev2 = await call(`select public.reverse_journal('${company}','${jid}','${uAcct}','2026-07-16','REV1') as v`);
    await asWorker();
    expect(posted.ok && rev1.ok && rev2.ok).toBe(true);
    expect(rev1.value).toBe(rev2.value);
    const n = await q(`select count(*)::int n from journal_entries where company_id=$1 and reversal_of_journal_id=$2`, [company, jid]);
    expect(n.rows[0].n).toBe(1); // exactly one reversal journal
  });

  it("supplier payment enforces finance.payment.record and posts one payment", async () => {
    const bill = await mkBill(400);
    await asUser(uStaff);
    const staff = await call(`select public.settle_supplier_bill('${company}','${bill}',100,'2000','1000','${uStaff}','2026-07-15','SB1') as v`);
    await asUser(uAcct);
    const acct = await call(`select public.settle_supplier_bill('${company}','${bill}',100,'2000','1000','${uAcct}','2026-07-15','SB2') as v`);
    await asWorker();
    expect(staff.ok).toBe(false);
    expect(acct.ok).toBe(true);
    const pmt = await q(`select count(*)::int n from payments where company_id=$1 and idempotency_key='SB2'`, [company]);
    expect(pmt.rows[0].n).toBe(1);
  });
});
