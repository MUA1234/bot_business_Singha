#!/usr/bin/env node
/**
 * Bring up the hard-scenario stack — REPRODUCIBLY.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 *
 * `docs/hard-scenario/00-ENVIRONMENT-AND-ISOLATION.md` documents this stack precisely: images,
 * ports, role topology, what is real and what is substituted. What it did not have was a way to
 * build it. The containers were created by hand, the campaign ran, and eleven days later the only
 * things left were four exited containers and a table describing them. A harness that cannot be
 * rebuilt is a harness whose results cannot be reproduced, which is the same objection this
 * repository raises against every other unrepeatable claim.
 *
 * So: one command, from nothing, to a stack that passes `harness-selfcheck.mjs`.
 *
 * ── What it builds ───────────────────────────────────────────────────────────────────────────
 *
 *   postgres:16              — `singha_app`, the real schema
 *   supabase/gotrue          — REAL authentication, issuing genuine JWTs
 *   supabase/postgrest ×2    — REAL data API and RLS, over TWO login identities
 *   the gateway              — a path-prefix router standing in for Kong, and nothing else
 *
 * ── Why two PostgREST instances ──────────────────────────────────────────────────────────────
 *
 * A hosted Supabase project puts one `authenticator` login role behind Kong, and that role holds
 * anon, authenticated AND service_role — so a single `SET ROLE` from public API traffic can reach
 * full service authority. OF-017 records that as a real finding. The harness does what that
 * finding asks production to do: `pgrst_api` holds the api roles and not service, `pgrst_service`
 * holds service and not the api roles, and no `authenticator` exists at all. The gateway routes
 * by the token's role claim, so the api identity is never even connected to for a service call.
 *
 * ── Order matters, and one step is easy to get wrong ─────────────────────────────────────────
 *
 * GoTrue runs its own migrations against the `auth` schema, and one of them installs a LEGACY
 * `auth.uid()` that reads `request.jwt.claim.sub`. PostgREST sets `request.jwt.claims` (plural,
 * a JSON object). If the shim is applied before GoTrue, GoTrue overwrites it and every RLS policy
 * silently sees a null caller — the database would answer as if nobody were signed in, and the
 * tests would read that as correct fail-closed behaviour. So: GoTrue first, THEN the shim.
 *
 * Everything is loopback-only and disposable. Nothing hosted is contacted.
 *
 * Usage:
 *   node scripts/hard-scenario/up.mjs            # build
 *   node scripts/hard-scenario/up.mjs --down     # destroy
 */
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import pg from "pg";

const LABEL = "singha.harness=hard-scenario";
/**
 * A user-defined bridge, NOT `--network host`.
 *
 * `--network host` is a Linux feature. On Docker Desktop for Windows the containers run inside a
 * Linux VM, so "host" is the VM's network and nothing binds where a Windows process can reach it —
 * GoTrue started cleanly, logged only deprecation warnings, and was simply unreachable. On a bridge
 * the services resolve each other by container NAME and each publishes its own port to 127.0.0.1.
 */
const NET = "singha-hst-net";
const PG = "singha-hst-pg16";
const GOTRUE = "singha-hst-gotrue";
const REST_API = "singha-hst-rest-api";
const REST_SVC = "singha-hst-rest-svc";

const PORT_PG = 55442, PORT_GOTRUE = 55444, PORT_REST_API = 55445, PORT_REST_SVC = 55446;
/**
 * The gateway is NOT on 54321.
 *
 * F-012: an unrelated project's Supabase stack claimed the Supabase default port on this machine
 * mid-campaign and answered `/auth/v1/health`, so the harness was talking to somebody else's
 * database while reporting success. There is such a stack running on this machine right now
 * (`supabase_kong_sbdev`), which is precisely why this stays on 54399 and why the gateway exposes
 * `/__hst/identity`.
 */
const PORT_GATEWAY = 54399;
const APP_PORT = 3241;

/** Non-secret, local-only, and regenerated on every build. Never a production value. */
const PGPASSWORD = "hstpw";
const JWT_SECRET = "hard-scenario-local-only-jwt-secret-not-a-production-value-0001";
const DB = "singha_app";
const DB_URL = `postgres://postgres:${PGPASSWORD}@127.0.0.1:${PORT_PG}/${DB}`;

const KEYS_DIR = ".hard-scenario";
const KEYS_FILE = `${KEYS_DIR}/local-keys.json`;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const quiet = (cmd, args) => { try { return sh(cmd, args, { stdio: "pipe" }); } catch { return ""; } };
const step = (m) => console.log(`▶ ${m}`);
const ok = (m) => console.log(`  ✔ ${m}`);

/** A JWT, signed the way GoTrue and PostgREST both expect. No library: it is three base64 parts. */
function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: "supabase-local", iat: Math.floor(Date.now() / 1e3),
                     exp: Math.floor(Date.now() / 1e3) + 60 * 60 * 24 * 30, ...payload });
  const sig = createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function down() {
  step("destroying the hard-scenario stack");
  for (const n of [REST_SVC, REST_API, GOTRUE, PG]) {
    quiet("docker", ["rm", "-f", n]);
    ok(`removed ${n}`);
  }
  quiet("docker", ["network", "rm", NET]);
}

async function waitFor(label, fn, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) { ok(`${label} ready`); return; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} never became ready`);
}

async function up() {
  down();

  step("network");
  quiet("docker", ["network", "create", NET]);
  ok(NET);

  step("postgres:16");
  sh("docker", ["run", "-d", "--name", PG, "--label", LABEL, "--network", NET,
    "-e", `POSTGRES_PASSWORD=${PGPASSWORD}`, "-e", `POSTGRES_DB=${DB}`,
    "-p", `127.0.0.1:${PORT_PG}:5432`, "postgres:16"], { stdio: "pipe" });
  // NOT `pg_isready`. The postgres entrypoint starts a temporary socket-only server to run its
  // init scripts, and `pg_isready` answers "accepting connections" for THAT one — then the server
  // is shut down and restarted with TCP listening. Waiting on it means connecting during the gap
  // and getting "Connection terminated unexpectedly", which is exactly what happened. The only
  // honest readiness test is the connection the caller will actually make.
  await waitFor("postgres", async () => {
    const probe = new pg.Client({ connectionString: DB_URL, ssl: false, connectionTimeoutMillis: 2000 });
    try { await probe.connect(); await probe.query("select 1"); return true; }
    finally { await probe.end().catch(() => {}); }
  });

  const admin = new pg.Client({ connectionString: DB_URL, ssl: false });
  await admin.connect();

  step("role topology (OF-017: no login role holds both api and service)");
  await admin.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
    end $$;`);
  // Two login identities, neither holding the other's memberships. This is the whole point.
  await admin.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='pgrst_api') then
        create role pgrst_api login password '${PGPASSWORD}' noinherit; end if;
      if not exists (select 1 from pg_roles where rolname='pgrst_service') then
        create role pgrst_service login password '${PGPASSWORD}' noinherit; end if;
    end $$;`);
  await admin.query(`grant anon, authenticated to pgrst_api`);
  await admin.query(`grant service_role to pgrst_service`);
  // A merged role left behind by an older build would defeat the separation silently.
  await admin.query(`drop role if exists authenticator`);
  ok("pgrst_api (api only), pgrst_service (service only), no `authenticator`");

  // GoTrue needs its own schema and an owner for it, before it runs its migrations.
  await admin.query(`create schema if not exists auth`);
  await admin.query(`grant all on schema auth to postgres`);
  await admin.end();

  step("GoTrue (real authentication)");
  sh("docker", ["run", "-d", "--name", GOTRUE, "--label", LABEL, "--network", NET,
    "-p", `127.0.0.1:${PORT_GOTRUE}:${PORT_GOTRUE}`,
    "-e", "GOTRUE_DB_DRIVER=postgres",
    "-e", `DATABASE_URL=postgres://postgres:${PGPASSWORD}@${PG}:5432/${DB}?search_path=auth&sslmode=disable`,
    "-e", `GOTRUE_JWT_SECRET=${JWT_SECRET}`,
    "-e", "GOTRUE_JWT_EXP=3600",
    "-e", "GOTRUE_JWT_AUD=authenticated",
    "-e", "GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
    "-e", "GOTRUE_JWT_ADMIN_ROLES=service_role",
    "-e", "GOTRUE_API_HOST=0.0.0.0",
    "-e", `API_EXTERNAL_URL=http://127.0.0.1:${PORT_GATEWAY}`,
    "-e", `PORT=${PORT_GOTRUE}`,
    "-e", "GOTRUE_SITE_URL=http://127.0.0.1:3241",
    "-e", "GOTRUE_DISABLE_SIGNUP=false",
    "-e", "GOTRUE_MAILER_AUTOCONFIRM=true",
    "-e", "GOTRUE_LOG_LEVEL=warn",
    "supabase/gotrue:v2.196.0"], { stdio: "pipe" });
  await waitFor("gotrue", async () =>
    (await fetch(`http://127.0.0.1:${PORT_GOTRUE}/health`).catch(() => null))?.ok === true);

  // ── THE ORDER THAT MATTERS ────────────────────────────────────────────────────────────────
  // GoTrue has now installed its legacy `auth.uid()`. The shim goes on top and restores the
  // PostgREST-compatible one. Reversing these two lines makes every RLS policy see a null caller.
  step("Supabase compatibility shim (AFTER GoTrue, deliberately)");
  sh("node", ["scripts/apply-sql.mjs", "tests/integration/helpers/supabase-shim.sql"],
    { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  ok("shim applied; auth.uid() reads request.jwt.claims");

  step("application migrations");
  const out = sh("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  ok(out.trim().split("\n").pop());

  step("PostgREST ×2");
  const rest = (name, port, role, user) => sh("docker", ["run", "-d", "--name", name, "--label", LABEL,
    "--network", NET, "-p", `127.0.0.1:${port}:${port}`,
    "-e", `PGRST_DB_URI=postgres://${user}:${PGPASSWORD}@${PG}:5432/${DB}`,
    "-e", "PGRST_SERVER_HOST=0.0.0.0",
    "-e", "PGRST_DB_SCHEMAS=public",
    "-e", `PGRST_DB_ANON_ROLE=${role}`,
    "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`,
    "-e", `PGRST_SERVER_PORT=${port}`,
    "-e", "PGRST_DB_USE_LEGACY_GUCS=false",
    "public.ecr.aws/supabase/postgrest:v16.1"], { stdio: "pipe" });
  rest(REST_API, PORT_REST_API, "anon", "pgrst_api");
  rest(REST_SVC, PORT_REST_SVC, "service_role", "pgrst_service");
  await waitFor("postgrest (api)", async () =>
    (await fetch(`http://127.0.0.1:${PORT_REST_API}/`).catch(() => null)) !== null);
  await waitFor("postgrest (service)", async () =>
    (await fetch(`http://127.0.0.1:${PORT_REST_SVC}/`).catch(() => null)) !== null);

  step("keys");
  mkdirSync(KEYS_DIR, { recursive: true });
  const keys = { anon: jwt({ role: "anon" }), service: jwt({ role: "service_role" }),
                 jwtSecret: JWT_SECRET, gateway: `http://127.0.0.1:${PORT_GATEWAY}`, db: DB_URL };
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  ok(`${KEYS_FILE} written (gitignored; local-only values)`);

  step("gateway");
  const gw = spawn(process.execPath, ["scripts/hard-scenario/local-supabase-gateway.mjs"], {
    env: { ...process.env, GATEWAY_PORT: String(PORT_GATEWAY),
           GATEWAY_GOTRUE: `http://127.0.0.1:${PORT_GOTRUE}`,
           GATEWAY_POSTGREST: `http://127.0.0.1:${PORT_REST_API}`,
           GATEWAY_POSTGREST_SERVICE: `http://127.0.0.1:${PORT_REST_SVC}` },
    detached: true, stdio: "ignore",
  });
  gw.unref();
  await waitFor("gateway", async () =>
    (await fetch(`http://127.0.0.1:${PORT_GATEWAY}/__hst/identity`).catch(() => null))?.ok === true);

  console.log(`
stack up.
  gateway   http://127.0.0.1:${PORT_GATEWAY}
  database  ${DB_URL.replace(/:[^:@/]*@/, ":<redacted>@")}
  keys      ${KEYS_FILE}

next:
  HST_KEYS_FILE=${KEYS_FILE} HST_GATEWAY_URL=http://127.0.0.1:${PORT_GATEWAY} \\
    node scripts/hard-scenario/harness-selfcheck.mjs
`);
}

if (process.argv.includes("--down")) down();
else await up();
