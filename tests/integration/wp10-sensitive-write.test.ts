/**
 * WP10 — sensitive-table write RLS. Live against real Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0048: an ordinary company member can no longer write commercially
 * sensitive tables merely by belonging to the company (system invariant #2). The
 * business-management capabilities gate the writes; WhatsApp history and worker
 * notifications are service-only (no authenticated write at all).
 *
 * Coverage — INSERT, UPDATE and DELETE — for each of:
 *   authorised capability holder (owner_management) → allowed;
 *   ordinary staff (staff_submitter)               → denied;
 *   role-less member                               → denied;
 *   cross-company                                  → denied;
 *   suspended membership                           → denied;
 *   WhatsApp history + notifications               → denied for ALL authenticated users.
 *
 * Error discipline (see `runWrite`): the two denial mechanisms are asserted DISTINCTLY —
 *   • a capability (has_capability) INSERT rejection and a service-only grant rejection
 *     both raise SQLSTATE 42501 (insufficient_privilege); we assert that exact code;
 *   • an RLS USING filter on UPDATE/DELETE does NOT raise — it silently affects 0 rows;
 *     we assert rowCount 0 with no error.
 * Any OTHER database error (constraint, connection, typo) is rethrown and fails the test —
 * exceptions are never blanket-converted into a passing "denied" result.
 *
 * UPDATE/DELETE are exercised on tables whose READ policy is membership-based
 * (has_company_access): divisions, objectives, approval_policies — so every active member
 * can SEE the row and the row-count difference isolates the WRITE (has_capability) gate
 * from the separate legacy department-based read policy. INSERT is exercised on
 * product_catalog/quotations too (WITH CHECK only — no read dependency).
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

/** SQLSTATE insufficient_privilege: RLS WITH CHECK violation on INSERT, or a missing grant. */
const INSUFFICIENT_PRIVILEGE = "42501";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let coA: string, coB: string;
let uOwner: string, uStaff: string, uNobody: string, uSusp: string;
let divA: string, objA: string, polA: string, divB: string, waMsgA: string, notifA: string;

async function asUser(userId: string) {
  await client.query("set local role authenticated");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: "authenticated" })]);
}
async function asSuperuser() {
  await client.query("reset role");
}

/**
 * Run one write as `userId` inside a savepoint that is ALWAYS rolled back (zero-persistence,
 * so seeded rows survive for later assertions and there are no cross-assertion collisions).
 * Returns { rowCount } on success, or { rowCount: 0, code } when PostgreSQL rejected the write
 * with an insufficient-privilege error (42501). ANY other error is rethrown → the test fails.
 */
async function runWrite(userId: string, sql: string, params: unknown[] = []): Promise<{ rowCount: number; code?: string }> {
  await asUser(userId);
  await client.query("savepoint p");
  try {
    const r = await client.query(sql, params);
    return { rowCount: r.rowCount ?? 0 };
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === INSUFFICIENT_PRIVILEGE) return { rowCount: 0, code };
    throw e; // unexpected (constraint / connection / bad SQL) — must fail the test
  } finally {
    await client.query("rollback to savepoint p").catch(() => {});
    await asSuperuser();
  }
}
/** Rows a write would affect (0 = RLS-filtered denial, ≥1 = allowed). Throws on unexpected errors. */
async function rowsAffected(userId: string, sql: string, params: unknown[] = []): Promise<number> {
  return (await runWrite(userId, sql, params)).rowCount;
}
/** The SQLSTATE if the write was rejected with an error, else undefined (allowed / silently filtered). */
async function sqlstate(userId: string, sql: string, params: unknown[] = []): Promise<string | undefined> {
  return (await runWrite(userId, sql, params)).code;
}

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

    // UPDATE/DELETE targets (seeded as superuser). divisions/objectives/approval_policies read
    // via has_company_access, so any active member can see them.
    divA = (await client.query(`insert into divisions (company_id, name) values ($1,'DivA') returning id`, [coA])).rows[0].id;
    objA = (await client.query(`insert into objectives (company_id, title) values ($1,'ObjA') returning id`, [coA])).rows[0].id;
    // is_active=false so it does not occupy the single-active-policy slot (partial unique index).
    polA = (await client.query(`insert into approval_policies (company_id, version, policy, is_active) values ($1,900,'{}'::jsonb,false) returning id`, [coA])).rows[0].id;
    divB = (await client.query(`insert into divisions (company_id, name) values ($1,'DivB') returning id`, [coB])).rows[0].id;
    const conv = (await client.query(`insert into wa_conversations (company_id, customer_wa_id) values ($1,'9477') returning id`, [coA])).rows[0].id;
    waMsgA = (await client.query(`insert into wa_messages (conversation_id, company_id, direction) values ($1,$2,'inbound') returning id`, [conv, coA])).rows[0].id;
    // notifications.recipient_id FKs profiles(id) → auth.users(id); seed a minimal recipient
    // identity so the notification is a REAL row (makes the service-only denial airtight).
    const recip = await mkUser("wp10_recip");
    await client.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [recip]);
    await client.query(`insert into profiles (id, company_id, username, department, is_admin, is_active) values ($1,$2,$3,'sales',false,true)`, [recip, coA, "recip-" + recip]);
    notifA = (await client.query(`insert into notifications (company_id, recipient_id, type, title) values ($1,$2,'x','y') returning id`, [coA, recip])).rows[0].id;
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  // ── INSERT (WITH CHECK = has_capability → a rejection raises 42501) ──
  const insProduct = (co: string): [string, unknown[]] => [`insert into product_catalog (company_id, name) values ($1,'Widget')`, [co]];
  const insQuotation = (co: string): [string, unknown[]] => [`insert into quotations (company_id, quote_number, public_token) values ($1,'Q-1','tok-1')`, [co]];
  const insApprovalPolicy = (co: string): [string, unknown[]] => [`insert into approval_policies (company_id, version, policy) values ($1,1,'{}'::jsonb)`, [co]];

  it("owner_management (with the capability) CAN insert sensitive rows", async () => {
    expect(await rowsAffected(uOwner, ...insProduct(coA))).toBe(1); // set a product price
    expect(await rowsAffected(uOwner, ...insQuotation(coA))).toBe(1); // create a quotation
    expect(await rowsAffected(uOwner, ...insApprovalPolicy(coA))).toBe(1);
  });

  it("staff / role-less / cross-company / suspended INSERT is rejected with SQLSTATE 42501", async () => {
    expect(await sqlstate(uStaff, ...insProduct(coA))).toBe(INSUFFICIENT_PRIVILEGE); // change a price
    expect(await sqlstate(uStaff, ...insQuotation(coA))).toBe(INSUFFICIENT_PRIVILEGE); // forge a quotation
    expect(await sqlstate(uNobody, ...insProduct(coA))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(uOwner, ...insProduct(coB))).toBe(INSUFFICIENT_PRIVILEGE); // cross-company
    expect(await sqlstate(uSusp, ...insProduct(coA))).toBe(INSUFFICIENT_PRIVILEGE); // suspended
  });

  // ── UPDATE (has_capability USING; an unauthorised member is silently filtered to 0 rows) ──
  const updDiv = (id: string): [string, unknown[]] => [`update divisions set name='hacked' where id=$1`, [id]];
  const updObj = (id: string): [string, unknown[]] => [`update objectives set title='hacked' where id=$1`, [id]];
  const updPol = (id: string): [string, unknown[]] => [`update approval_policies set policy='{"x":1}'::jsonb where id=$1`, [id]];

  it("owner_management CAN update sensitive rows", async () => {
    expect(await rowsAffected(uOwner, ...updDiv(divA))).toBe(1);
    expect(await rowsAffected(uOwner, ...updObj(objA))).toBe(1);
    expect(await rowsAffected(uOwner, ...updPol(polA))).toBe(1);
  });

  it("ordinary staff / role-less / suspended UPDATE is filtered to 0 rows (no error)", async () => {
    for (const u of [uStaff, uNobody, uSusp]) {
      expect(await runWrite(u, ...updDiv(divA))).toEqual({ rowCount: 0 }); // 0 rows AND no error code
      expect(await rowsAffected(u, ...updObj(objA))).toBe(0);
      expect(await rowsAffected(u, ...updPol(polA))).toBe(0);
    }
  });

  it("cross-company: owner cannot update a company-B row (0 rows)", async () => {
    expect(await runWrite(uOwner, ...updDiv(divB))).toEqual({ rowCount: 0 });
  });

  // ── DELETE (has_capability USING) ──
  const delDiv = (id: string): [string, unknown[]] => [`delete from divisions where id=$1`, [id]];
  const delObj = (id: string): [string, unknown[]] => [`delete from objectives where id=$1`, [id]];
  const delPol = (id: string): [string, unknown[]] => [`delete from approval_policies where id=$1`, [id]];

  it("owner_management CAN delete sensitive rows", async () => {
    expect(await rowsAffected(uOwner, ...delDiv(divA))).toBe(1);
    expect(await rowsAffected(uOwner, ...delObj(objA))).toBe(1);
    expect(await rowsAffected(uOwner, ...delPol(polA))).toBe(1);
  });

  it("ordinary staff / role-less / suspended DELETE is filtered to 0 rows (no error)", async () => {
    for (const u of [uStaff, uNobody, uSusp]) {
      expect(await runWrite(u, ...delDiv(divA))).toEqual({ rowCount: 0 });
      expect(await rowsAffected(u, ...delObj(objA))).toBe(0);
      expect(await rowsAffected(u, ...delPol(polA))).toBe(0);
    }
  });

  it("cross-company: owner cannot delete a company-B row (0 rows)", async () => {
    expect(await runWrite(uOwner, ...delDiv(divB))).toEqual({ rowCount: 0 });
  });

  // ── service-only: WhatsApp history + notifications reject every authenticated write (42501) ──
  it("WhatsApp history and notifications reject authenticated insert/update/delete with SQLSTATE 42501", async () => {
    const insMsg = `insert into wa_messages (conversation_id, company_id, direction) values (gen_random_uuid(),$1,'inbound')`;
    const insNote = `insert into notifications (company_id, recipient_id, type, title) values ($1, gen_random_uuid(), 'x','y')`;
    expect(await sqlstate(uOwner, insMsg, [coA])).toBe(INSUFFICIENT_PRIVILEGE); // cannot forge WhatsApp history
    expect(await sqlstate(uStaff, insMsg, [coA])).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(uOwner, insNote, [coA])).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(uOwner, `update wa_messages set direction='outbound' where id=$1`, [waMsgA])).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(uStaff, `update wa_messages set direction='outbound' where id=$1`, [waMsgA])).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(uOwner, `delete from wa_messages where id=$1`, [waMsgA])).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(uOwner, `update notifications set title='z' where id=$1`, [notifA])).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(uOwner, `delete from notifications where id=$1`, [notifA])).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
