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
 * UPDATE/DELETE are exercised on tables whose READ policy is membership-based
 * (has_company_access): divisions, objectives, approval_policies. Every active member can
 * therefore SEE the row, so the row-count difference isolates the WRITE (has_capability)
 * gate rather than the separate legacy department-based read policy. INSERT is exercised
 * on product_catalog/quotations too (WITH CHECK only — no read dependency).
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
// Pre-seeded rows (as superuser) that UPDATE/DELETE target.
let divA: string, objA: string, polA: string, divB: string, waMsgA: string, notifA: string;

async function asUser(userId: string) {
  await client.query("set local role authenticated");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: "authenticated" })]);
}
async function asSuperuser() {
  await client.query("reset role");
}
// INSERT probe: commits on success (unique values keep committed rows from colliding).
async function canInsert(userId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  await asUser(userId);
  await client.query("savepoint s");
  let ok = true;
  try {
    await client.query(sql, params);
    await client.query("release savepoint s");
  } catch {
    ok = false;
    await client.query("rollback to savepoint s");
  }
  await asSuperuser();
  return ok;
}
// UPDATE/DELETE probe: ALWAYS rolls back, so the seeded target row survives for the next
// assertion. Returns the affected row count (0 = denied, whether by RLS filter or a
// grant-level "permission denied" error on a service-only table).
async function affects(userId: string, sql: string, params: unknown[] = []): Promise<number> {
  await asUser(userId);
  await client.query("savepoint p");
  let n = 0;
  try {
    const r = await client.query(sql, params);
    n = r.rowCount ?? 0;
  } catch {
    n = 0;
  }
  await client.query("rollback to savepoint p").catch(() => {});
  await asSuperuser();
  return n;
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

    // Seed UPDATE/DELETE targets as superuser. divisions/objectives/approval_policies read
    // via has_company_access, so an active member can see them.
    divA = (await client.query(`insert into divisions (company_id, name) values ($1,'DivA') returning id`, [coA])).rows[0].id;
    objA = (await client.query(`insert into objectives (company_id, title) values ($1,'ObjA') returning id`, [coA])).rows[0].id;
    // is_active=false so it does not occupy the single-active-policy slot (a partial unique
    // index), leaving the owner's positive INSERT free; it is only an UPDATE/DELETE target.
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

  // ── INSERT (WITH CHECK = has_capability; no read dependency) ──
  const insProduct = (co: string): [string, unknown[]] => [`insert into product_catalog (company_id, name) values ($1,$2)`, [co, "Widget-" + uniq()]];
  const insQuotation = (co: string): [string, unknown[]] => [`insert into quotations (company_id, quote_number, public_token) values ($1,$2,$3)`, [co, "Q-" + uniq(), "tok-" + uniq()]];
  const insApprovalPolicy = (co: string): [string, unknown[]] => [`insert into approval_policies (company_id, version, policy) values ($1,$2,'{}'::jsonb)`, [co, seq++]];

  it("owner_management (with the capability) CAN insert sensitive rows", async () => {
    expect(await canInsert(uOwner, ...insProduct(coA))).toBe(true); // set a product price
    expect(await canInsert(uOwner, ...insQuotation(coA))).toBe(true); // create a quotation
    expect(await canInsert(uOwner, ...insApprovalPolicy(coA))).toBe(true);
  });

  it("staff / role-less / cross-company / suspended CANNOT insert", async () => {
    expect(await canInsert(uStaff, ...insProduct(coA))).toBe(false); // change a product price
    expect(await canInsert(uStaff, ...insQuotation(coA))).toBe(false); // forge/alter a quotation
    expect(await canInsert(uNobody, ...insProduct(coA))).toBe(false);
    expect(await canInsert(uOwner, ...insProduct(coB))).toBe(false); // cross-company
    expect(await canInsert(uSusp, ...insProduct(coA))).toBe(false); // suspended
  });

  // ── UPDATE (USING/CHECK = has_capability; row visible to every active member via has_company_access) ──
  const updDiv = (id: string): [string, unknown[]] => [`update divisions set name='hacked' where id=$1`, [id]];
  const updObj = (id: string): [string, unknown[]] => [`update objectives set title='hacked' where id=$1`, [id]];
  const updPol = (id: string): [string, unknown[]] => [`update approval_policies set policy='{"x":1}'::jsonb where id=$1`, [id]];

  it("owner_management CAN update sensitive rows", async () => {
    expect(await affects(uOwner, ...updDiv(divA))).toBe(1);
    expect(await affects(uOwner, ...updObj(objA))).toBe(1);
    expect(await affects(uOwner, ...updPol(polA))).toBe(1);
  });

  it("ordinary staff / role-less / suspended CANNOT update (0 rows)", async () => {
    for (const u of [uStaff, uNobody, uSusp]) {
      expect(await affects(u, ...updDiv(divA))).toBe(0);
      expect(await affects(u, ...updObj(objA))).toBe(0);
      expect(await affects(u, ...updPol(polA))).toBe(0);
    }
  });

  it("cross-company: owner cannot update a company-B row", async () => {
    expect(await affects(uOwner, ...updDiv(divB))).toBe(0);
  });

  // ── DELETE (USING = has_capability) ──
  const delDiv = (id: string): [string, unknown[]] => [`delete from divisions where id=$1`, [id]];
  const delObj = (id: string): [string, unknown[]] => [`delete from objectives where id=$1`, [id]];
  const delPol = (id: string): [string, unknown[]] => [`delete from approval_policies where id=$1`, [id]];

  it("owner_management CAN delete sensitive rows", async () => {
    expect(await affects(uOwner, ...delDiv(divA))).toBe(1);
    expect(await affects(uOwner, ...delObj(objA))).toBe(1);
    expect(await affects(uOwner, ...delPol(polA))).toBe(1);
  });

  it("ordinary staff / role-less / suspended CANNOT delete (0 rows)", async () => {
    for (const u of [uStaff, uNobody, uSusp]) {
      expect(await affects(u, ...delDiv(divA))).toBe(0);
      expect(await affects(u, ...delObj(objA))).toBe(0);
      expect(await affects(u, ...delPol(polA))).toBe(0);
    }
  });

  it("cross-company: owner cannot delete a company-B row", async () => {
    expect(await affects(uOwner, ...delDiv(divB))).toBe(0);
  });

  // ── service-only: WhatsApp history + notifications reject every authenticated write ──
  it("WhatsApp history and notifications: no authenticated insert/update/delete, even for owner", async () => {
    // INSERT
    const insMsg = `insert into wa_messages (conversation_id, company_id, direction) values (gen_random_uuid(),$1,'inbound')`;
    const insNote = `insert into notifications (company_id, recipient_id, type, title) values ($1, gen_random_uuid(), 'x','y')`;
    expect(await canInsert(uOwner, insMsg, [coA])).toBe(false); // cannot forge WhatsApp history
    expect(await canInsert(uStaff, insMsg, [coA])).toBe(false);
    expect(await canInsert(uOwner, insNote, [coA])).toBe(false);
    // UPDATE / DELETE (grant revoked → permission denied → 0)
    expect(await affects(uOwner, `update wa_messages set direction='outbound' where id=$1`, [waMsgA])).toBe(0);
    expect(await affects(uStaff, `update wa_messages set direction='outbound' where id=$1`, [waMsgA])).toBe(0);
    expect(await affects(uOwner, `delete from wa_messages where id=$1`, [waMsgA])).toBe(0);
    expect(await affects(uOwner, `update notifications set title='z' where id=$1`, [notifA])).toBe(0);
    expect(await affects(uOwner, `delete from notifications where id=$1`, [notifA])).toBe(0);
  });
});
