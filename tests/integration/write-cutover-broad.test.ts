/**
 * Broad write-cutover verification — live, ZERO-PERSISTENCE. Updated for the Security &
 * Reliability Gate (migration 0038): sensitive-domain writes are now CAPABILITY-gated, not
 * merely company-scoped, and the approval workflow tables are APPEND-ONLY with an insert
 * policy that enforces separation of duties. Proves:
 *   - a capability holder writes in their OWN company, and is blocked in ANOTHER;
 *   - a company member WITHOUT the capability is blocked even in their own company;
 *   - approval_requests/approval_actions have an insert policy and NO update/delete policy.
 *
 * Skipped unless `DATABASE_URL` is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let companyA: string, companyB: string, uAcct: string, uNoCap: string;

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
async function asUser(u: string) {
  await client.query("set local role authenticated");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: u, role: "authenticated" })]);
}
async function asSuperuser() {
  await client.query("reset role");
}
async function canInsertAs(u: string, sql: string, params: unknown[]): Promise<boolean> {
  await asUser(u);
  let ok = true;
  try {
    await q(sql, params);
  } catch {
    ok = false;
  }
  await asSuperuser();
  return ok;
}

describe.skipIf(!enabled)("broad write cutover — capability-gated, live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    const co = async (n: string) => (await client.query(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [n])).rows[0].id;
    companyA = await co("wp_bwc_A");
    companyB = await co("wp_bwc_B");
    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    uAcct = await mkUser("wp_bwc_acct");
    uNoCap = await mkUser("wp_bwc_nocap");
    // uAcct: accountant (holds finance.invoice.create + finance.bill.create) in company A.
    const mA = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [companyA, uAcct])).rows[0].id;
    await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'accountant')`, [mA, companyA]);
    // uNoCap: active member of A but with NO role → no finance capability.
    await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active')`, [companyA, uNoCap]);
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("customers: a finance capability holder writes in-company; cross-company and no-capability are blocked", async () => {
    expect(await canInsertAs(uAcct, `insert into customers (company_id, name) values ($1,'C')`, [companyA])).toBe(true);
    expect(await canInsertAs(uAcct, `insert into customers (company_id, name) values ($1,'C')`, [companyB])).toBe(false); // no capability in B
    expect(await canInsertAs(uNoCap, `insert into customers (company_id, name) values ($1,'C')`, [companyA])).toBe(false); // member, but no capability
  });

  it("suppliers: same capability gate", async () => {
    expect(await canInsertAs(uAcct, `insert into suppliers (company_id, name) values ($1,'S')`, [companyA])).toBe(true);
    expect(await canInsertAs(uAcct, `insert into suppliers (company_id, name) values ($1,'S')`, [companyB])).toBe(false);
    expect(await canInsertAs(uNoCap, `insert into suppliers (company_id, name) values ($1,'S')`, [companyA])).toBe(false);
  });

  it("approval workflow tables are append-only with an insert policy (SoD in the policy)", async () => {
    for (const t of ["approval_requests", "approval_actions"]) {
      const ins = (await client.query(`select count(*)::int n from pg_policies where tablename=$1 and cmd='INSERT'`, [t])).rows[0].n;
      const mut = (await client.query(`select count(*)::int n from pg_policies where tablename=$1 and cmd in ('UPDATE','DELETE')`, [t])).rows[0].n;
      expect(ins, `${t} insert policy`).toBeGreaterThanOrEqual(1);
      expect(mut, `${t} must be append-only (no update/delete policy)`).toBe(0);
    }
  });
});
