/**
 * WP1 live company-isolation tests (NEXT_PHASE_DEVELOPER_BRIEF §WP1 "Minimum isolation
 * tests") — real RLS against a real Postgres, NOT a mock.
 *
 * ZERO-PERSISTENCE: everything runs inside a single transaction that is ROLLED BACK in
 * afterAll, so nothing is ever committed — safe to run even against a database that
 * holds real data. Each data statement runs inside a SAVEPOINT so an expected RLS
 * error (e.g. a denied insert) doesn't poison the outer transaction.
 *
 * RLS is exercised by switching to the `authenticated` role and setting the JWT `sub`
 * claim per user (Supabase `auth.uid()`), then asserting the policies filter access.
 *
 * Skipped unless `DATABASE_URL` is set. Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let companyA: string, companyB: string, userA: string, userB: string;

/** Run a statement inside a savepoint so an error rolls back only that statement. */
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

describe.skipIf(!enabled)("company isolation — live RLS, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    const co = async (name: string) => (await client.query(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [name])).rows[0].id;
    companyA = await co("wp1_test_A");
    companyB = await co("wp1_test_B");
    userA = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'wp1_uA',true) returning id`)).rows[0].id;
    userB = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'wp1_uB',true) returning id`)).rows[0].id;
    await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active'),($3,$4,'active')`, [companyA, userA, companyB, userB]);
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {}); // persist NOTHING
      await client.end().catch(() => {});
    }
  });

  it("Company A user cannot READ Company B", async () => {
    await asUser(userA);
    const { rows } = await q("select id from companies where id = $1", [companyB]);
    await asSuperuser();
    expect(rows.length).toBe(0);
  });

  it("Company A user CAN read their own company (RLS isn't just deny-all)", async () => {
    await asUser(userA);
    const { rows } = await q("select id from companies where id = $1", [companyA]);
    await asSuperuser();
    expect(rows.length).toBe(1);
  });

  it("Company A user cannot UPDATE Company B by known UUID", async () => {
    await asUser(userA);
    const res = await q("update companies set name = 'hacked' where id = $1", [companyB]);
    await asSuperuser();
    expect(res.rowCount).toBe(0);
  });

  it("Company A user cannot INSERT a membership into Company B", async () => {
    await asUser(userA);
    let threw = false;
    try {
      await q(`insert into memberships (company_id, user_id, status) values ($1,$2,'active')`, [companyB, userA]);
    } catch {
      threw = true;
    }
    await asSuperuser();
    expect(threw).toBe(true);
  });

  it("a suspended membership loses access", async () => {
    await q(`update memberships set status='suspended' where user_id=$1 and company_id=$2`, [userA, companyA]);
    await asUser(userA);
    const { rows } = await q("select id from companies where id = $1", [companyA]);
    await asSuperuser();
    await q(`update memberships set status='active' where user_id=$1 and company_id=$2`, [userA, companyA]);
    expect(rows.length).toBe(0);
  });
});
