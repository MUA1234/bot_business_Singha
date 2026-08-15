/**
 * WP B/A follow-up (migrations 0042/0043) — live Postgres, ZERO-PERSISTENCE. Proves the
 * review findings are fixed:
 *   - full-PAYLOAD idempotency: same key + different lines (even same total) → conflict;
 *   - invoice/bill posting is ONE transaction (journal + status + audit) and idempotent,
 *     and a failure leaves the source document untouched (atomic);
 *   - reimbursement is one transaction with lifecycle + separation-of-duties enforced;
 *   - self-service: a member can file an expense claim only for THEMSELVES.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, customer: string, uAcct: string, uEmp: string, uOther: string, empSelf: string, empOther: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
async function asUser(u: string) {
  await client.query("set local role authenticated");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: u, role: "authenticated" })]);
}
async function asWorker() { await client.query("reset role"); await client.query(`select set_config('request.jwt.claims','{"role":"service_role"}',true)`); }
async function call(sql: string, params: unknown[] = []): Promise<{ ok: boolean; value?: string; error?: string }> {
  try { const r = await q(sql, params); return { ok: true, value: r.rows[0]?.v }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
async function canDo(u: string, sql: string, params: unknown[] = []): Promise<boolean> {
  await asUser(u); let ok = true; try { await q(sql, params); } catch { ok = false; } await asWorker(); return ok;
}
async function mkInvoice(total: number): Promise<string> {
  return (await q(`insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, total_amount, amount_settled, status) values ($1,$2,$3,'LKR','2026-07-01',${total},0,'draft') returning id`, [co, customer, "INV-" + Math.random().toString(36).slice(2, 9)])).rows[0].id;
}
async function mkClaim(amount: number, status: string, emp: string): Promise<string> {
  return (await q(`insert into expense_claims (company_id, employee_id, currency, amount, purpose, status) values ($1,$2,'LKR',${amount},'x',$3) returning id`, [co, emp, status])).rows[0].id;
}

describe.skipIf(!enabled)("transactional finance (0042/0043) — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    co = (await client.query(`insert into companies (name, base_currency) values ('wp_tf','LKR') returning id`)).rows[0].id;
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'1100','AR','asset'),($1,'2000','AP','liability'),($1,'4000','Sales','income'),($1,'5000','Expense','expense')`, [co]);
    customer = (await client.query(`insert into customers (company_id, name, status) values ($1,'C','active') returning id`, [co])).rows[0].id;
    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    uAcct = await mkUser("tf_acct"); uEmp = await mkUser("tf_emp"); uOther = await mkUser("tf_other");
    const mkMem = async (u: string, role: string) => {
      const id = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, u])).rows[0].id;
      await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [id, co, role]);
    };
    await mkMem(uAcct, "accountant"); await mkMem(uEmp, "staff_submitter"); await mkMem(uOther, "staff_submitter");
    empSelf = (await client.query(`insert into employees (company_id, user_id, name, status) values ($1,$2,'Emp Self','active') returning id`, [co, uEmp])).rows[0].id;
    empOther = (await client.query(`insert into employees (company_id, user_id, name, status) values ($1,$2,'Emp Other','active') returning id`, [co, uOther])).rows[0].id;
  });

  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("full-payload idempotency: same key + different lines is a conflict", async () => {
    await asWorker();
    const linesA = `'[{"account_code":"1000","debit":"100","credit":"0"},{"account_code":"4000","debit":"0","credit":"100"}]'::jsonb`;
    const linesB = `'[{"account_code":"1100","debit":"100","credit":"0"},{"account_code":"4000","debit":"0","credit":"100"}]'::jsonb`;
    const r1 = await call(`select public.post_manual_journal('${co}','2026-07-15','LKR','m','${uAcct}',${linesA},'PKEY') as v`);
    const r2 = await call(`select public.post_manual_journal('${co}','2026-07-15','LKR','m','${uAcct}',${linesA},'PKEY') as v`); // same lines
    const r3 = await call(`select public.post_manual_journal('${co}','2026-07-15','LKR','m','${uAcct}',${linesB},'PKEY') as v`); // different lines, same total
    await asWorker();
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true); expect(r2.value).toBe(r1.value);
    expect(r3.ok).toBe(false); expect(r3.error).toMatch(/conflict|different payload/i);
  });

  it("post_customer_invoice is one transaction, capability-gated and idempotent", async () => {
    const inv = await mkInvoice(200);
    // staff cannot post
    await asUser(uEmp);
    const staff = await call(`select public.post_customer_invoice('${co}','${inv}','1100','4000','${uEmp}','2026-07-15','ip') as v`);
    // accountant can; journal + status set together
    await asUser(uAcct);
    const a = await call(`select public.post_customer_invoice('${co}','${inv}','1100','4000','${uAcct}','2026-07-15','ip') as v`);
    const b = await call(`select public.post_customer_invoice('${co}','${inv}','1100','4000','${uAcct}','2026-07-15','ip') as v`); // idempotent
    await asWorker();
    expect(staff.ok).toBe(false);
    expect(staff.error).toMatch(/capability finance\.invoice\.post/i);
    expect(a.ok).toBe(true);
    expect(b.value).toBe(a.value);
    const row = await q(`select journal_id, status from customer_invoices where id=$1`, [inv]);
    expect(row.rows[0].journal_id).toBe(a.value);
    expect(row.rows[0].status).toBe("issued");
    const n = await q(`select count(*)::int c from journal_entries where company_id=$1 and idempotency_key='ip'`, [co]);
    expect(n.rows[0].c).toBe(1);
  });

  it("post_customer_invoice is atomic — a bad account leaves the invoice untouched", async () => {
    const inv = await mkInvoice(200);
    await asWorker();
    const bad = await call(`select public.post_customer_invoice('${co}','${inv}','1100','9999','${uAcct}','2026-07-15','ipbad') as v`);
    await asWorker();
    expect(bad.ok).toBe(false);
    const row = await q(`select journal_id, status from customer_invoices where id=$1`, [inv]);
    expect(row.rows[0].journal_id).toBeNull();
    expect(row.rows[0].status).toBe("draft");
  });

  it("reimburse_expense_claim: lifecycle + separation of duties + idempotent", async () => {
    // not-approved claim is rejected
    const submitted = await mkClaim(50, "submitted", empSelf);
    await asWorker();
    const life = await call(`select public.reimburse_expense_claim('${co}','${submitted}','5000','1000','${uAcct}','2026-07-15','rl') as v`);
    expect(life.ok).toBe(false); expect(life.error).toMatch(/approved/i);

    // SoD: a human cannot reimburse THEIR OWN claim — enforced on the AUTHENTICATED path, the
    // only path with a human maker. After migration 0049 (WP17) the worker/service path records
    // NO human actor (p_by is ignored), so it cannot represent self-dealing; the control lives on
    // the user path. uAcct is an accountant (holds finance.payment.record) AND the claimant here.
    const own = await mkClaim(50, "approved", empSelf);
    const empAcct = (await q(`insert into employees (company_id, user_id, name, status) values ($1,$2,'Emp Acct','active') returning id`, [co, uAcct])).rows[0].id;
    const ownAcct = await mkClaim(50, "approved", empAcct);
    await asUser(uAcct);
    const sod = await call(`select public.reimburse_expense_claim('${co}','${ownAcct}','5000','1000','${uAcct}','2026-07-15','rs') as v`);
    await asWorker();
    expect(sod.ok).toBe(false); expect(sod.error).toMatch(/own expense claim/i);

    // A different actor reimburses; then it is idempotent and the claim is closed.
    const ok1 = await call(`select public.reimburse_expense_claim('${co}','${own}','5000','1000','${uAcct}','2026-07-15','rok') as v`);
    const ok2 = await call(`select public.reimburse_expense_claim('${co}','${own}','5000','1000','${uAcct}','2026-07-15','rok') as v`);
    await asWorker();
    expect(ok1.ok).toBe(true);
    expect(ok2.ok).toBe(true);
    const claim = await q(`select status from expense_claims where id=$1`, [own]);
    expect(claim.rows[0].status).toBe("reimbursed");
    const reimb = await q(`select count(*)::int c from reimbursements where company_id=$1 and expense_claim_id=$2`, [co, own]);
    expect(reimb.rows[0].c).toBe(1);
  });

  it("self-service (0042): a member files an expense claim only for themselves", async () => {
    const insSelf = `insert into expense_claims (company_id, employee_id, currency, amount, purpose) values ($1,$2,'LKR',10,'lunch')`;
    expect(await canDo(uEmp, insSelf, [co, empSelf])).toBe(true); // own employee row
    expect(await canDo(uEmp, insSelf, [co, empOther])).toBe(false); // someone else's
  });
});
