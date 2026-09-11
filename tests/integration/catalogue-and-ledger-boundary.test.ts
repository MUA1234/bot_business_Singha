/**
 * The question no other gate asked: WHICH TABLES HAVE NO RLS AT ALL?
 *
 * Every RLS gate in this repository looks at tables that are already inside some protected
 * population, and each of them defines that population in a way that silently excluded four
 * tables:
 *
 *   * `rls-coverage` / `rls-matrix-coverage` enumerate tables WITH a `company_id`. `roles`,
 *     `permissions`, `role_permissions` and `schema_migrations` are global and have none.
 *   * `f004-bounded-text` and the write-policy matrix select tables that HAVE a write policy. A
 *     table with no policy at all never appears in their subquery — so "RLS off, no policy" reads
 *     to those gates as "not user-writable", which is exactly backwards.
 *   * The SECURITY DEFINER allowlists govern functions. This attack needs no function.
 *
 * Every gate assumed a table was protected by RLS. None asked which tables were not.
 *
 * ── What was open ───────────────────────────────────────────────────────────────────────────
 *
 * All four held `INSERT, UPDATE, DELETE` for `authenticated` from Supabase's default privileges,
 * with RLS disabled and no policy behind the grant. Against the hard-scenario stack — real GoTrue,
 * real PostgREST — a genuine token for the LOWEST-privilege fixture user did this:
 *
 *     POST /rest/v1/role_permissions
 *     {"role_key":"staff_submitter","permission_key":"admin.organisation.manage"}   → 201
 *
 * and `actor_has_capability(user, company, 'admin.organisation.manage')` then returned TRUE for
 * every staff member in BOTH fixture companies. The capability engine joins `membership_roles` to
 * `role_permissions` and asks whether a row exists; the attacker supplied the row. There is no
 * second check to fail.
 *
 * The same token inserted a `schema_migrations` row for a version that had never run. The runner
 * keys on the four-digit prefix and skips a recorded version SILENTLY, so a client could make any
 * future migration never happen, with no error anywhere.
 *
 * Closed by migration 0145. These tests keep it closed, and — more importantly — make the general
 * question part of the suite, so the NEXT global table cannot arrive with the same default grants.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

/**
 * Tables that may sit in `public` with RLS disabled, each with the reason.
 *
 * An entry is a claim that no client role can WRITE the table — checked independently below, so
 * an entry here excuses the missing RLS and never the missing revoke.
 */
const NO_RLS_OK = new Map<string, string>([
  ["schema_migrations", "the migration ledger: no client role holds any privilege on it at all (0145). RLS is deliberately NOT enabled — a runner connecting as a non-owner would be refused by a table with RLS on and no policy, breaking migrations everywhere."],
]);

describe.skipIf(!enabled)("global tables: the catalogue and the ledger are not client-writable", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
  });
  afterAll(async () => { if (client) await client.end().catch(() => {}); });

  it("NO table in public is writable by a client role without RLS standing behind the grant", async () => {
    // The general form. Not a list of four names — a question asked of every table, so the next
    // global reference table cannot ship with Supabase's default grants and no policy.
    const { rows } = await client.query(`
      select cl.relname as t,
             (select count(*) from pg_policy p where p.polrelid = cl.oid)::int as policies
        from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
       where n.nspname = 'public' and cl.relkind = 'r'
         and not cl.relrowsecurity
         and (has_table_privilege('authenticated', cl.oid, 'INSERT')
           or has_table_privilege('authenticated', cl.oid, 'UPDATE')
           or has_table_privilege('authenticated', cl.oid, 'DELETE')
           or has_table_privilege('anon', cl.oid, 'INSERT')
           or has_table_privilege('anon', cl.oid, 'UPDATE')
           or has_table_privilege('anon', cl.oid, 'DELETE'))
       order by 1`);
    const unprotected = rows.map((r: { t: string }) => r.t).filter((t: string) => !NO_RLS_OK.has(t));
    expect(
      unprotected,
      "these tables have RLS disabled AND a client write grant, so nothing refuses the write: " +
        `${unprotected.join(", ")}. Revoke the grant, or enable RLS with a policy that means it.`,
    ).toEqual([]);
  });

  it("an allowlisted RLS-free table is genuinely unreachable, not merely excused", async () => {
    for (const t of NO_RLS_OK.keys()) {
      const { rows } = await client.query(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema='public' and table_name=$1 and grantee in ('anon','authenticated','PUBLIC')`, [t]);
      expect(
        rows.map((r: { grantee: string; privilege_type: string }) => `${r.grantee}:${r.privilege_type}`),
        `${t} is allowlisted as RLS-free but a client role still holds privileges on it`,
      ).toEqual([]);
    }
  });

  it("writing the capability catalogue IS granting capability, so no client may write it", async () => {
    // Stated as the consequence rather than as a grant table, because the grant table is what
    // everyone read past. `actor_has_capability` joins membership_roles to role_permissions and
    // asks whether a row exists. Whoever can insert that row can grant any capability.
    for (const t of ["roles", "permissions", "role_permissions"]) {
      const { rows } = await client.query(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema='public' and table_name=$1
            and grantee in ('anon','authenticated','PUBLIC')
            and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`, [t]);
      expect(
        rows.map((r: { grantee: string; privilege_type: string }) => `${r.grantee}:${r.privilege_type}`),
        `${t} is writable by a client role — that is a direct grant of arbitrary capability`,
      ).toEqual([]);
    }
  });

  it("the capability catalogue is still READABLE, or every authorisation check fails closed", async () => {
    // The other direction, and not a formality: a hardening migration that took SELECT away would
    // make has_capability() return false for everyone and nobody could do anything. That failure
    // is safe in the security sense and catastrophic in every other sense.
    for (const t of ["roles", "permissions", "role_permissions"]) {
      const { rows } = await client.query(
        `select has_table_privilege('authenticated', $1::regclass, 'SELECT') as ok`, [`public.${t}`]);
      expect(rows[0].ok, `authenticated cannot read ${t}; every capability check will fail closed`).toBe(true);
    }
  });

  it("the escalation is refused when actually attempted as authenticated", async () => {
    // The grant tables say what is permitted. This says what HAPPENS — the same insert that
    // returned 201 through PostgREST before 0145.
    await client.query("begin");
    try {
      await client.query("set local role authenticated");
      await client.query(`select set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000aa"}', true)`);

      /*
       * A savepoint per attempt. Without one, the first refusal aborts the transaction and the
       * SECOND attempt fails with 25P02 (in_failed_sql_transaction) — a refusal that proves
       * nothing about the ledger, because it would look identical if the grant were still there.
       */
      const attempt = async (sql: string): Promise<{ succeeded: boolean; code?: string }> => {
        await client.query("savepoint a");
        try {
          await client.query(sql);
          await client.query("release savepoint a");
          return { succeeded: true };
        } catch (e) {
          await client.query("rollback to savepoint a");
          return { succeeded: false, code: (e as { code?: string }).code };
        }
      };

      const escalate = await attempt(
        `insert into role_permissions (role_key, permission_key)
         select r.key, p.key from roles r cross join permissions p limit 1`);
      expect(escalate.succeeded, "an authenticated caller granted a role a permission").toBe(false);
      expect(escalate.code, "the refusal should be a privilege error, not a constraint accident").toBe("42501");

      const forge = await attempt(
        `insert into schema_migrations (version, filename) values ('9999','never_ran.sql')`);
      expect(forge.succeeded, "an authenticated caller forged a migration ledger row").toBe(false);
      expect(forge.code, "the refusal should be a privilege error, not a constraint accident").toBe("42501");
    } finally {
      await client.query("rollback");
    }
  });
});
