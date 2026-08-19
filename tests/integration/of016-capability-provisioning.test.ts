/**
 * OF-016 — `finance.duplicate.resolve` is provisionable by a real person, not just declared.
 *
 * A capability nobody can be granted is the same blocker as no capability at all — that is exactly
 * the shape of OF-005, still open: "nobody can work the review queue until someone is granted
 * operations.inbound.review". This asserts the whole provisioning chain: the permission exists, the
 * right roles carry it, a member of those roles genuinely resolves to it, a member of other roles
 * genuinely does not, and the role that carries it can actually be ASSIGNED through the owner's
 * admin surface rather than only by hand in SQL.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let co: string;
const SUFFIX = rnd();
const CAP = "finance.duplicate.resolve";

const rows = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;
const one = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];

async function memberWithRole(roleKey: string, status = "active"): Promise<string> {
  const u = randomUUID();
  await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [u]);
  await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict do nothing`, [u, `of16p ${roleKey}`]);
  const m = await one(`insert into memberships (company_id, user_id, status) values ($1,$2,$3) returning id`, [co, u, status]);
  await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [m.id, co, roleKey]);
  return u;
}


/**
 * Every capability literal passed to `has_capability` / `actor_has_capability` in a function body.
 *
 * Parenthesis-counted rather than regex-matched: the real call is
 * `actor_has_capability(auth.uid(), p_company, 'finance.duplicate.resolve')`, and a naive
 * `[^)]*` pattern stops at the `)` of `auth.uid()` and finds nothing — which reads as "this
 * function performs no capability check", the exact opposite of the truth. Scanning only for
 * capability-shaped strings anywhere in the body is no better: the audit action
 * `finance.duplicate_review_resolved` looks like one and is not.
 */
function capabilityArgs(def: string): string[] {
  const out: string[] = [];
  const re = /(?:actor_has_capability|has_capability)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(def)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < def.length && depth > 0) {
      if (def[i] === "(") depth += 1;
      else if (def[i] === ")") depth -= 1;
      i += 1;
    }
    const args = def.slice(start, i - 1);
    const literals = [...args.matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]!);
    if (literals.length) out.push(literals[literals.length - 1]!);
  }
  return out;
}

describe.skipIf(!enabled)("OF-016 — capability provisioning", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    co = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16p ${SUFFIX}`])).id;
  });

  afterAll(async () => {
    for (const sql of [
      `delete from membership_roles where company_id=$1`,
      `delete from memberships where company_id=$1`,
      `delete from companies where id=$1`,
    ]) { try { await db.query(sql, [co]); } catch { /* noop */ } }
    await db.end().catch(() => {});
  });

  it("the permission exists in the catalogue with a human-readable label", async () => {
    const p = await one(`select key, label from permissions where key=$1`, [CAP]);
    expect(p, "a capability the UI names must exist in the catalogue").toBeTruthy();
    expect(String(p.label).length, "an unlabelled permission is unreadable in an admin screen").toBeGreaterThan(5);
  });

  it("exactly the intended roles carry it — no more, no less", async () => {
    const carriers = (await rows(`select role_key from role_permissions where permission_key=$1 order by 1`, [CAP]))
      .map((r: any) => r.role_key);
    // Deliberately exact. A capability that quietly spread to another role is a permission change
    // nobody approved, and this is the assertion that catches it.
    expect(carriers).toEqual(["finance_reviewer", "owner_management", "system_administrator"]);
  });

  it("a member of each carrying role RESOLVES to the capability", async () => {
    for (const role of ["finance_reviewer", "owner_management", "system_administrator"]) {
      const u = await memberWithRole(role);
      const r = await one(`select public.actor_has_capability($1,$2,$3) as ok`, [u, co, CAP]);
      expect(r.ok, `${role} must hold ${CAP}`).toBe(true);
    }
  });

  it("a member of a NON-carrying role does not, and neither does a member whose membership ended", async () => {
    for (const role of ["staff_submitter", "accountant", "payment_initiator", "project_manager"]) {
      const u = await memberWithRole(role);
      const r = await one(`select public.actor_has_capability($1,$2,$3) as ok`, [u, co, CAP]);
      expect(r.ok, `${role} must NOT hold ${CAP}`).toBe(false);
    }
    const ended = await memberWithRole("finance_reviewer", "ended");
    const r = await one(`select public.actor_has_capability($1,$2,$3) as ok`, [ended, co, CAP]);
    expect(r.ok, "an ended membership carries nothing, whatever role it names").toBe(false);
  });

  it("it is scoped to ONE company — the same person holds nothing next door", async () => {
    const other = (await one(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [`of16p other ${SUFFIX}`])).id;
    const u = await memberWithRole("finance_reviewer");
    expect((await one(`select public.actor_has_capability($1,$2,$3) as ok`, [u, co, CAP])).ok).toBe(true);
    expect((await one(`select public.actor_has_capability($1,$2,$3) as ok`, [u, other, CAP])).ok,
      "capability is per company, never global").toBe(false);
    await db.query(`delete from companies where id=$1`, [other]);
  });

  it("the owner can actually GRANT it through the admin surface, not only by hand in SQL", async () => {
    // OF-005 is the standing reminder: a capability nobody can be granted is the same blocker as no
    // capability at all. `finance_reviewer` is the role that carries this one, and the owner's
    // role-assignment RPC must accept it.
    const src = (await one(
      `select pg_get_functiondef(p.oid) as def from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='admin_set_membership_role'`)).def as string;
    expect(src, "admin_set_membership_role must accept finance_reviewer").toMatch(/'finance_reviewer'/);

    // And end to end: assign the role, then the capability resolves.
    const u = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [u]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'of16p granted',true) on conflict do nothing`, [u]);
    const m = await one(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, u]);
    expect((await one(`select public.actor_has_capability($1,$2,$3) as ok`, [u, co, CAP])).ok,
      "before the grant: nothing").toBe(false);
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'finance_reviewer')`, [m.id, co]);
    expect((await one(`select public.actor_has_capability($1,$2,$3) as ok`, [u, co, CAP])).ok,
      "after the grant: the queue is workable").toBe(true);
  });

  it("the two RPCs ask for THIS capability and no other", async () => {
    for (const fn of ["resolve_duplicate_review", "duplicate_review_queue"]) {
      const def = (await one(
        `select pg_get_functiondef(p.oid) as def from pg_proc p
           join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname=$1`, [fn])).def as string;
      const caps = capabilityArgs(def);
      expect(caps.length, `${fn} must perform a capability check at all`).toBeGreaterThan(0);
      expect([...new Set(caps)], `${fn} must gate on exactly ${CAP}`).toEqual([CAP]);
    }
  });
});
