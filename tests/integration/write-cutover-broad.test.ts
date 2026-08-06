/**
 * WP1 broad write-cutover verification — live, ZERO-PERSISTENCE. Proves the company
 * write policies (0034/0036) generalise across the converted domain: as an
 * authenticated user, inserts succeed in your OWN company and are blocked for ANOTHER,
 * and confirms the approvals-workflow tables gained write policies (0036).
 *
 * Skipped unless `DATABASE_URL` is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let companyA: string, companyB: string, userA: string;

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
async function canInsert(sql: string, params: unknown[]): Promise<boolean> {
  await asUser(userA);
  let ok = true;
  try {
    await q(sql, params);
  } catch {
    ok = false;
  }
  await asSuperuser();
  return ok;
}

describe.skipIf(!enabled)("broad write cutover — live RLS, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    const co = async (n: string) => (await client.query(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [n])).rows[0].id;
    companyA = await co("wp_bwc_A");
    companyB = await co("wp_bwc_B");
    userA = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'wp_bwc_uA',true) returning id`)).rows[0].id;
    await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active')`, [companyA, userA]);
  });
  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("customers: insert allowed in own company, blocked in another", async () => {
    expect(await canInsert(`insert into customers (company_id, name) values ($1,'C')`, [companyA])).toBe(true);
    expect(await canInsert(`insert into customers (company_id, name) values ($1,'C')`, [companyB])).toBe(false);
  });

  it("suppliers: insert allowed in own company, blocked in another", async () => {
    expect(await canInsert(`insert into suppliers (company_id, name) values ($1,'S')`, [companyA])).toBe(true);
    expect(await canInsert(`insert into suppliers (company_id, name) values ($1,'S')`, [companyB])).toBe(false);
  });

  it("approvals workflow tables gained write policies (0036)", async () => {
    for (const t of ["approval_requests", "approval_actions"]) {
      const { rows } = await client.query(`select count(*)::int n from pg_policies where tablename=$1 and cmd in ('INSERT','UPDATE','DELETE')`, [t]);
      expect(rows[0].n, `${t} write policies`).toBeGreaterThanOrEqual(3);
    }
  });
});
