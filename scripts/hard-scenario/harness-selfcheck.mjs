#!/usr/bin/env node
/**
 * HARNESS SELF-CHECK — must pass BEFORE any application test runs.
 *
 * The first campaign shipped an integration failure that was explained away as "probably
 * the harness". That is exactly the reasoning this file exists to make unnecessary: the
 * harness now proves its own preconditions, deterministically, and fails loudly when they
 * are not met. A test result is only meaningful if the thing it ran against was the thing
 * it was supposed to run against.
 *
 * It verifies, in order:
 *   1. Every service is reachable, and only on loopback.
 *   2. The ROLE TOPOLOGY is safe — no non-superuser login role holds both api
 *      (anon/authenticated) and service (service_role) membership. This is OF-017, and
 *      violating it is what made `found-006-caller-trust` fail in the first campaign.
 *   3. Grants are what the roles need and nothing more.
 *   4. Database state: schema applied, both tenants seeded, auth wiring correct.
 *   5. Isolation actually holds, tested live rather than assumed.
 *   6. No residue from a previous run is left behind.
 *   7. The outbound network guard is installed and blocks real providers.
 *
 * Exit 0 = safe to run application tests. Non-zero = do not trust anything that follows.
 */
import pg from "pg";
import { readFileSync } from "node:fs";

const DB_URL = process.env.DATABASE_URL ?? "postgres://postgres:hstpw@127.0.0.1:55442/singha_app";
const GATEWAY = process.env.HST_GATEWAY_URL ?? "http://127.0.0.1:54321";
const APP = process.env.HST_APP_URL ?? "http://127.0.0.1:3241";
const KEYS_FILE = process.env.HST_KEYS_FILE ?? "";

const TENANT_A = "0000f1de-0000-4000-8000-000000000001";
const TENANT_B = "0000f1de-0000-4000-8000-0000000000b2";

let failures = 0;
let checks = 0;
const ok = (m) => { checks++; console.log(`  ok    ${m}`); };
const bad = (m, detail) => { checks++; failures++; console.log(`  FAIL  ${m}${detail ? `\n          ${detail}` : ""}`); };
const section = (m) => console.log(`\n${m}`);

function loopback(u) {
  try { return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(u).hostname); }
  catch { return false; }
}

async function main() {
  console.log(`harness self-check → ${GATEWAY}`);

  /* 1 ── reachability and loopback-only ─────────────────────────────────── */
  section("1. services");
  for (const [name, url] of [["gateway", GATEWAY], ["app", APP]]) {
    if (!loopback(url)) { bad(`${name} is loopback`, `${url} is not a loopback address`); continue; }
    ok(`${name} is loopback (${url})`);
  }
  if (!loopback(DB_URL.replace(/^postgres/, "http"))) {
    bad("database is loopback", DB_URL.replace(/:[^:@/]*@/, ":<redacted>@"));
  } else ok("database is loopback");

  for (const [name, url] of [["gateway /auth/v1/health", `${GATEWAY}/auth/v1/health`], ["app /login", `${APP}/login`]]) {
    try {
      const r = await fetch(url);
      r.ok ? ok(`${name} → ${r.status}`) : bad(`${name} → ${r.status}`);
    } catch (e) { bad(`${name} unreachable`, String(e.message).slice(0, 120)); }
  }

  const client = new pg.Client({ connectionString: DB_URL, ssl: false });
  await client.connect();
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  try {
    /* 2 ── role topology (OF-017) ───────────────────────────────────────── */
    section("2. role topology (OF-017)");
    const logins = await q(`
      select r.rolname::text as name,
             pg_has_role(r.rolname,'service_role','MEMBER') as svc,
             (pg_has_role(r.rolname,'authenticated','MEMBER')
              or pg_has_role(r.rolname,'anon','MEMBER')) as api
        from pg_roles r
       where r.rolcanlogin and not r.rolsuper
       order by 1`);
    const merged = logins.filter((r) => r.svc && r.api).map((r) => r.name);
    if (merged.length) {
      bad("no login role holds BOTH api and service membership",
        `merged: ${merged.join(", ")} — a single SET ROLE from public API traffic reaches full service authority`);
    } else {
      ok(`no merged login role (${logins.length} checked: ${logins.map((r) => r.name).join(", ") || "none"})`);
    }
    const api = logins.find((r) => r.name === "pgrst_api");
    const svc = logins.find((r) => r.name === "pgrst_service");
    api && api.api && !api.svc ? ok("pgrst_api: api yes, service no") : bad("pgrst_api topology", JSON.stringify(api));
    svc && svc.svc && !svc.api ? ok("pgrst_service: service yes, api no") : bad("pgrst_service topology", JSON.stringify(svc));
    const stale = await q(`select 1 from pg_roles where rolname = 'authenticator'`);
    stale.length ? bad("the merged `authenticator` role still exists") : ok("no merged `authenticator` role");

    /* 3 ── grants ───────────────────────────────────────────────────────── */
    section("3. grants");
    const create = await q(`
      select r.rolname::text as name
        from pg_roles r
       where r.rolname in ('anon','authenticated','service_role')
         and (has_schema_privilege(r.rolname,'public','CREATE')
              or has_schema_privilege(r.rolname,'extensions','CREATE'))`);
    create.length
      ? bad("anon/authenticated/service_role must not hold CREATE", create.map((r) => r.name).join(", "))
      : ok("anon/authenticated/service_role hold no CREATE on public/extensions");

    /* 4 ── database state ───────────────────────────────────────────────── */
    section("4. database state");
    const [{ count: tables }] = await q(`select count(*)::int from information_schema.tables where table_schema='public'`);
    tables > 100 ? ok(`schema applied (${tables} public tables)`) : bad("schema looks incomplete", `${tables} tables`);

    // Assert the INVARIANT (the schema is fully migrated), not a number that goes stale
    // the next time a migration is added — which is exactly how this check first failed.
    const { readdirSync } = await import("node:fs");
    const onDisk = readdirSync("src/db/migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f)).length;
    const [{ count: migs }] = await q(`select count(*)::int from schema_migrations`);
    migs === onDisk
      ? ok(`all ${onDisk} migrations applied`)
      : bad("schema is not fully migrated", `${migs} applied, ${onDisk} on disk`);

    const uid = await q(`select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='auth' and p.proname='uid'`);
    uid[0]?.prosrc?.includes("request.jwt.claims")
      ? ok("auth.uid() reads request.jwt.claims (PostgREST-compatible)")
      : bad("auth.uid() is the legacy GoTrue variant", "RLS will not see the caller");

    for (const [label, id] of [["tenant A", TENANT_A], ["tenant B", TENANT_B]]) {
      const rows = await q(`select 1 from companies where id = $1`, [id]);
      rows.length ? ok(`${label} seeded`) : bad(`${label} missing`, id);
    }
    const [{ count: aUsers }] = await q(`select count(*)::int from memberships where company_id = $1 and status='active'`, [TENANT_A]);
    const [{ count: bUsers }] = await q(`select count(*)::int from memberships where company_id = $1 and status='active'`, [TENANT_B]);
    aUsers >= 4 ? ok(`tenant A has ${aUsers} active memberships`) : bad("tenant A memberships", `${aUsers}`);
    bUsers >= 3 ? ok(`tenant B has ${bUsers} active memberships`) : bad("tenant B memberships", `${bUsers}`);

    /* 5 ── isolation, tested rather than assumed ────────────────────────── */
    section("5. isolation");
    const [{ count: rlsOff }] = await q(`
      select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
         and c.relname in ('customers','projects','tasks','memberships','profiles',
                           'financial_events','approval_requests','journal_entries')`);
    rlsOff === 0 ? ok("RLS enabled on the core business tables") : bad("RLS disabled on core tables", `${rlsOff} without RLS`);

    if (KEYS_FILE) {
      const keys = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
      const restAs = async (token, path) => {
        const r = await fetch(`${GATEWAY}/rest/v1${path}`, {
          headers: { apikey: keys.anon, Authorization: `Bearer ${token}` },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      };
      // The requirement is that anon reads NO business data. Two outcomes satisfy it:
      // an empty result set (grant present, RLS filters everything), or an outright
      // permission denial (no table grant at all). The denial is the stronger of the
      // two, so accepting only the empty list would fail the safer configuration.
      const anonRead = await restAs(keys.anon, "/customers?select=id&limit=5");
      const anonEmpty = Array.isArray(anonRead.body) && anonRead.body.length === 0;
      const anonDenied = !Array.isArray(anonRead.body) && anonRead.body?.code === "42501";
      if (anonEmpty) ok("anon key alone reads no business data (empty result)");
      else if (anonDenied) ok("anon key alone reads no business data (permission denied — stronger)");
      else bad("anon key returned rows", JSON.stringify(anonRead).slice(0, 160));

      // The service instance must be the one that answers a service_role token, and it
      // must genuinely have service authority.
      const svcRead = await restAs(keys.service, "/companies?select=id");
      Array.isArray(svcRead.body) && svcRead.body.length >= 2
        ? ok("service_role token routes to the service instance and can read")
        : bad("service_role routing/authority", JSON.stringify(svcRead).slice(0, 160));
    } else {
      console.log("  skip  live isolation probes (set HST_KEYS_FILE to enable)");
    }

    /* 6 ── no residue from a previous run ───────────────────────────────── */
    section("6. cleanup / residue");
    const residue = [
      ["source_events", `select count(*)::int as count from source_events where provider_message_id like 'wamid.HST%'`],
      ["campaign channel_accounts", `select count(*)::int as count from channel_accounts where id = '0000f1de-0000-4000-8000-00000000ca01'`],
      ["money probes", `select count(*)::int as count from financial_events where correlation_id like 'hst-money-probe%'`],
      ["cross-tenant probe rows", `select count(*)::int as count from customers where name = 'HST cross-tenant insert'`],
      ["race approval actions", `select count(*)::int as count from approval_actions where note in ('hard-scenario','hst-race')`],
    ];
    for (const [label, sql] of residue) {
      const [{ count }] = await q(sql);
      count === 0 ? ok(`no residue: ${label}`) : bad(`residue left behind: ${label}`, `${count} row(s)`);
    }

    /* 7 ── outbound network guard ───────────────────────────────────────── */
    section("7. outbound network guard");
    const guardPath = "scripts/hard-scenario/net-guard.cjs";
    try {
      const src = readFileSync(guardPath, "utf8");
      src.includes("net.Socket.prototype.connect") && src.includes("dns.lookup")
        ? ok("net-guard patches both socket connect and DNS")
        : bad("net-guard does not cover both socket and DNS");
    } catch { bad("net-guard is missing", guardPath); }

    // Prove it, in this process, against the real provider hosts.
    const { execFileSync } = await import("node:child_process");
    try {
      const out = execFileSync(process.execPath, [
        "--require", `./${guardPath}`,
        "-e",
        `(async()=>{for(const u of ["https://graph.facebook.com/","https://api.openai.com/","https://api.anthropic.com/"]){` +
        `try{await fetch(u);console.log("REACHED "+u)}catch(e){console.log("blocked")}}})()`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      out.includes("REACHED")
        ? bad("an outbound provider request escaped the guard", out.trim().slice(0, 200))
        : ok("guard blocks graph.facebook.com, api.openai.com, api.anthropic.com");
    } catch (e) {
      bad("could not exercise the net guard", String(e.message).slice(0, 160));
    }
  } finally {
    await client.end();
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log("Application tests must NOT be trusted until these are fixed.");
    process.exit(1);
  }
}

main().catch((e) => { console.error("self-check crashed:", e.message); process.exit(2); });
