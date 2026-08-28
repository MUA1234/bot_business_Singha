#!/usr/bin/env node
/**
 * HARD-SCENARIO CAMPAIGN — second tenant.
 *
 * `scripts/verify/dev-fixture-seed.mjs` seeds ONE synthetic company, which is all the
 * visual harness needs. Cross-company isolation cannot be demonstrated with one tenant:
 * "user A cannot read company B" is only meaningful when company B exists, holds real
 * rows, and has its own users who CAN read them. This seeds that second tenant.
 *
 * It creates the users through the REAL GoTrue admin API, exactly as the fixture seed
 * does. There is no authentication bypass and no weakened policy anywhere in the
 * campaign — an isolation test that needed one would be proving nothing.
 *
 * Same safety guards as the fixture seed: loopback-only, never APP_ENV=production,
 * every credential from the environment, every value obviously synthetic.
 */
import { createClient } from "@supabase/supabase-js";

const url =
  process.env.DEV_FIXTURE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRoleKey =
  process.env.DEV_FIXTURE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const password = process.env.DEV_FIXTURE_PASSWORD;

if (!url || !serviceRoleKey) { console.error("seed-tenant-b: supabase url + service role key required"); process.exit(2); }
if (!password) { console.error("seed-tenant-b: DEV_FIXTURE_PASSWORD is required (never hard-coded)"); process.exit(2); }
if ((process.env.APP_ENV ?? "development") === "production") { console.error("seed-tenant-b: refusing APP_ENV=production"); process.exit(2); }
{
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    console.error(`seed-tenant-b: refusing non-loopback host ${host}`); process.exit(2);
  }
}

const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const P = "FIXTURE-B";
const CO = "0000f1de-0000-4000-8000-0000000000b2";
const id = (n) => `0000f1de-0000-4000-8000-b200000${String(n).padStart(5, "0")}`;
const day = (o) => { const d = new Date("2026-08-28T00:00:00Z"); d.setUTCDate(d.getUTCDate() + o); return d.toISOString().slice(0, 10); };

const USERS = [
  { key: "owner", username: "fixtureb.owner", email: "fixtureb.owner@singha.local", fullName: `${P} Owner (Rangana P.)`, department: "admin", isAdmin: true, roles: ["owner_management", "system_administrator"] },
  { key: "finance", username: "fixtureb.finance", email: "fixtureb.finance@singha.local", fullName: `${P} Finance (Dilani S.)`, department: "finance", isAdmin: false, roles: ["finance_reviewer"] },
  { key: "staff", username: "fixtureb.staff", email: "fixtureb.staff@singha.local", fullName: `${P} Staff (Nuwan K.)`, department: "operations", isAdmin: false, roles: ["staff_submitter"] },
];

async function upsert(table, rows, onConflict = "id") {
  if (!rows.length) return;
  const { error } = await db.from(table).upsert(rows, { onConflict });
  if (error) throw new Error(`${table}: ${error.message}`);
  console.log(`  ${table.padEnd(22)} ${rows.length}`);
}
async function ensureAuthUser(email) {
  const { data: created, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (!error && created?.user) return created.user.id;
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const found = list?.users?.find((u) => u.email === email);
  if (!found) throw new Error(`cannot create/find ${email}: ${error?.message}`);
  await db.auth.admin.updateUserById(found.id, { password, email_confirm: true });
  return found.id;
}

const SWEEP = ["tasks", "projects", "customers", "membership_roles", "memberships", "employee_profiles", "profiles"];

async function main() {
  console.log(`seed-tenant-b → ${url}`);
  for (const t of SWEEP) await db.from(t).delete().eq("company_id", CO);
  await db.from("companies").delete().eq("id", CO);

  await upsert("companies", [{ id: CO, name: `${P} — Southgate Placeholder (Pvt) Ltd`, legal_name: `${P} Southgate Placeholder Private Limited`, base_currency: "LKR", country: "LK", status: "active" }]);

  const uid = {};
  for (const u of USERS) uid[u.key] = await ensureAuthUser(u.email);
  console.log(`  auth users            ${USERS.length} (real GoTrue)`);

  await upsert("profiles", USERS.map((u) => ({ id: uid[u.key], company_id: CO, username: u.username, full_name: u.fullName, department: u.department, is_admin: u.isAdmin, is_active: true, job_title: "placeholder", skills: ["placeholder"] })));
  await upsert("users", USERS.map((u) => ({ id: uid[u.key], email: u.email, full_name: u.fullName, is_active: true })));

  const mid = {};
  USERS.forEach((u, i) => (mid[u.key] = id(100 + i)));
  await upsert("memberships", USERS.map((u) => ({ id: mid[u.key], company_id: CO, user_id: uid[u.key], status: "active" })));
  await upsert("membership_roles", USERS.flatMap((u) => u.roles.map((r) => ({ membership_id: mid[u.key], company_id: CO, role_key: r }))), "membership_id,role_key");
  await upsert("employee_profiles", USERS.map((u) => ({ membership_id: mid[u.key], company_id: CO, employment_status: "active", start_date: day(-400), contracted_weekly_hours: 40, reserved_weekly_hours: 4, skills: ["placeholder"] })), "membership_id");

  // Records that tenant A must never be able to read.
  await upsert("customers", [{ id: id(200), company_id: CO, name: `${P} Confidential Customer`, phone: "+94770000902", email: "b.customer@placeholder.local", status: "active" }]);
  await upsert("projects", [{ id: id(300), company_id: CO, name: `${P} Confidential Project`, status: "active" }]);
  await upsert("tasks", [{ id: id(400), company_id: CO, title: `${P} Confidential Task`, status: "planned", priority: 1, due_date: day(5), created_by: uid.owner }]);

  console.log("\nseed-tenant-b: done.");
  console.log(`  company:  ${CO}`);
  for (const u of USERS) console.log(`  ${u.key.padEnd(8)} ${u.email}  membership=${mid[u.key]}`);
  console.log(`  secret customer=${id(200)} project=${id(300)} task=${id(400)}`);
}
main().catch((e) => { console.error("seed-tenant-b failed:", e.message); process.exit(1); });
