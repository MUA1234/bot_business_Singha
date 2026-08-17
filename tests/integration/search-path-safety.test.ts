/**
 * NINTH review, Correction 1 — the PERMANENT search_path safety gate + cross-domain pg_temp adversarial
 * proofs (migration 0067). Live Postgres, REAL roles.
 *
 * Gate: every application-owned SECURITY DEFINER function and every trigger function in `public` (excluding
 * extension-owned) MUST pin `search_path` with `pg_temp` LAST and no `$user`. This fails the build the
 * moment a future such function is added with an unsafe path.
 *
 * Adversarial: with the default (PUBLIC) TEMP privilege, a caller creates temp tables that shadow
 * high-risk relations across domains (identity/RLS, approvals, finance, WP12). The hardened functions must
 * ignore the shadows (they resolve `public.*` before `pg_temp`), so capability/company identity cannot be
 * fabricated, an approval cannot be forced, and a SECURITY DEFINER function cannot be redirected to a
 * temporary relation. Legitimate paths still work.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 12);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, capUser: string, customRole: string;
const NONMEMBER = randomUUID();

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
// Run under a role with hostile temp shadows planted first; always recovers the tx via the savepoint.
async function withShadows(role: "auth" | "service", jwtSub: string | null, shadows: string[], probe: string, params: unknown[] = []): Promise<{ ok: boolean; code?: string; val?: unknown }> {
  await client.query("savepoint sh");
  try {
    if (role === "auth") {
      await client.query("set local role authenticated");
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(jwtSub ? { sub: jwtSub, role: "authenticated" } : { role: "authenticated" })]);
    } else {
      await client.query("set local role service_role");
      await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    }
    for (const s of shadows) await client.query(s);
    const r = await client.query(probe, params);
    await client.query("reset role");
    await client.query("rollback to savepoint sh"); // drop temp tables + role
    return { ok: true, val: r.rows[0] ? Object.values(r.rows[0])[0] : undefined };
  } catch (e) {
    await client.query("rollback to savepoint sh");
    return { ok: false, code: (e as { code?: string }).code };
  }
}

describe.skipIf(!enabled)("0067 search_path safety gate + cross-domain pg_temp adversarial (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    co = (await client.query(`insert into companies (name, base_currency) values ('spsafe','LKR') returning id`)).rows[0].id;
    capUser = randomUUID();
    await client.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [capUser]);
    await client.query(`insert into users (id, full_name, is_active) values ($1,'cap',true)`, [capUser]);
    await client.query(`insert into profiles (id, company_id, username, department, is_admin, is_active) values ($1,$2,$3,'sales',false,true)`, [capUser, co, "cap_" + capUser.slice(0, 8)]);
    const mem = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, capUser])).rows[0].id;
    await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [mem, co]);
    customRole = "cust_" + rnd();
    await client.query(`create role ${customRole} nologin`);
    await client.query(`grant authenticated to ${customRole}`);
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  // The gate's population + predicate, shared by the gate itself and the adversarial gate tests below.
  // OWNER-AGNOSTIC (no proowner filter): a SECURITY DEFINER / trigger function created by ANY role in
  // `public` (except extension-owned) is in scope — an owner-scoped predicate would silently ignore
  // functions applied out-of-band under a different owner, exactly the blind spot 0067's self-verify
  // closes fail-closed.
  const GATE_SQL = `
    select p.oid::regprocedure::text as sig,
           (select c from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%') as sp
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public'
      and (p.prosecdef or p.prorettype='pg_catalog.trigger'::regtype)
      and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
    order by 1`;
  // Unsafe = no search_path, `$user` present, or the FIRST occurrence of pg_temp not being the FINAL
  // element (resolution uses the FIRST occurrence, so `pg_temp, …, pg_temp` is unsafe despite ending
  // in pg_temp — a last-element-only check would miss it).
  const isUnsafe = (sp: string | null): boolean => {
    if (!sp) return true;
    if (/\$user/.test(sp)) return true;
    const list = sp.replace(/^search_path=/, "").split(",").map((s) => s.trim());
    return list.indexOf("pg_temp") !== list.length - 1;
  };

  // ── the permanent gate ──
  it("GATE: every non-extension SECURITY DEFINER / trigger function in public (ANY owner) pins pg_temp last-and-only-last with no $user", async () => {
    const rows = (await q(GATE_SQL)).rows as Array<{ sig: string; sp: string | null }>;
    expect(rows.length).toBeGreaterThan(30); // sanity: the audit actually found the functions
    const unsafe = rows.filter((r) => isUnsafe(r.sp));
    expect(unsafe.map((r) => r.sig), `unsafe search_path on: ${unsafe.map((r) => r.sig).join(", ")}`).toEqual([]);
  });

  it("GATE catches a foreign-owned unsafe function (the owner-filter blind spot is closed)", async () => {
    await client.query("savepoint fo");
    try {
      const foreignOwner = "fo_" + rnd();
      await client.query(`create role ${foreignOwner} nologin`);
      await client.query(`create function public.__gate_probe_foreign() returns int language sql security definer set search_path = public as 'select 1'`);
      await client.query(`alter function public.__gate_probe_foreign() owner to ${foreignOwner}`);
      const rows = (await client.query(GATE_SQL)).rows as Array<{ sig: string; sp: string | null }>;
      const probe = rows.find((r) => r.sig.includes("__gate_probe_foreign"));
      expect(probe, "gate population must include the foreign-owned function").toBeDefined();
      expect(isUnsafe(probe!.sp)).toBe(true); // and classify it unsafe
    } finally {
      await client.query("rollback to savepoint fo"); // drops the role + function
    }
  });

  it("GATE catches a duplicated pg_temp path (`pg_temp, …, pg_temp` is unsafe despite its last element)", async () => {
    await client.query("savepoint dup");
    try {
      await client.query(`create function public.__gate_probe_dup() returns int language sql security definer set search_path = pg_temp, pg_catalog, public, pg_temp as 'select 1'`);
      const rows = (await client.query(GATE_SQL)).rows as Array<{ sig: string; sp: string | null }>;
      const probe = rows.find((r) => r.sig.includes("__gate_probe_dup"));
      expect(probe).toBeDefined();
      expect(isUnsafe(probe!.sp)).toBe(true); // first occurrence of pg_temp is NOT the last element
      // and the migration's canonical safe path stays safe under the same predicate
      expect(isUnsafe("search_path=pg_catalog, extensions, public, pg_temp")).toBe(false);
    } finally {
      await client.query("rollback to savepoint dup");
    }
  });

  // ── identity / RLS: capability + company cannot be fabricated by shadowing memberships/profiles ──
  it("has_capability cannot be forged via temp memberships/membership_roles/role_permissions", async () => {
    // A non-member authenticated user plants temp rows that would grant themselves the capability.
    const shadows = [
      `create temp table memberships (id uuid, company_id uuid, user_id uuid, status text)`,
      `insert into memberships values (gen_random_uuid(), '${co}', '${NONMEMBER}', 'active')`,
      `create temp table role_permissions (role_key text, permission_key text)`,
      `insert into role_permissions values ('owner_management','sales.quotation.manage')`,
    ];
    const r = await withShadows("auth", NONMEMBER, shadows, `select public.has_capability($1,'sales.quotation.manage') as v`, [co]);
    expect(r.ok, String(r.code)).toBe(true);
    expect(r.val).toBe(false); // real (empty) membership wins; the shadow is ignored
  });

  it("my_company / is_admin cannot be forged via a temp profiles shadow", async () => {
    const shadows = [
      `create temp table profiles (id uuid, company_id uuid, is_admin boolean, is_active boolean, department text)`,
      `insert into profiles values ('${NONMEMBER}', '${co}', true, true, 'finance')`,
    ];
    const mc = await withShadows("auth", NONMEMBER, shadows, `select public.my_company() as v`);
    expect(mc.val ?? null).toBeNull(); // no real profiles row for a non-member → null, not the shadow's company
    const adm = await withShadows("auth", NONMEMBER, shadows, `select public.is_admin() as v`);
    expect(adm.val).toBe(false);
  });

  // ── approvals: decide_approval cannot be forced via a temp approval_requests shadow ──
  it("decide_approval cannot be forced by shadowing approval_requests (no fabricated approval)", async () => {
    const fakeReq = randomUUID();
    const shadows = [
      `create temp table approval_requests (id uuid, company_id uuid, status text, approvals_required int, submitted_by uuid, financial_event_id uuid)`,
      `insert into approval_requests values ('${fakeReq}', '${co}', 'pending', 1, gen_random_uuid(), null)`,
    ];
    // capUser is authenticated; the real approval_requests has no such row → decide_approval must fail closed.
    const r = await withShadows("auth", capUser, shadows, `select public.decide_approval($1,$2,'approve') as v`, [co, fakeReq]);
    expect(r.ok).toBe(false); // raised (request not found in the REAL table) — the shadow did not fabricate an approval
  });

  // ── finance: journal internals stay service-only AND unshadowable ──
  it("_journal_post_internal remains service-only (authenticated 42501) and unshadowable", async () => {
    const shadows = [`create temp table idempotency_keys (key text, company_id uuid)`];
    const r = await withShadows("auth", capUser, shadows,
      `select public._journal_post_internal(null::uuid, current_date, 'LKR','m', null::uuid, 'system', '[]'::jsonb, 'k','manual','x', null::uuid)`);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501"); // service-only; the temp shadow changes nothing
  });

  // ── WP12 control: the delivery owner check still resists a temp pg_proc shadow ──
  it("WP12 control: a temp pg_proc shadow cannot forge the delivery-owner check", async () => {
    const shadows = [
      `create temp table pg_proc (proowner oid)`,
      `insert into pg_proc(proowner) values (current_user::regrole::oid)`,
    ];
    const r = await withShadows("service", null, shadows, `select public._is_quotation_delivery_owner() as v`);
    expect(r.val).toBe(false);
  });

  // ── legitimate paths still work ──
  it("legitimate: a real member's has_capability is TRUE and my_company is the real company", async () => {
    await client.query("savepoint ok");
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: capUser, role: "authenticated" })]);
    const cap = (await client.query(`select public.has_capability($1,'sales.quotation.manage') as v`, [co])).rows[0].v;
    const mc = (await client.query(`select public.my_company() as v`)).rows[0].v;
    await client.query("reset role");
    await client.query("release savepoint ok");
    expect(cap).toBe(true);
    expect(mc).toBe(co);
  });
});
