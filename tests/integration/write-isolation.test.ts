/**
 * WP1 write isolation — live against real Postgres, ZERO-PERSISTENCE. Proves migration
 * 0034's company-scoped write policies: as an authenticated user, a write into your OWN
 * company succeeds, but a write into ANOTHER company is blocked by RLS (with check /
 * using), so a cross-company write is impossible at the database — the backstop for the
 * write-path cutover.
 *
 * Skipped unless `DATABASE_URL` is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let companyA: string, companyB: string, userA: string, leadInB: string;

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

describe.skipIf(!enabled)("write isolation — live RLS, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    const co = async (n: string) => (await client.query(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [n])).rows[0].id;
    companyA = await co("wp_wr_A");
    companyB = await co("wp_wr_B");
    userA = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'wp_wr_uA',true) returning id`)).rows[0].id;
    await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active')`, [companyA, userA]);
    leadInB = (await client.query(`insert into leads (company_id, name) values ($1,'B-lead') returning id`, [companyB])).rows[0].id;
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("a user CAN insert a lead into their own company", async () => {
    await asUser(userA);
    const r = await q(`insert into leads (company_id, name) values ($1,'A-lead') returning id`, [companyA]);
    await asSuperuser();
    expect(r.rows[0].id).toBeTruthy();
  });

  it("a user CANNOT insert a lead into another company (RLS with check)", async () => {
    await asUser(userA);
    let threw = false;
    try {
      await q(`insert into leads (company_id, name) values ($1,'X')`, [companyB]);
    } catch {
      threw = true;
    }
    await asSuperuser();
    expect(threw).toBe(true);
  });

  it("a user CANNOT update another company's lead by known UUID", async () => {
    await asUser(userA);
    const res = await q(`update leads set name='hacked' where id=$1`, [leadInB]);
    await asSuperuser();
    expect(res.rowCount).toBe(0); // RLS filters the row out of the update
  });
});
