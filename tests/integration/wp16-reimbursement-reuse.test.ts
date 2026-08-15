/**
 * WP16 — complete reimbursement/payment reuse validation. Live Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0053: reimburse_expense_claim validates the FULL material payload on any reuse
 * (company scope, source claim, party_type=employee, party id, amount, currency, direction, payment
 * date, journal id, status, method, effective idempotency key + the source-bound journal
 * fingerprint), instead of the prior partial check (party/amount/currency/direction) and the blind
 * "already reimbursed → return whatever journal is linked".
 *
 * The validation tests run on the service (worker) path so the DOCUMENT/CHAIN invariants — not the
 * capability gate — are under test; the separation-of-duties case uses the authenticated path (the
 * only path with a human maker). A second describe uses two real connections for concurrency.
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, empX: string, otherEmp: string, uAcct: string, empAcct: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
async function call(sql: string, params: unknown[] = []): Promise<{ ok: boolean; value?: string; error?: string }> {
  try { const r = await q(sql, params); return { ok: true, value: r.rows[0]?.v }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
async function asUser(u: string) {
  await client.query("set local role authenticated");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: u, role: "authenticated" })]);
}
async function asWorker() {
  await client.query("reset role");
  await client.query(`select set_config('request.jwt.claims','{"role":"service_role"}',true)`);
}
async function mkClaim(amount: number, status = "approved", emp?: string): Promise<string> {
  return (await q(`insert into expense_claims (company_id, employee_id, currency, amount, purpose, status) values ($1,$2,'LKR',${amount},'x',$3) returning id`, [co, emp ?? empX, status])).rows[0].id;
}
const reimburse = (claim: string, key: string, date = "2026-07-15", expense = "5000", cash = "1000") =>
  call(`select public.reimburse_expense_claim($1,$2,$3,$4,null::uuid,$5,$6) as v`, [co, claim, expense, cash, date, key]);
const claimStatus = async (c: string) => (await q(`select status from expense_claims where id=$1`, [c])).rows[0].status;
const countBy = async (table: string, col: string, val: string) =>
  (await q(`select count(*)::int c from ${table} where company_id=$1 and ${col}=$2`, [co, val])).rows[0].c;

describe.skipIf(!enabled)("WP16 reimbursement/payment reuse validation — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    co = (await client.query(`insert into companies (name, base_currency) values ('wp16','LKR') returning id`)).rows[0].id;
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'5000','Expense','expense')`, [co]);
    empX = (await client.query(`insert into employees (company_id, name, status) values ($1,'EmpX','active') returning id`, [co])).rows[0].id;
    otherEmp = (await client.query(`insert into employees (company_id, name, status) values ($1,'Other','active') returning id`, [co])).rows[0].id;
    // A human accountant (holds finance.payment.record) who is ALSO an employee — for the SoD case.
    uAcct = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'w16_acct',true) returning id`)).rows[0].id;
    const mem = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, uAcct])).rows[0].id;
    await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'accountant')`, [mem, co]);
    empAcct = (await client.query(`insert into employees (company_id, user_id, name, status) values ($1,$2,'Acct Emp','active') returning id`, [co, uAcct])).rows[0].id;
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("a valid identical retry returns the original journal; exactly one payment/reimbursement", async () => {
    const c = await mkClaim(50);
    const a = await reimburse(c, "w16-ok");
    expect(a.ok).toBe(true);
    const b = await reimburse(c, "w16-ok");
    expect(b.ok).toBe(true);
    expect(b.value).toBe(a.value);
    expect(await claimStatus(c)).toBe("reimbursed");
    expect(await countBy("reimbursements", "expense_claim_id", c)).toBe(1);
    expect(await countBy("payments", "idempotency_key", "w16-ok")).toBe(1);
  });

  it("the same key cannot reimburse a second claim", async () => {
    const c1 = await mkClaim(50), c2 = await mkClaim(50);
    expect((await reimburse(c1, "w16-dup")).ok).toBe(true);
    const r2 = await reimburse(c2, "w16-dup");
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/conflict/i);
    expect(await claimStatus(c2)).toBe("approved"); // untouched
  });

  it("a reimbursed claim whose payment chain was altered in ANY material field is refused", async () => {
    const cases: [string, string][] = [
      [`payment_date='2026-08-01'`, "date"],
      [`method='wire'`, "method"],
      [`currency='USD'`, "currency"],
      [`direction='in'`, "direction"],
      [`status='void'`, "status"],
      [`amount=999`, "amount"],
      [`party_id='${otherEmp}'`, "party"],
    ];
    for (const [mut, label] of cases) {
      const key = "w16-mut-" + label;
      const c = await mkClaim(50);
      expect((await reimburse(c, key)).ok, label).toBe(true);
      await q(`update payments set ${mut} where company_id=$1 and idempotency_key=$2`, [co, key]);
      const r = await reimburse(c, key, "2026-07-15");
      expect(r.ok, label).toBe(false);
      expect(r.error, label).toMatch(/source-bound chain|journal binding/i);
    }
  });

  it("a reimbursed claim whose reimbursement row was altered is refused", async () => {
    const c = await mkClaim(50);
    expect((await reimburse(c, "w16-re")).ok).toBe(true);
    await q(`update reimbursements set employee_id=$3 where company_id=$1 and expense_claim_id=$2`, [co, c, otherEmp]);
    const r = await reimburse(c, "w16-re");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/source-bound chain/i);
  });

  it("a claim marked reimbursed with no payment/journal chain is refused, not returned as success", async () => {
    const c = await mkClaim(50);
    await q(`update expense_claims set status='reimbursed' where id=$1`, [c]); // corrupt: reimbursed, no chain
    const r = await reimburse(c, "w16-missing");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no consistent payment\/journal chain/i);
  });

  it("a pre-existing payment under the key, bound to a different journal, is refused (fresh path)", async () => {
    const c = await mkClaim(50);
    // A stray payment recorded under the key we will use, NOT linked to this claim's journal.
    // Every field the OLD check compared (party/amount/currency/direction) matches — only the
    // journal binding (and the WP16-added fields) exposes it.
    await q(`insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, status, idempotency_key) values ($1,'out','employee',$2,'LKR',50,'record','2026-07-15','recorded',$3)`, [co, empX, "w16-stray"]);
    const r = await reimburse(c, "w16-stray");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/different payment/i);
    expect(await claimStatus(c)).toBe("approved"); // untouched
  });

  it("a human cannot reimburse their own expense claim (separation of duties)", async () => {
    const own = await mkClaim(50, "approved", empAcct); // claimant = uAcct
    await asUser(uAcct);
    const r = await call(`select public.reimburse_expense_claim($1,$2,'5000','1000',$3,'2026-07-15','w16-sod') as v`, [co, own, uAcct]);
    await asWorker();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/own expense claim/i);
  });
});

// ── Concurrency: the claim FOR UPDATE lock serialises concurrent reimbursements ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, c1: any, c2: any;
let cco: string, cclaim: string;

async function blocksOnLock(sql: string, p1: unknown[], p2: unknown[]): Promise<boolean> {
  await c1.query("begin");
  await c1.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  await c1.query(sql, p1);
  await c2.query("begin");
  await c2.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  await c2.query("set local statement_timeout = '1500ms'");
  let blocked = false;
  try { await c2.query(sql, p2); } catch (e) { blocked = /statement timeout|canceling statement/i.test((e as Error).message); }
  await c1.query("rollback").catch(() => {});
  await c2.query("rollback").catch(() => {});
  return blocked;
}

describe.skipIf(!enabled)("WP16 reimbursement concurrency — live, two connections", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } }); await c.connect(); return c; };
    setup = await mk();
    cco = (await setup.query(`insert into companies (name, base_currency) values ('wp16c','LKR') returning id`)).rows[0].id;
    await setup.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'5000','Expense','expense')`, [cco]);
    const emp = (await setup.query(`insert into employees (company_id, name, status) values ($1,'CE','active') returning id`, [cco])).rows[0].id;
    cclaim = (await setup.query(`insert into expense_claims (company_id, employee_id, currency, amount, purpose, status) values ($1,$2,'LKR',50,'x','approved') returning id`, [cco, emp])).rows[0].id;
    c1 = await mk(); c2 = await mk();
  });
  afterAll(async () => {
    try { await c1?.query("rollback"); } catch { /* noop */ }
    try { await c2?.query("rollback"); } catch { /* noop */ }
    for (const sql of [`delete from reimbursements where company_id=$1`, `delete from payments where company_id=$1`, `delete from journal_lines where company_id=$1`, `delete from journal_entries where company_id=$1`, `delete from audit_events where company_id=$1`, `delete from expense_claims where company_id=$1`, `delete from employees where company_id=$1`, `delete from chart_of_accounts where company_id=$1`, `delete from companies where id=$1`]) {
      try { await setup.query(sql, [cco]); } catch { /* noop */ }
    }
    await Promise.all([c1?.end(), c2?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("a second concurrent reimbursement BLOCKS on the claim FOR UPDATE lock", async () => {
    const sql = `select public.reimburse_expense_claim($1,$2,'5000','1000',null::uuid,'2026-07-15','rcc')`;
    expect(await blocksOnLock(sql, [cco, cclaim], [cco, cclaim])).toBe(true);
  });
});
