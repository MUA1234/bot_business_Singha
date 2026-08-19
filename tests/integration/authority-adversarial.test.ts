/**
 * WP A adversarial authority tests — a disposable local PostgreSQL, ZERO-PERSISTENCE (one BEGIN … ROLLBACK).
 *
 * Proves migration 0038 makes the DB the final authority boundary using the AUTHENTICATED
 * role + realistic JWT claims (request.jwt.claims.sub = user id), exactly as a direct
 * Supabase API client would. Every property from the brief §5 "Required adversarial tests":
 *   - an ordinary worker cannot directly create/post/reverse a journal;
 *   - a sales/ordinary user cannot edit supplier bills or approvals;
 *   - a manager is NOT automatically granted finance authority;
 *   - a finance submitter cannot approve their own request (separation of duties);
 *   - an approver cannot exceed their amount ceiling;
 *   - a user cannot change another company's data with a known id;
 *   - a suspended member loses access even though a legacy access row still exists;
 *   - a delegated user cannot exceed the delegation's domain/date/amount, nor exceed the
 *     delegator's own authority;
 *   - service-only tables reject authenticated direct writes;
 *   - legitimate authorised actions still succeed.
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let coA: string, coB: string;
let uAcct: string, uStaff: string, uMgr: string, uReviewer: string, uOwner: string, uApprover: string;
let uSuspended: string, uLegacy: string, uDelFin: string, uDelExp: string, uDelStaff: string;
let supplierA: string, customerA: string, employeeA: string, arSelf: string;

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
async function asSuperuser() {
  await client.query("reset role");
}
/** Does `sql` succeed for `userId` (authenticated + RLS)? */
async function canDo(userId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  await asUser(userId);
  let ok = true;
  try {
    await q(sql, params);
  } catch {
    ok = false;
  }
  await asSuperuser();
  return ok;
}
/** Read a boolean function result as `userId`. */
async function boolVal(userId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  await asUser(userId);
  const r = await q(sql, params);
  await asSuperuser();
  return r.rows[0].v;
}

describe.skipIf(!enabled)("WP A authority — adversarial, live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");

    const mkCo = async (n: string) => (await client.query(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [n])).rows[0].id;
    coA = await mkCo("adv_A");
    coB = await mkCo("adv_B");

    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    const mkMem = async (co: string, u: string, role: string | null, status = "active") => {
      const id = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,$3) returning id`, [co, u, status])).rows[0].id;
      if (role) await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [id, co, role]);
      return id;
    };

    uAcct = await mkUser("adv_acct");
    uStaff = await mkUser("adv_staff");
    uMgr = await mkUser("adv_mgr");
    uReviewer = await mkUser("adv_reviewer");
    uOwner = await mkUser("adv_owner");
    uApprover = await mkUser("adv_approver");
    uSuspended = await mkUser("adv_suspended");
    uLegacy = await mkUser("adv_legacy");
    uDelFin = await mkUser("adv_del_fin");
    uDelExp = await mkUser("adv_del_exp");
    uDelStaff = await mkUser("adv_del_staff");

    const mAcct = await mkMem(coA, uAcct, "accountant");
    const mStaff = await mkMem(coA, uStaff, "staff_submitter");
    await mkMem(coA, uMgr, "project_manager");
    await mkMem(coA, uReviewer, "finance_reviewer");
    await mkMem(coA, uOwner, "owner_management");
    const mApprover = await mkMem(coA, uApprover, "payment_approver");
    // Suspended member WITH a lingering legacy access row → must still be denied.
    await mkMem(coA, uSuspended, "accountant", "suspended");
    await client.query(`insert into user_company_access (user_id, company_id, role_key) values ($1,$2,'staff_submitter')`, [uSuspended, coA]);
    // Legacy-only user (no membership) → access still resolves during staged cutover.
    await client.query(`insert into user_company_access (user_id, company_id, role_key) values ($1,$2,'staff_submitter')`, [uLegacy, coA]);
    // Role-less members that only obtain authority via delegation.
    await mkMem(coA, uDelFin, null);
    await mkMem(coA, uDelExp, null);
    await mkMem(coA, uDelStaff, null);

    // Approver amount ceiling: LKR 1000 for the 'payment' domain.
    await client.query(`insert into authority_rules (membership_id, company_id, domain, max_amount, currency) values ($1,$2,'payment',1000,'LKR')`, [mApprover, coA]);
    // Delegator (accountant) needs explicit finance authority for a delegation to confer any (deny-by-default, 0046).
    await client.query(`insert into authority_rules (membership_id, company_id, domain, is_unlimited) values ($1,$2,'finance',true)`, [mAcct, coA]);

    // Delegations (all in company A).
    const delFinTo = (await client.query(`select id from memberships where user_id=$1 and company_id=$2`, [uDelFin, coA])).rows[0].id;
    const delExpTo = (await client.query(`select id from memberships where user_id=$1 and company_id=$2`, [uDelExp, coA])).rows[0].id;
    const delStaffTo = (await client.query(`select id from memberships where user_id=$1 and company_id=$2`, [uDelStaff, coA])).rows[0].id;
    // Active finance delegation from the accountant, ceiling 1000.
    await client.query(`insert into delegations (company_id, from_membership, to_membership, starts_at, ends_at, domain, max_amount, currency) values ($1,$2,$3, now()-interval '1 day', now()+interval '1 day','finance',1000,'LKR')`, [coA, mAcct, delFinTo]);
    // Expired finance delegation from the accountant.
    await client.query(`insert into delegations (company_id, from_membership, to_membership, starts_at, ends_at, domain, max_amount, currency) values ($1,$2,$3, now()-interval '10 day', now()-interval '5 day','finance',1000,'LKR')`, [coA, mAcct, delExpTo]);
    // Active all-domain delegation FROM staff (who lacks finance) → cannot confer finance.
    await client.query(`insert into delegations (company_id, from_membership, to_membership, starts_at, ends_at, domain) values ($1,$2,$3, now()-interval '1 day', now()+interval '1 day', null)`, [coA, mStaff, delStaffTo]);

    // Fixtures for legitimate-action + FK-valid inserts.
    supplierA = (await client.query(`insert into suppliers (company_id, name, status) values ($1,'SupA','active') returning id`, [coA])).rows[0].id;
    customerA = (await client.query(`insert into customers (company_id, name, status) values ($1,'CusA','active') returning id`, [coA])).rows[0].id;
    // EmpA is uStaff's own employee record (0042 ties an expense claim to the authenticated employee).
    employeeA = (await client.query(`insert into employees (company_id, user_id, name, status) values ($1,$2,'EmpA','active') returning id`, [coA, uStaff])).rows[0].id;
    // An approval request submitted BY the finance reviewer (for the SoD test).
    arSelf = (await client.query(`insert into approval_requests (company_id, status, approvals_required, submitted_by) values ($1,'pending',1,$2) returning id`, [coA, uReviewer])).rows[0].id;
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("no authenticated user can directly write the ledger (journal is RPC-only)", async () => {
    const ins = `insert into journal_entries (company_id, posting_date, currency, status, total_debit, total_credit) values ($1, current_date, 'LKR', 'posted', 1, 1)`;
    expect(await canDo(uStaff, ins, [coA])).toBe(false);
    expect(await canDo(uAcct, ins, [coA])).toBe(false); // even the accountant posts only via the RPC
  });

  it("service-only tables reject authenticated direct writes", async () => {
    expect(await canDo(uAcct, `insert into payments (company_id, direction, currency, amount, method, payment_date) values ($1,'out','LKR',1,'record',current_date)`, [coA])).toBe(false);
    expect(await canDo(uAcct, `insert into message_outbox (company_id, recipient, body, idempotency_key) values ($1,'x','y',gen_random_uuid()::text)`, [coA])).toBe(false);
    expect(await canDo(uAcct, `insert into idempotency_keys (company_id, scope, key) values ($1,'s',gen_random_uuid()::text)`, [coA])).toBe(false);
    expect(await canDo(uAcct, `insert into audit_events (company_id, actor_type, action, entity_type) values ($1,'user','x','y')`, [coA])).toBe(false);
    // Control: the same payment insert succeeds as the table owner (proves it's RLS/grant, not columns).
    await asSuperuser();
    expect(await (async () => { try { await q(`insert into payments (company_id, direction, currency, amount, method, payment_date) values ($1,'out','LKR',1,'record',current_date)`, [coA]); return true; } catch { return false; } })()).toBe(true);
  });

  it("a manager is NOT automatically granted finance authority", async () => {
    const insBill = `insert into supplier_bills (company_id, supplier_id, currency, issue_date, total_amount, status) values ($1,$2,'LKR',current_date,100,'draft')`;
    expect(await canDo(uMgr, insBill, [coA, supplierA])).toBe(false);
  });

  it("an ordinary (sales/staff) user cannot edit supplier bills or approvals", async () => {
    expect(await canDo(uStaff, `insert into supplier_bills (company_id, supplier_id, currency, issue_date, total_amount, status) values ($1,$2,'LKR',current_date,100,'draft')`, [coA, supplierA])).toBe(false);
    expect(await canDo(uStaff, `insert into approval_actions (approval_request_id, company_id, actor_user_id, action) values ($1,$2,$3,'approve')`, [arSelf, coA, uStaff])).toBe(false);
  });

  it("a submitter cannot approve their own request; a different approver can (decide_approval RPC)", async () => {
    // finance_reviewer holds 'approve' but is the maker of arSelf → denied by SoD in the RPC.
    expect(await canDo(uReviewer, `select public.decide_approval($1,$2,'approve')`, [coA, arSelf])).toBe(false);
    // owner_management holds 'approve' and is NOT the maker → allowed.
    expect(await canDo(uOwner, `select public.decide_approval($1,$2,'approve')`, [coA, arSelf])).toBe(true);
  });

  it("an approver cannot exceed their amount ceiling", async () => {
    expect(await boolVal(uApprover, `select public.within_authority($1,'payment',500) as v`, [coA])).toBe(true);
    expect(await boolVal(uApprover, `select public.within_authority($1,'payment',5000) as v`, [coA])).toBe(false);
    // Deny-by-default (0046): a user with NO rule for a money domain has NO authority.
    expect(await boolVal(uStaff, `select public.within_authority($1,'payment',10) as v`, [coA])).toBe(false);
  });

  it("a user cannot change another company's data with a known id", async () => {
    const insCust = `insert into customers (company_id, name, status) values ($1,'X','active')`;
    expect(await canDo(uAcct, insCust, [coB])).toBe(false); // accountant of A has no capability in B
    expect(await canDo(uAcct, insCust, [coA])).toBe(true); // control — legitimate in own company
  });

  it("a suspended member loses access even though a legacy access row exists", async () => {
    expect(await boolVal(uSuspended, `select public.has_company_access($1) as v`, [coA])).toBe(false);
    expect(await boolVal(uLegacy, `select public.has_company_access($1) as v`, [coA])).toBe(true); // legacy-only still works
    expect(await boolVal(uAcct, `select public.has_company_access($1) as v`, [coA])).toBe(true);
  });

  it("a delegate is bounded by domain, date, amount and the delegator's own authority", async () => {
    // Active finance delegation from the accountant confers finance caps the accountant holds…
    expect(await boolVal(uDelFin, `select public.has_capability($1,'finance.bill.create') as v`, [coA])).toBe(true);
    // …but not a domain the delegator lacks / outside the delegation domain.
    expect(await boolVal(uDelFin, `select public.has_capability($1,'legal.matter.manage') as v`, [coA])).toBe(false);
    // Amount ceiling on the delegation is enforced.
    expect(await boolVal(uDelFin, `select public.within_authority($1,'finance',500) as v`, [coA])).toBe(true);
    expect(await boolVal(uDelFin, `select public.within_authority($1,'finance',5000) as v`, [coA])).toBe(false);
    // Expired delegation confers nothing.
    expect(await boolVal(uDelExp, `select public.has_capability($1,'finance.bill.create') as v`, [coA])).toBe(false);
    // A delegation from staff cannot confer more than staff holds.
    expect(await boolVal(uDelStaff, `select public.has_capability($1,'finance.bill.create') as v`, [coA])).toBe(false);
    expect(await boolVal(uDelStaff, `select public.has_capability($1,'operations.task.work') as v`, [coA])).toBe(true);
  });

  it("legitimate authorised actions still succeed", async () => {
    expect(await canDo(uAcct, `insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, total_amount, status) values ($1,$2,$3,'LKR',current_date,100,'draft')`, [coA, customerA, "ADV-" + Date.now()])).toBe(true);
    expect(await canDo(uAcct, `insert into supplier_bills (company_id, supplier_id, currency, issue_date, total_amount, status) values ($1,$2,'LKR',current_date,100,'draft')`, [coA, supplierA])).toBe(true);
    // Self-service: any active member may submit their own expense claim.
    expect(await canDo(uStaff, `insert into expense_claims (company_id, employee_id, currency, amount, purpose) values ($1,$2,'LKR',10,'lunch')`, [coA, employeeA])).toBe(true);
  });
});
