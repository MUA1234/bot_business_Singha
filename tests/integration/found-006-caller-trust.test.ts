/**
 * FOUND-006 — a caller's database PRIVILEGE decides service authority, never its request text.
 *
 * Every probe here runs from a GENUINE login role, not from the suite's superuser connection with
 * `SET ROLE`. That distinction is the whole point: `pg_has_role(session_user, …)` and
 * `current_user` inside a SECURITY DEFINER body both give the wrong answer, and a test that probes
 * as itself cannot tell. Two earlier assertions in this repository were satisfied by the wrong
 * mechanism for exactly that reason.
 *
 * Roles created here mirror the real Supabase topology:
 *   f6_authenticator  — noinherit, member of anon/authenticated/service_role (what PostgREST logs in as)
 *   f6_auth           — member of `authenticated` only
 *   f6_anon           — member of `anon` only
 *   f6_svc            — member of `service_role` only
 *   f6_custom         — a bespoke role, member of nothing
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
let co: string, capUser: string, quo: string;
const SUFFIX = rnd();
const ROLES = {
  authenticator: `f6_authenticator_${SUFFIX}`,
  auth: `f6_auth_${SUFFIX}`,
  anon: `f6_anon_${SUFFIX}`,
  svc: `f6_svc_${SUFFIX}`,
  custom: `f6_custom_${SUFFIX}`,
};
const conns: any[] = [];

const row = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows[0];

/** A client logged in AS a real role. */
async function connectAs(role: string) {
  const { default: pg } = await import("pg" as string);
  const c = new pg.Client({ connectionString: URL.replace(/\/\/[^@]*@/, `//${role}:probe@`), ssl: mkSsl(URL) });
  await c.connect();
  conns.push(c);
  return c;
}
const failed = async (c: any, sql: string, p: any[] = []) =>
  c.query(sql, p).then(() => null).catch((e: any) => e);

describe.skipIf(!enabled)("FOUND-006 — privilege decides, request text does not", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);

    for (const [kind, name] of Object.entries(ROLES)) {
      await db.query(`drop role if exists ${name}`);
      await db.query(`create role ${name} login password 'probe' ${kind === "authenticator" ? "noinherit" : ""}`);
    }
    await db.query(`grant anon, authenticated, service_role to ${ROLES.authenticator}`);
    await db.query(`grant authenticated to ${ROLES.auth}`);
    await db.query(`grant anon to ${ROLES.anon}`);
    await db.query(`grant service_role to ${ROLES.svc}`);
    await db.query(`grant usage on schema public to ${ROLES.custom}`);

    co = (await row(`insert into companies (name, base_currency) values ('f6 co','LKR') returning id`)).id;
    capUser = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [capUser]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'f6 capable',true) on conflict do nothing`, [capUser]);
    const m = (await row(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, capUser])).id;
    await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [m, co]);
    quo = (await row(`insert into quotations (company_id, quote_number, currency, status, public_token)
                      values ($1,$2,'LKR','sent',$3) returning id`, [co, `Q-f6-${rnd()}`, `tok-${rnd()}`])).id;
  });

  afterAll(async () => {
    for (const c of conns) await c.end().catch(() => {});
    for (const sql of [
      `delete from quotations where company_id=$1`,
      `delete from membership_roles where company_id=$1`,
      `delete from memberships where company_id=$1`,
      `delete from companies where id=$1`,
    ]) { try { await db.query(sql, [co]); } catch { /* noop */ } }
    try { await db.query(`delete from users where id=$1`, [capUser]); } catch { /* noop */ }
    for (const name of Object.values(ROLES)) {
      try { await db.query(`revoke usage on schema public from ${name}`); } catch { /* noop */ }
      try { await db.query(`drop role if exists ${name}`); } catch { /* noop */ }
    }
    await db?.end().catch(() => {});
  });

  // ── the primitives, measured rather than assumed ────────────────────────────────────────────
  it("session_user is `authenticator` for BOTH an authenticated and a service request", async () => {
    const c = await connectAs(ROLES.authenticator);
    const seen: Record<string, { cu: string; su: string }> = {};
    for (const role of ["authenticated", "service_role"]) {
      await c.query("begin");
      await c.query(`set local role ${role}`);
      const r = (await c.query(`select current_user::text as cu, session_user::text as su`)).rows[0];
      seen[role] = { cu: r.cu, su: r.su };
      await c.query("rollback");
    }
    // This is why `session_user` cannot identify an API caller, and why `pg_has_role(session_user,
    // 'service_role','MEMBER')` would have been TRUE for every ordinary web request.
    expect(seen.authenticated!.su).toBe(ROLES.authenticator);
    expect(seen.service_role!.su).toBe(ROLES.authenticator);
    expect(seen.authenticated!.cu).toBe("authenticated");
    expect(seen.service_role!.cu).toBe("service_role");
    expect((await c.query(
      `select pg_has_role($1,'service_role','MEMBER') as m`, [ROLES.authenticator])).rows[0].m).toBe(true);
  });

  // ── forged claims buy nothing ───────────────────────────────────────────────────────────────
  it("an AUTHENTICATED role forging `role: service_role` reaches no service-only RPC", async () => {
    const c = await connectAs(ROLES.auth);
    await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    for (const call of [
      `select * from public.inbound_dispatch_health()`,
      `select * from public.claim_source_events(1,'x',60)`,
      `select * from public.record_inbound_receipt('whatsapp','a','m','{}'::jsonb,'h','c','inbound_message')`,
      `select * from public.admin_set_membership_role($1,$1,'finance_reviewer',true,$1)`,
      `select * from public.settle_processed_source_event($1)`,
      `select * from public.inbound_reviewer_user_ids($1)`,
      `select public.quotation_status_for_service($1,$1)`,
      `select public.caller_jwt_role()`,
    ]) {
      const e = await failed(c, call, call.includes("$1") ? [randomUUID()] : []);
      expect(e, call).toBeTruthy();
      expect(e.code, `${call} → ${e?.message}`).toBe("42501");
    }
    // …and it cannot escalate by role either.
    expect((await failed(c, `set role service_role`))?.code).toBe("42501");
  });

  it("an AUTHENTICATED role forging `sub` changes auth.uid() — the DOCUMENTED shared-role limit", async () => {
    const c = await connectAs(ROLES.auth);
    const victim = randomUUID();
    await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: "authenticated", sub: victim })]);
    // This is NOT fixed by FOUND-006 and must not be claimed to be. Whoever can run arbitrary SQL as
    // the shared `authenticated` role controls end-user identity, and therefore every RLS policy.
    // It is out of the supported client boundary; closing it needs per-user database identity or
    // cryptographically verified claims.
    expect((await c.query(`select auth.uid() as u`)).rows[0].u).toBe(victim);
  });

  it("a SERVICE_ROLE session whose JWT text says `authenticated` KEEPS service access", async () => {
    const c = await connectAs(ROLES.svc);
    await c.query(`select set_config('request.jwt.claims','{"role":"authenticated"}',false)`);
    // The grant is authoritative. The status read has no claim branch left, so downgraded request
    // text cannot take service access away.
    const r = await c.query(`select public.quotation_status_for_service($1,$2) as s`, [co, quo]);
    expect(r.rows[0].s).toBe("sent");
  });

  it("a SERVICE_ROLE session with NO claims at all still holds its grant", async () => {
    const c = await connectAs(ROLES.svc);
    expect((await c.query(`select public.quotation_status_for_service($1,$2) as s`, [co, quo])).rows[0].s).toBe("sent");
  });

  // ── the quotation status split ──────────────────────────────────────────────────────────────
  it("the claim-branch function is GONE, and the shared implementation is reachable by no api role", async () => {
    expect(await row(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='_quotation_status_for_guard'`)).toEqual({ n: 0 });
    const shared = await row(
      `select has_function_privilege('anon','public._quotation_status_read(uuid,uuid)','EXECUTE') as a,
              has_function_privilege('authenticated','public._quotation_status_read(uuid,uuid)','EXECUTE') as b,
              has_function_privilege('service_role','public._quotation_status_read(uuid,uuid)','EXECUTE') as c`);
    expect([shared.a, shared.b, shared.c]).toEqual([false, false, false]);
  });

  it("each half is granted to exactly one api role", async () => {
    const g = await row(
      `select has_function_privilege('anon','public.quotation_status_for_capable(uuid,uuid)','EXECUTE') as cap_anon,
              has_function_privilege('authenticated','public.quotation_status_for_capable(uuid,uuid)','EXECUTE') as cap_auth,
              has_function_privilege('service_role','public.quotation_status_for_capable(uuid,uuid)','EXECUTE') as cap_svc,
              has_function_privilege('anon','public.quotation_status_for_service(uuid,uuid)','EXECUTE') as svc_anon,
              has_function_privilege('authenticated','public.quotation_status_for_service(uuid,uuid)','EXECUTE') as svc_auth,
              has_function_privilege('service_role','public.quotation_status_for_service(uuid,uuid)','EXECUTE') as svc_svc`);
    expect([g.cap_anon, g.cap_auth, g.cap_svc]).toEqual([false, true, false]);
    expect([g.svc_anon, g.svc_auth, g.svc_svc]).toEqual([false, false, true]);
  });

  it("the CAPABILITY path returns a status to a capable member and nothing to anyone else", async () => {
    const c = await connectAs(ROLES.authenticator);
    const ask = async (sub: string | null) => {
      await c.query("begin");
      try {
        await c.query("set local role authenticated");
        await c.query(`select set_config('request.jwt.claims', $1, true)`,
          [JSON.stringify(sub ? { role: "authenticated", sub } : { role: "authenticated" })]);
        return (await c.query(`select public.quotation_status_for_capable($1,$2) as s`, [co, quo])).rows[0].s;
      } finally { await c.query("rollback"); }
    };
    expect(await ask(capUser)).toBe("sent");
    expect(await ask(randomUUID())).toBeNull();   // a real session, no capability → nothing
    expect(await ask(null)).toBeNull();
  });

  it("ANON and a BESPOKE role reach neither half", async () => {
    for (const role of [ROLES.anon, ROLES.custom]) {
      const c = await connectAs(role);
      await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
      for (const fn of ["quotation_status_for_capable", "quotation_status_for_service"]) {
        const e = await failed(c, `select public.${fn}($1,$2)`, [co, quo]);
        expect(e, `${role}/${fn}`).toBeTruthy();
        expect(e.code).toBe("42501");
      }
    }
  });

  // ── the systemic invariant ──────────────────────────────────────────────────────────────────
  it("NO api-reachable SECURITY DEFINER function converts a JWT claim into service authority", async () => {
    const bad = (await db.query(
      `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prosecdef
          and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))
          and p.prosrc ~ 'or\\s+public\\.caller_jwt_role\\(\\)\\s*=\\s*''service_role'''`)).rows;
    expect(bad.map((r: any) => r.sig)).toEqual([]);
  });

  it("internal helpers are no longer executable by an api role", async () => {
    for (const sig of ["public.caller_jwt_role()", "public._resolve_actor(uuid)"]) {
      const g = await row(
        `select has_function_privilege('anon',$1,'EXECUTE') as a,
                has_function_privilege('authenticated',$1,'EXECUTE') as b`, [sig]);
      expect([g.a, g.b], sig).toEqual([false, false]);
    }
  });

  it("every function this migration touched keeps a pinned search_path", async () => {
    const fns = ["_quotation_status_read", "quotation_status_for_capable",
                 "quotation_status_for_service", "quotation_items_enforce_frozen"];
    for (const name of fns) {
      const r = await row(
        `select coalesce(array_to_string(p.proconfig,','),'(none)') as cfg
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname=$1`, [name]);
      expect(r.cfg, name).toBe("search_path=pg_catalog, extensions, public, pg_temp");
    }
  });

  it("a pg_temp relation cannot shadow the tables these functions read", async () => {
    const c = await connectAs(ROLES.svc);
    // A caller with default TEMP could create `pg_temp.quotations`; pinned search_path puts pg_temp
    // LAST, so the real table still wins.
    await c.query(`create temp table quotations (id uuid, company_id uuid, status text)`).catch(() => {});
    await c.query(`insert into pg_temp.quotations values ($1,$2,'draft')`, [quo, co]).catch(() => {});
    const r = await c.query(`select public.quotation_status_for_service($1,$2) as s`, [co, quo]);
    expect(r.rows[0].s).toBe("sent");   // the REAL status, not the shadowed one
  });
});
