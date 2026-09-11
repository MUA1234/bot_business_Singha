#!/usr/bin/env node
/**
 * Owner-authorised hosted application of migration 0070's DATA REPAIR, over the Supabase REST
 * API instead of a direct Postgres connection.
 *
 * Why this exists. `db.<ref>.supabase.co` publishes only an AAAA record, and the operator
 * machine has no global IPv6 address (`ifconfig` shows none) and no IPv6 route, so `psql` /
 * `pg_dump` / `npm run migrate` cannot reach it; every Supavisor pooler region answers
 * "tenant/user not found" for this project, so there is no IPv4 Postgres path either. The REST
 * API (HTTPS, IPv4) is reachable, and every statement in 0070 is expressible as a service-role
 * REST operation on the same rows.
 *
 * This script is NOT a substitute for the migration: `0070_identity_backfill_and_event_lifecycle.sql`
 * stays the canonical artefact and stays PENDING in the `schema_migrations` ledger, so whenever a
 * machine with connectivity runs `npm run migrate` the real SQL executes — it is idempotent, so
 * on already-repaired data it is a no-op, and only then is the ledger row written. Nothing here
 * fakes a ledger entry.
 *
 * Properties:
 *   - idempotent: every write is an upsert or a filtered update over a computed delta; re-running
 *     changes nothing.
 *   - evidence-only: a source event is closed out ONLY where an inbound `wa_messages` row proves
 *     `handled_at`; `created_by` is nulled ONLY where the value is itself a `companies.id`.
 *   - one-way on access: a deactivated profile's membership is suspended, never re-activated.
 *   - verifies: re-reads the same invariants `tests/integration/identity-consistency.test.ts`
 *     asserts, and exits non-zero if any still fails.
 *   - `--dry-run` prints the delta and writes nothing.
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/hosted-repair-0070.mjs [--dry-run]
 */

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.argv.includes("--dry-run");

if (!URL_BASE || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(2);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { ...H, ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const get = (path) => rest(path);
const post = (path, body, prefer) =>
  rest(path, { method: "POST", body: JSON.stringify(body), headers: prefer ? { Prefer: prefer } : {} });
const patch = (path, body) =>
  rest(path, { method: "PATCH", body: JSON.stringify(body), headers: { Prefer: "return=minimal" } });

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const did = (msg) => console.log(`    ${DRY ? "would " : ""}${msg}`);

async function main() {
  console.log(`Migration 0070 data repair → ${URL_BASE}${DRY ? "  (DRY RUN)" : ""}`);

  const [profiles, users, memberships, roles, companies] = await Promise.all([
    get("profiles?select=id,company_id,username,full_name,is_admin,is_active"),
    get("users?select=id"),
    get("memberships?select=id,company_id,user_id,status"),
    get("membership_roles?select=membership_id,role_key"),
    get("companies?select=id"),
  ]);
  const userIds = new Set(users.map((u) => u.id));
  const companyIds = new Set(companies.map((c) => c.id));
  const memByKey = new Map(memberships.map((m) => [`${m.company_id}:${m.user_id}`, m]));

  // ── A1. users rows ───────────────────────────────────────────────────────────────────────
  step("A1", "users — the FK target memberships need");
  const missingUsers = profiles.filter((p) => !userIds.has(p.id));
  did(`insert ${missingUsers.length} users row(s): ${missingUsers.map((p) => p.username).join(", ") || "none"}`);
  if (!DRY && missingUsers.length) {
    await post(
      "users",
      missingUsers.map((p) => ({ id: p.id, full_name: p.full_name ?? null, is_active: p.is_active })),
      "resolution=merge-duplicates,return=minimal",
    );
  }

  // ── A2. memberships ──────────────────────────────────────────────────────────────────────
  step("A2", "memberships — one per (company, user)");
  const missingMems = profiles.filter((p) => !memByKey.has(`${p.company_id}:${p.id}`));
  did(`insert ${missingMems.length} membership(s): ${missingMems.map((p) => p.username).join(", ") || "none"}`);
  if (!DRY && missingMems.length) {
    await post(
      "memberships",
      missingMems.map((p) => ({
        company_id: p.company_id,
        user_id: p.id,
        status: p.is_active ? "active" : "suspended",
      })),
      "resolution=merge-duplicates,return=minimal",
    );
  }

  // ── A3. membership_roles ─────────────────────────────────────────────────────────────────
  step("A3", "membership_roles — everyone submits; an admin also administers");
  const memsNow = await get("memberships?select=id,company_id,user_id,status");
  const rolesNow = new Set(roles.map((r) => `${r.membership_id}:${r.role_key}`));
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const wanted = [];
  for (const m of memsNow) {
    const p = profileById.get(m.user_id);
    const keys = ["staff_submitter", ...(p?.is_admin ? ["system_administrator"] : [])];
    for (const role_key of keys) {
      if (!rolesNow.has(`${m.id}:${role_key}`)) {
        wanted.push({ membership_id: m.id, company_id: m.company_id, role_key });
      }
    }
  }
  did(`insert ${wanted.length} role grant(s)`);
  if (!DRY && wanted.length) {
    await post("membership_roles", wanted, "resolution=ignore-duplicates,return=minimal");
  }

  // ── A4. suspend the membership of a deactivated profile (never the reverse) ───────────────
  step("A4", "suspend memberships whose profile is deactivated (one-way)");
  const toSuspend = memsNow.filter(
    (m) => m.status === "active" && profileById.get(m.user_id)?.is_active === false,
  );
  did(`suspend ${toSuspend.length}: ${toSuspend.map((m) => profileById.get(m.user_id)?.username).join(", ") || "none"}`);
  if (!DRY) for (const m of toSuspend) await patch(`memberships?id=eq.${m.id}`, { status: "suspended" });

  // ── B. close out source events the database proves were handled ──────────────────────────
  step("B", "source_events — close out only what wa_messages proves was handled");
  const [openEvents, handled] = await Promise.all([
    get("source_events?select=id,provider_message_id,company_id,status&source=eq.whatsapp&status=in.(received,processing)"),
    get("wa_messages?select=wa_message_id,company_id,handled_at&direction=eq.inbound&handled_at=not.is.null"),
  ]);
  const proof = new Map();
  for (const m of handled) if (m.wa_message_id) proof.set(m.wa_message_id, m);
  const closable = openEvents.filter((e) => proof.has(e.provider_message_id));
  did(
    `mark ${closable.length} of ${openEvents.length} open event(s) processed; ` +
      `${openEvents.length - closable.length} stay open (no handled_at proof)`,
  );
  if (!DRY)
    for (const e of closable) {
      const p = proof.get(e.provider_message_id);
      await patch(`source_events?id=eq.${e.id}`, {
        status: "processed",
        processed_at: p.handled_at,
        last_error: null,
        ...(e.company_id ? {} : { company_id: p.company_id }),
      });
    }

  // ── C. un-author rows an unattended sweep attributed to a COMPANY ────────────────────────
  step("C", "created_by — null it where the author is a companies.id");
  for (const table of ["management_cases", "tasks"]) {
    const rows = await get(`${table}?select=id,created_by&created_by=not.is.null`);
    const wrong = rows.filter((r) => companyIds.has(r.created_by));
    did(`${table}: un-author ${wrong.length} row(s)`);
    if (!DRY) for (const r of wrong) await patch(`${table}?id=eq.${r.id}`, { created_by: null });
  }

  if (DRY) {
    console.log("\nDRY RUN — nothing was written.");
    return;
  }

  // ── Verify the same invariants the permanent integration gate asserts ────────────────────
  step("✓", "verification");
  const [vProfiles, vUsers, vMems, vRoles] = await Promise.all([
    get("profiles?select=id,company_id,username,is_admin,is_active"),
    get("users?select=id"),
    get("memberships?select=id,company_id,user_id,status"),
    get("membership_roles?select=membership_id,role_key"),
  ]);
  const vUserIds = new Set(vUsers.map((u) => u.id));
  const vMemByKey = new Map(vMems.map((m) => [`${m.company_id}:${m.user_id}`, m]));
  const vRoleSet = new Set(vRoles.map((r) => `${r.membership_id}:${r.role_key}`));
  const memRoleCount = new Map();
  for (const r of vRoles) memRoleCount.set(r.membership_id, (memRoleCount.get(r.membership_id) ?? 0) + 1);

  const failures = [];
  for (const p of vProfiles) {
    if (!vUserIds.has(p.id)) failures.push(`${p.username}: no users row`);
    const m = vMemByKey.get(`${p.company_id}:${p.id}`);
    if (!m) failures.push(`${p.username}: no membership in its own company`);
    else {
      if ((memRoleCount.get(m.id) ?? 0) === 0) failures.push(`${p.username}: membership with no role`);
      if (p.is_admin && !vRoleSet.has(`${m.id}:system_administrator`))
        failures.push(`${p.username}: admin without system_administrator`);
      if (!p.is_active && m.status === "active") failures.push(`${p.username}: inactive profile, active membership`);
    }
  }
  const stillOpen = await get(
    "source_events?select=id&source=eq.whatsapp&status=in.(received,processing)",
  );
  const remainingWrong = (
    await Promise.all(
      ["management_cases", "tasks"].map(async (t) => {
        const rows = await get(`${t}?select=id,created_by&created_by=not.is.null`);
        return rows.filter((r) => companyIds.has(r.created_by)).length;
      }),
    )
  ).reduce((a, b) => a + b, 0);
  if (remainingWrong > 0) failures.push(`${remainingWrong} row(s) still authored by a company`);

  console.log(`    profiles ${vProfiles.length} · users ${vUsers.length} · memberships ${vMems.length} · role grants ${vRoles.length}`);
  console.log(`    source_events still open: ${stillOpen.length} (unhandled events legitimately stay open)`);
  console.log(`    company-authored rows remaining: ${remainingWrong}`);

  if (failures.length) {
    console.error(`\n❌ ${failures.length} invariant(s) still failing:`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log("\n✅ every identity invariant holds; repair complete.");
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
