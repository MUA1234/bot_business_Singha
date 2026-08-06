/**
 * WP1 live company-isolation tests (NEXT_PHASE_DEVELOPER_BRIEF §WP1 "Minimum
 * isolation tests"). These MUST run against a real Postgres/Supabase database — a
 * mocked unit test does not prove RLS (Brief: "Do not claim a security or database
 * behaviour is verified using only a mocked unit test").
 *
 * They are SKIPPED unless `DATABASE_URL` is set, and they REFUSE to run against the
 * known production project as a safety guard (they create + drop test companies).
 * Point `DATABASE_URL` at a throwaway/staging Postgres to execute them.
 *
 * Run:  DATABASE_URL=postgres://... npx vitest run tests/integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
// Guard: never run against the live Singha project (creates/drops data).
const PROD_MARKERS = ["juwpzzkuyqygcjrubqpt"]; // known prod Supabase ref
const looksProd = PROD_MARKERS.some((m) => URL.includes(m));
const enabled = !!URL && !looksProd;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Client: any;

describe.skipIf(!enabled)("company isolation (live DB)", () => {
  // Two companies, two users (one membership each), created with a unique test prefix.
  const tag = `wp1_${Date.now()}`;
  let admin: any; // service/superuser session used only for seeding + teardown

  // Helper: open a session that behaves as a given auth user (Supabase auth.uid()).
  async function asUser(userId: string) {
    const c = new Client({ connectionString: URL });
    await c.connect();
    await c.query("set role authenticated");
    await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
    return c;
  }

  let companyA: string, companyB: string, userA: string, userB: string;

  beforeAll(async () => {
    // `pg` is an optional peer for live tests; string-typed specifier avoids a
    // compile-time module-resolution error when it is not installed.
    ({ Client } = await import("pg" as string));
    admin = new Client({ connectionString: URL });
    await admin.connect();

    const mk = async (name: string) => {
      const { rows } = await admin.query(
        `insert into companies (name) values ($1) returning id`, [`${tag}_${name}`]);
      return rows[0].id as string;
    };
    companyA = await mk("A");
    companyB = await mk("B");
    userA = (await admin.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(), $1, true) returning id`, [`${tag}_ua`])).rows[0].id;
    userB = (await admin.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(), $1, true) returning id`, [`${tag}_ub`])).rows[0].id;
    await admin.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active'),($3,$4,'active')`, [companyA, userA, companyB, userB]);
  });

  afterAll(async () => {
    if (!admin) return;
    // Clean up everything created under the test tag.
    await admin.query(`delete from memberships where company_id in (select id from companies where name like $1)`, [`${tag}%`]);
    await admin.query(`delete from users where full_name like $1`, [`${tag}%`]);
    await admin.query(`delete from companies where name like $1`, [`${tag}%`]);
    await admin.end();
  });

  it("Company A user cannot READ Company B rows", async () => {
    const a = await asUser(userA);
    const { rows } = await a.query("select id from companies where id = $1", [companyB]);
    expect(rows.length).toBe(0);
    await a.end();
  });

  it("Company A user cannot UPDATE a Company B row by known UUID", async () => {
    const a = await asUser(userA);
    const res = await a.query("update companies set name = 'hacked' where id = $1", [companyB]);
    expect(res.rowCount).toBe(0); // RLS filters the row out
    await a.end();
  });

  it("Company A user cannot INSERT a membership into Company B", async () => {
    const a = await asUser(userA);
    await expect(
      a.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active')`, [companyB, userA]),
    ).rejects.toBeTruthy();
    await a.end();
  });

  it("a suspended membership loses access", async () => {
    await admin.query(`update memberships set status='suspended' where user_id=$1 and company_id=$2`, [userA, companyA]);
    const a = await asUser(userA);
    const { rows } = await a.query("select id from companies where id = $1", [companyA]);
    expect(rows.length).toBe(0);
    await a.end();
    await admin.query(`update memberships set status='active' where user_id=$1 and company_id=$2`, [userA, companyA]);
  });
});
