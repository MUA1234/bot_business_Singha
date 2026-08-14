/**
 * WP10 — sensitive-table write RLS. Live against real Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0048: an ordinary company member can no longer write commercially
 * sensitive tables merely by belonging to the company (system invariant #2). The
 * business-management capabilities gate the writes; WhatsApp history and worker
 * notifications are service-only (no authenticated write at all).
 *
 * The tests exercise INSERT, which is gated purely by the WITH CHECK (has_capability)
 * predicate — cleanly isolating the WP10 WRITE model from the separate legacy
 * department-based READ policy (my_company()/my_department()), which governs row
 * visibility and is out of scope here.
 *
 * Positive:  owner_management (holding the new capability) CAN insert.
 * Negative:  staff_submitter / role-less member CANNOT.
 * Isolation: an authorised user of company A cannot write a company-B row.
 * Lifecycle: a suspended membership loses access even with the role attached.
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let coA: string, coB: string;
let uOwner: string, uStaff: string, uNobody: string, uSusp: string;

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
async function canInsert(userId: string, sql: string, params: unknown[] = []): Promise<boolean> {
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

let seq = 0;
const uniq = () => String(seq++);

describe.skipIf(!enabled)("WP10 sensitive-table write RLS — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    const mkCo = async (n: string) => (await client.query(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [n])).rows[0].id;
    coA = await mkCo("wp10_A");
    coB = await mkCo("wp10_B");
    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    uOwner = await mkUser("wp10_owner");
    uStaff = await mkUser("wp10_staff");
    uNobody = await mkUser("wp10_nobody");
    uSusp = await mkUser("wp10_suspended");
    const mkMem = async (co: string, u: string, role: string | null, status = "active") => {
      const id = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,$3) returning id`, [co, u, status])).rows[0].id;
      if (role) await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [id, co, role]);
      return id;
    };
    await mkMem(coA, uOwner, "owner_management");
    await mkMem(coA, uStaff, "staff_submitter");
    await mkMem(coA, uNobody, null);
    await mkMem(coA, uSusp, "owner_management", "suspended"); // has the role but membership suspended
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  // INSERT statements (unique text values so successive committed inserts never collide).
  const insProduct = (co: string): [string, unknown[]] => [`insert into product_catalog (company_id, name) values ($1,$2)`, [co, "Widget-" + uniq()]];
  const insQuotation = (co: string): [string, unknown[]] => [`insert into quotations (company_id, quote_number, public_token) values ($1,$2,$3)`, [co, "Q-" + uniq(), "tok-" + uniq()]];
  const insDivision = (co: string): [string, unknown[]] => [`insert into divisions (company_id, name) values ($1,$2)`, [co, "Ops-" + uniq()]];
  const insObjective = (co: string): [string, unknown[]] => [`insert into objectives (company_id, title) values ($1,$2)`, [co, "Grow-" + uniq()]];
  const insApprovalPolicy = (co: string): [string, unknown[]] => [`insert into approval_policies (company_id, version, policy) values ($1,$2,'{}'::jsonb)`, [co, seq++]];

  it("owner_management (with the capability) CAN write sensitive tables", async () => {
    expect(await canInsert(uOwner, ...insProduct(coA))).toBe(true); // set a product price
    expect(await canInsert(uOwner, ...insQuotation(coA))).toBe(true); // create a quotation
    expect(await canInsert(uOwner, ...insDivision(coA))).toBe(true); // org structure
    expect(await canInsert(uOwner, ...insObjective(coA))).toBe(true);
    expect(await canInsert(uOwner, ...insApprovalPolicy(coA))).toBe(true);
  });

  it("an ordinary staff member CANNOT change prices, quotations, policies, org or objectives", async () => {
    expect(await canInsert(uStaff, ...insProduct(coA))).toBe(false); // change a product price
    expect(await canInsert(uStaff, ...insQuotation(coA))).toBe(false); // forge/alter a quotation
    expect(await canInsert(uStaff, ...insApprovalPolicy(coA))).toBe(false); // change approval policy
    expect(await canInsert(uStaff, ...insDivision(coA))).toBe(false); // change org structure
    expect(await canInsert(uStaff, ...insObjective(coA))).toBe(false);
  });

  it("a role-less member CANNOT write any sensitive table", async () => {
    expect(await canInsert(uNobody, ...insProduct(coA))).toBe(false);
    expect(await canInsert(uNobody, ...insApprovalPolicy(coA))).toBe(false);
  });

  it("WhatsApp history and notifications are service-only — no authenticated write, even for owner", async () => {
    const conv = `insert into wa_conversations (company_id, customer_wa_id) values ($1,'9477')`;
    const msg = `insert into wa_messages (conversation_id, company_id, direction) values (gen_random_uuid(),$1,'in')`;
    const note = `insert into notifications (company_id, recipient_id, type, title) values ($1, gen_random_uuid(), 'x','y')`;
    expect(await canInsert(uOwner, conv, [coA])).toBe(false); // cannot forge a conversation
    expect(await canInsert(uOwner, msg, [coA])).toBe(false); // cannot forge WhatsApp history
    expect(await canInsert(uStaff, msg, [coA])).toBe(false);
    expect(await canInsert(uOwner, note, [coA])).toBe(false);
  });

  it("cross-company: an authorised company-A user cannot write a company-B row", async () => {
    expect(await canInsert(uOwner, ...insProduct(coB))).toBe(false);
    expect(await canInsert(uOwner, ...insDivision(coB))).toBe(false);
  });

  it("a suspended membership loses write access even with the role attached", async () => {
    expect(await canInsert(uSusp, ...insProduct(coA))).toBe(false);
    expect(await canInsert(uSusp, ...insApprovalPolicy(coA))).toBe(false);
  });
});
