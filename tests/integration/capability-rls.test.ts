/**
 * WP1 capability write-RLS — live against real Postgres, ZERO-PERSISTENCE. Proves the
 * capability policies from migration 0023 actually gate writes:
 *   - has_capability() reflects seeded role→permission grants
 *   - identity-table writes require `administer_accounts` (system_administrator)
 *   - task creation requires `create_draft` (staff_submitter has it; a role-less
 *     member does not)
 *
 * Skipped unless `DATABASE_URL` is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let company: string, uAdmin: string, uStaff: string, uNobody: string;

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
async function capability(userId: string, cap: string): Promise<boolean> {
  await asUser(userId);
  const r = await q(`select public.has_capability($1,$2) as ok`, [company, cap]);
  await asSuperuser();
  return r.rows[0].ok;
}

describe.skipIf(!enabled)("capability write-RLS — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    company = (await client.query(`insert into companies (name, base_currency) values ('wp_cap','LKR') returning id`)).rows[0].id;
    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    uAdmin = await mkUser("wp_cap_admin");
    uStaff = await mkUser("wp_cap_staff");
    uNobody = await mkUser("wp_cap_nobody");
    const mkMem = async (u: string, role: string | null) => {
      const id = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [company, u])).rows[0].id;
      if (role) await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [id, company, role]);
      return id;
    };
    await mkMem(uAdmin, "system_administrator");
    await mkMem(uStaff, "staff_submitter");
    await mkMem(uNobody, null);
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("has_capability reflects the seeded role→permission grants", async () => {
    expect(await capability(uAdmin, "administer_accounts")).toBe(true);
    expect(await capability(uStaff, "administer_accounts")).toBe(false);
    expect(await capability(uStaff, "create_draft")).toBe(true);
    expect(await capability(uNobody, "create_draft")).toBe(false);
  });

  it("identity-table writes require administer_accounts", async () => {
    const ins = `insert into organisation_units (company_id, type, name) values ($1,'department',$2)`;
    expect(await canDo(uAdmin, ins, [company, "OU-admin"])).toBe(true);
    expect(await canDo(uStaff, ins, [company, "OU-staff"])).toBe(false);
  });

  it("task creation requires create_draft", async () => {
    const ins = `insert into tasks (company_id, title, status) values ($1,$2,'captured')`;
    expect(await canDo(uStaff, ins, [company, "T-staff"])).toBe(true);
    expect(await canDo(uNobody, ins, [company, "T-nobody"])).toBe(false);
  });
});
