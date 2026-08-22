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

  /**
   * F-01, found by an independent security review and reproduced before being accepted.
   *
   * `SET ROLE` is authorized against `session_user`, not `current_user`. Under the exact PostgREST
   * topology this package is designed around, `session_user` is `authenticator` — a member of
   * `service_role` so PostgREST can serve service-key requests. A caller with arbitrary SQL as
   * `authenticated` therefore does not need to forge anything: ONE statement makes them the service
   * worker. An earlier version of the trust-model document claimed the opposite.
   *
   * This is NOT closed by migration 0084 and cannot be — the mitigation is topological (the service
   * backend must connect as a login role that is not the one serving public API traffic). The
   * assertion below is a DETECTOR: it fails while the topology is unsafe and passes once the owner
   * separates the roles, so it is a real control rather than a note in a document.
   */
  it("TOPOLOGY DETECTOR: no login role in THIS database holds both api and service membership", async () => {
    // Rewritten after security review 2 (G-03). The previous version connected as a role this file
    // creates in beforeAll — with `grant anon, authenticated, service_role` — and then asserted the
    // escalation it had just enabled. It measured its own fixture: the database under test has no
    // `authenticator` role at all, so the owner could separate every role in the deployment and
    // that assertion would still have passed. It also carried a green tick against a title stating
    // the security property while asserting the property was VIOLATED.
    //
    // This one reads the catalog and excludes the roles this file creates, so it is about the
    // database, not about the fixture. Empty is the honest outcome on a disposable test database:
    // it says this database does not exhibit the merged topology. A hosted Supabase project DOES —
    // that is OF-017, and it is a deployment property no migration can change.
    // Roles the INTEGRATION SUITE creates, by the naming conventions its files use. They are
    // cluster-wide and outlive an individual run, so they must be named and excluded — otherwise
    // this test reports its neighbours' fixtures as a deployment finding. Everything else is
    // treated as a real login identity.
    const PROBE = /^(f6|f6x|of014|g01|p)_/;
    const logins = (await db.query(
      `select r.rolname::text as name,
              pg_has_role(r.rolname,'service_role','MEMBER') as svc,
              (pg_has_role(r.rolname,'authenticated','MEMBER')
               or pg_has_role(r.rolname,'anon','MEMBER')) as api
         from pg_roles r
        where r.rolcanlogin and not r.rolsuper
        order by 1`)).rows.filter((r: any) => !PROBE.test(r.name));

    if (logins.length === 0) {
      // The honest outcome on a disposable database: there is no deployment login role here, so
      // OF-017 cannot be measured. Saying that out loud is the point — an empty pass must not read
      // as "production is safe". A hosted Supabase project has `authenticator`, which holds both
      // memberships by design, and no migration can change that.
      expect(logins.map((r: any) => r.name)).toEqual([]);
      return;
    }
    const merged = logins.filter((r: any) => r.svc && r.api).map((r: any) => r.name);
    expect(
      merged,
      `OF-017 topology present: ${merged.join(", ")} can SET ROLE service_role from an api role. ` +
      `Give the service backend its own login identity that serves no public API traffic, and ` +
      `remove service_role membership from the one that does.`,
    ).toEqual([]);
  });

  it("MECHANISM (OF-017): under a merged login role, one SET ROLE buys full service authority", async () => {
    // A DEMONSTRATION, deliberately built on a constructed role, and titled as such. It proves the
    // escalation is real and one statement long — it does NOT claim anything about the deployed
    // topology; the detector above does that. Keeping the two apart is the G-03 correction.
    const c = await connectAs(ROLES.authenticator);
    await c.query("begin");
    try {
      await c.query("set local role authenticated");
      expect((await c.query(`select current_user::text as cu`)).rows[0].cu).toBe("authenticated");
      const before = await c.query(
        `select has_function_privilege(current_user,'public.quotation_status_for_service(uuid,uuid)','EXECUTE') as x`);
      expect(before.rows[0].x, "an api role must not hold the service grant").toBe(false);

      expect(await failed(c, "set role service_role"), "SET ROLE is authorized against session_user").toBe(null);
      expect((await c.query(`select current_user::text as cu`)).rows[0].cu).toBe("service_role");
      const after = await c.query(`select public.quotation_status_for_service($1,$2) as s`, [co, quo]);
      expect(after.rows[0].s).toBe("sent");

      // …and record WHY it is possible, so the reason is in the evidence and not only in prose.
      const m = await c.query(
        `select pg_has_role(session_user,'service_role','MEMBER') as member, session_user::text as su`);
      expect(m.rows[0].member).toBe(true);
      expect(m.rows[0].su).toBe(ROLES.authenticator);
    } finally { await c.query("rollback"); }
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

  // ── the ENFORCEMENT POINT: the freeze trigger, from genuine roles ────────────────────────────
  // F-04: the split's only consumer is `quotation_items_enforce_frozen`, and nothing in this file
  // fired it. A reviewer reintroduced the `CASE` regression the commit message describes at length
  // and this file stayed fully green while two other files went red. These cases close that.
  it("the TRIGGER runs the capability path for a capable member and the service path for the worker", async () => {
    const draft = (await row(`insert into quotations (company_id, quote_number, currency, status, public_token)
                              values ($1,$2,'LKR','draft',$3) returning id`, [co, `Q-trg-${rnd()}`, `tok-${rnd()}`])).id;

    const c = await connectAs(ROLES.authenticator);
    await c.query("begin");
    try {
      await c.query("set local role authenticated");
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: "authenticated", sub: capUser })]);
      // A CASE expression here raised `permission denied for function quotation_status_for_service`
      // for exactly this caller, because PostgreSQL ACL-checks the untaken branch of a planned
      // expression. If that regression returns, this INSERT fails.
      await c.query(`insert into quotation_items (quotation_id, company_id, description, quantity, currency)
                     values ($1,$2,'trigger probe',1,'LKR')`, [draft, co]);
    } finally { await c.query("rollback"); }

    // `SET ROLE service_role` deliberately — exactly what PostgREST does for a service-key request.
    // BYPASSRLS is a role ATTRIBUTE and is NOT inherited through membership, so a role that is
    // merely a member of `service_role` is still subject to RLS until it sets the role.
    const svc = await connectAs(ROLES.svc);
    await svc.query("set role service_role");
    await svc.query(`insert into quotation_items (quotation_id, company_id, description, quantity, currency)
                     values ($1,$2,'service probe',1,'LKR')`, [draft, co]);
    await db.query(`delete from quotation_items where quotation_id=$1`, [draft]);
    await db.query(`delete from quotations where id=$1`, [draft]);
  });

  it("the TRIGGER fails CLOSED for a caller holding neither the capability nor the grant", async () => {
    const draft = (await row(`insert into quotations (company_id, quote_number, currency, status, public_token)
                              values ($1,$2,'LKR','draft',$3) returning id`, [co, `Q-fc-${rnd()}`, `tok-${rnd()}`])).id;
    const item = (await row(`insert into quotation_items (quotation_id, company_id, description, quantity, currency)
                             values ($1,$2,'x',1,'LKR') returning id`, [draft, co])).id;

    // A role that INHERITS `authenticated` — so it can execute the capability path and reach the
    // guard's own RAISE — and BYPASSRLS so it can see the row at all. Without both, the statement
    // dies in the ACL or matches zero rows, and the fail-closed branch is never exercised. That is
    // exactly how the sibling wp12 assertion was passing for the wrong reason (F-05).
    const probe = `f6_nocap_${SUFFIX}`;
    await db.query(`drop role if exists ${probe}`);
    await db.query(`create role ${probe} login password 'probe' bypassrls`);
    await db.query(`grant authenticated to ${probe}`);
    const c = await connectAs(probe);
    await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);  // forged, and useless
    const e = await failed(c, `update quotation_items set description='y' where id=$1`, [item]);
    expect(e).toBeTruthy();
    expect(e.code).toBe("42501");
    expect(e.message).toMatch(/holds neither sales\.quotation\.manage/);

    await c.end().catch(() => {});
    await db.query(`delete from quotation_items where quotation_id=$1`, [draft]);
    await db.query(`delete from quotations where id=$1`, [draft]);
    await db.query(`drop role if exists ${probe}`);
  });

  // ── the systemic invariant ──────────────────────────────────────────────────────────────────
  it("only TWO api-reachable SECURITY DEFINER functions may consult caller_jwt_role at all", async () => {
    // REACHABILITY, not syntax (F-02). The earlier version matched one textual form — the shape that
    // happened to exist in the function being removed — and a reviewer showed a bare
    // `if caller_jwt_role() = 'service_role' then ...` sailed straight past it. Both allowed entries
    // use the claim RESTRICTIVELY (it can only tighten), which is why they are allowed; anything
    // else, in any syntax, fails here and fails migration 0085's own assertion.
    const found = (await db.query(
      `select replace(p.oid::regprocedure::text,'public.','') as sig
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prosecdef
          and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))
          and p.prosrc like '%caller_jwt_role%'
        order by 1`)).rows;
    expect(found.map((r: any) => r.sig).sort()).toEqual([
      "decide_approval(uuid,uuid,text,text)",
      "route_task_as_human(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid)",
    ].sort());
  });

  // ── G-02: the gate above cannot see the class that mattered ─────────────────────────────────
  it("every api-reachable definer function that can REACH claim text is on the reviewed allowlist", async () => {
    // Security review 2 broke the gate above three ways: a function can read the GUC directly
    // (`current_setting('request.jwt.claims')`) without naming the helper; it can assemble the
    // helper's name in dynamic SQL; and — the one that actually mattered — the claim reader can be
    // a SECURITY INVOKER function, which is outside the `prosecdef` population entirely no matter
    // how the text predicate is widened. `_resolve_actor` was exactly that: invoker, unnamed by its
    // nine definer callers, and converting `role=service_role` into a skipped capability check.
    //
    // So this asserts over the CALL GRAPH instead of over source text. It does NOT claim the listed
    // functions use claims safely — several legitimately derive IDENTITY from `sub`. It guarantees
    // the set cannot GROW silently: a new api-reachable definer function that can reach claim text
    // fails here until someone adds it deliberately. Mirrors migration 0086's assertion exactly.
    const found = (await db.query(
      `with recursive
         seed as (
           select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public','auth')
              and (p.prosrc like '%request.jwt%' or p.prosrc like '%current_setting%')),
         edges as (
           select c.oid as caller, e.oid as callee
             from pg_proc c
             join pg_namespace cn on cn.oid = c.pronamespace and cn.nspname='public'
             join pg_proc e on e.oid <> c.oid
             join pg_namespace en on en.oid = e.pronamespace and en.nspname in ('public','auth')
            where c.prosrc ~ ('(^|[^a-zA-Z0-9_])' || e.proname || '[[:space:]]*\\(')),
         closure as (
           select oid from seed
           union
           select ed.caller from edges ed join closure cl on cl.oid = ed.callee)
       select replace(p.oid::regprocedure::text,'public.','') as sig
         from closure c join pg_proc p on p.oid = c.oid
         join pg_namespace n on n.oid = p.pronamespace and n.nspname='public'
        where p.prosecdef
          and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))
        order by 1`)).rows.map((r: any) => r.sig);

    expect(found.sort()).toEqual([
      // RLS/identity helpers — derive WHO the caller is from `sub`; they grant no authority.
      "authority_ceiling(uuid,text)",
      "decide_approval(uuid,uuid,text,text)",
      "decide_supplier_bank_change(uuid,uuid,text,uuid,text)",
      // OF-016 (migration 0087). Both reach claim text only to learn WHO the caller is —
      // `auth.uid()` for the acting human, then `actor_has_capability` for what that human may do.
      // Neither branches on the claimed ROLE, and `resolve_duplicate_review` is granted to
      // `authenticated` alone, so a forged `service_role` claim cannot reach either one.
      "duplicate_review_queue(uuid)",
      "has_capability(uuid,text)",
      "has_company_access(uuid)",
      "has_membership(uuid)",
      "has_permission(uuid,text)",
      "is_admin()",
      "my_company()",
      "my_department()",
      "post_customer_invoice(uuid,uuid,text,text,uuid,date,text)",
      "post_manual_journal(uuid,date,text,text,uuid,jsonb,text)",
      "post_supplier_bill(uuid,uuid,text,text,uuid,date,text)",
      "quotation_status_for_capable(uuid,uuid)",
      "reimburse_expense_claim(uuid,uuid,text,text,uuid,date,text)",
      "request_supplier_bank_change(uuid,uuid,text,text,uuid)",
      "resolve_duplicate_review(uuid,text,text)",
      "reverse_journal(uuid,uuid,uuid,date,text)",
      "route_task_as_human(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid)",
      "settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date,text)",
      "settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date,text)",
      "within_authority(uuid,text,numeric,text)",
      "within_authority_for_event(uuid,uuid)",
    ].sort());
  });

  // ── G-06b: the allowlist is signature-exact but body-blind, so assert BEHAVIOUR ──────────────
  it("the two allowlisted claim readers use the claim RESTRICTIVELY — proven by execution", async () => {
    const c = await connectAs(ROLES.auth);
    // route_task_as_human REFUSES a service context outright. Forging it makes the function refuse,
    // which is the safe direction — but nothing tested that until now, so a permissive rewrite of
    // either function would have passed the membership assertion above.
    await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    const routed = await failed(c,
      `select public.route_task_as_human($1,$2,'t','d','open','{}'::jsonb,null,'x',null,null)`, [co, co]);
    expect(routed?.message, "route_task_as_human must refuse a service context").toMatch(/service context|human/i);

    // decide_approval requires a real authenticated subject; a forged role does not remove that.
    const decided = await failed(c, `select public.decide_approval($1,$2,'approved','x')`, [co, co]);
    expect(decided?.message, "decide_approval must require an authenticated user").toMatch(/authenticated user/i);
  });

  // ── G-01 (P0): the defect the systemic invariant above exists to catch ──────────────────────
  it("G-01: a forged service_role claim cannot post a material journal — genuine unprivileged role", async () => {
    // This is the exploit security review 2 found, re-run from a REAL login role that is a member
    // of `authenticated` and nothing else. No SET ROLE, nothing forged but one GUC. Before
    // migration 0086 it posted a 999,999 journal with no capability and no human actor, because
    // `_resolve_actor` turned `role=service_role` into actor_type='system' and every one of the
    // nine finance RPCs gated its capability check on that value.
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await c.query("set local role authenticated");
      const who = await c.query(
        `select current_user::text as cu,
                pg_has_role(current_user,'service_role','MEMBER') as cu_svc,
                pg_has_role(session_user,'service_role','MEMBER') as su_svc`);
      // Establishes this is NOT OF-017: neither the api role nor the login role can reach service.
      expect([who.rows[0].cu, who.rows[0].cu_svc, who.rows[0].su_svc]).toEqual(["authenticated", false, false]);

      const lines = JSON.stringify([
        { account_code: "1000", debit: "999999", credit: "0", description: "x" },
        { account_code: "4000", debit: "0", credit: "999999", description: "x" },
      ]);
      await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',true)`);
      await c.query("savepoint a");
      const e = await failed(c,
        `select public.post_manual_journal($1::uuid,'2026-08-19','LKR','G-01',null,$2::jsonb,'g01') as id`,
        [co, lines]);
      await c.query("rollback to savepoint a");
      expect(e?.message, "a forged claim must buy nothing").toMatch(/without a subject/i);

      // …and with a subject it falls through to a REAL capability check rather than a free pass.
      await c.query(`select set_config('request.jwt.claims',$1,true)`,
        [JSON.stringify({ role: "service_role", sub: randomUUID() })]);
      await c.query("savepoint b");
      const e2 = await failed(c,
        `select public.post_manual_journal($1::uuid,'2026-08-19','LKR','G-01b',null,$2::jsonb,'g01b') as id`,
        [co, lines]);
      await c.query("rollback to savepoint b");
      expect(e2?.message, "the capability check must run for every caller").toMatch(/missing capability finance\.journal\.post/i);
    } finally { await c.query("rollback"); }
  });

  it("G-01: the maker-checker cannot be defeated by claiming to be the system", async () => {
    // The system path set v_actor := NULL, and `v_requested_by = v_actor` is never true against
    // NULL, so one unprivileged caller could both request and approve a supplier bank-detail
    // change. There is no NULL actor any more.
    const c = await connectAs(ROLES.auth);
    await c.query("begin");
    try {
      await c.query("set local role authenticated");
      await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',true)`);
      const e = await failed(c,
        `select public.decide_supplier_bank_change($1::uuid,$2::uuid,'approved',null,'x')`, [co, randomUUID()]);
      expect(e?.message).toMatch(/without a subject/i);
    } finally { await c.query("rollback"); }
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
