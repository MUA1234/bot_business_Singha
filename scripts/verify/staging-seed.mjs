/**
 * Seed a disposable staging Supabase environment with three synthetic users
 * (owner/CEO, manager, ordinary staff), a shared test company, role capabilities,
 * tasks, notifications, finance records and fleet assets.
 *
 * This script reads ALL credentials from environment variables and never embeds
 * passwords or keys. It is safe to commit.
 *
 * Required env:
 *   SPATIAL_SCREENSHOT_SUPABASE_URL       (defaults to NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL)
 *   SPATIAL_SCREENSHOT_SERVICE_ROLE_KEY   (defaults to SUPABASE_SERVICE_ROLE_KEY)
 *   SPATIAL_SCREENSHOT_OWNER_PASSWORD
 *   SPATIAL_SCREENSHOT_STAFF_PASSWORD
 *   SPATIAL_SCREENSHOT_MANAGER_PASSWORD
 * Optional env:
 *   SPATIAL_SCREENSHOT_COMPANY_ID
 *   SPATIAL_SCREENSHOT_OWNER_EMAIL
 *   SPATIAL_SCREENSHOT_STAFF_EMAIL
 *   SPATIAL_SCREENSHOT_MANAGER_EMAIL
 *
 * Usage:
 *   node scripts/verify/staging-seed.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { seedForScreenshots } from "./spatial-screenshot-seed.mjs";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getConfig() {
  const url =
    process.env.SPATIAL_SCREENSHOT_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const serviceRoleKey =
    process.env.SPATIAL_SCREENSHOT_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase URL or service role key for staging seed.");
  }
  return {
    url,
    serviceRoleKey,
    companyId: process.env.SPATIAL_SCREENSHOT_COMPANY_ID || "00000000-0000-0000-0000-00000000515a",
    ownerEmail: process.env.SPATIAL_SCREENSHOT_OWNER_EMAIL || "owner-screenshot@singha.local",
    staffEmail: process.env.SPATIAL_SCREENSHOT_STAFF_EMAIL || "staff-screenshot@singha.local",
    managerEmail: process.env.SPATIAL_SCREENSHOT_MANAGER_EMAIL || "manager-screenshot@singha.local",
    ownerPassword: required("SPATIAL_SCREENSHOT_OWNER_PASSWORD"),
    staffPassword: required("SPATIAL_SCREENSHOT_STAFF_PASSWORD"),
    managerPassword: required("SPATIAL_SCREENSHOT_MANAGER_PASSWORD"),
  };
}

// Capabilities used by the spatial workspace module registry.
const ALL_CAPS = [
  "operations.task.manage",
  "finance.journal.post",
  "hr.staff.manage",
  "operations.project.manage",
  "sales.quotation.manage",
  "operations.fleet.manage",
  "procurement.po.approve",
  "legal.risk.manage",
];

const MANAGER_CAPS = [
  "operations.task.manage",
  "operations.project.manage",
  "hr.staff.manage",
  "sales.quotation.manage",
];

async function ensureAuthUser(supabase, email, password) {
  const { data: list, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);
  const existing = list.users.find((u) => u.email === email);
  if (existing) {
    const { data, error } = await supabase.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`Failed to update ${email}: ${error.message}`);
    return data.user;
  }
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`Failed to create ${email}: ${error.message}`);
  return data.user;
}

async function upsertProfile(supabase, ctx, userId, { username, fullName, department, isAdmin }) {
  const { error } = await supabase.from("profiles").upsert(
    {
      id: userId,
      company_id: ctx.companyId,
      username,
      full_name: fullName,
      department,
      is_admin: isAdmin,
      is_active: true,
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(`upsertProfile failed: ${error.message}`);
}

async function ensureRoles(supabase, ctx) {
  for (const key of ["spatial_owner", "spatial_manager", "spatial_staff"]) {
    const { error } = await supabase
      .from("roles")
      .upsert({ key, label: key.replace(/_/g, " ") }, { onConflict: "key" });
    if (error) throw new Error(`upsert role ${key}: ${error.message}`);
  }
  for (const cap of ALL_CAPS) {
    const { error } = await supabase
      .from("permissions")
      .upsert({ key: cap, label: cap }, { onConflict: "key" });
    if (error) throw new Error(`upsert permission ${cap}: ${error.message}`);
  }
  async function link(roleKey, caps) {
    for (const cap of caps) {
      const { error } = await supabase
        .from("role_permissions")
        .upsert({ role_key: roleKey, permission_key: cap }, { onConflict: "role_key,permission_key" });
      if (error) throw new Error(`link ${roleKey} -> ${cap}: ${error.message}`);
    }
  }
  await link("spatial_owner", ALL_CAPS);
  await link("spatial_manager", MANAGER_CAPS);
  await link("spatial_staff", ["operations.task.manage"]);
}

async function assignMembership(supabase, ctx, userId, roleKey) {
  const { data: existing } = await supabase
    .from("memberships")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("user_id", userId)
    .maybeSingle();
  let membershipId = existing?.id;
  if (!membershipId) {
    const { data, error } = await supabase
      .from("memberships")
      .insert({ company_id: ctx.companyId, user_id: userId, status: "active" })
      .select("id")
      .single();
    if (error) throw new Error(`create membership: ${error.message}`);
    membershipId = data.id;
  }
  const { error } = await supabase
    .from("membership_roles")
    .upsert(
      { membership_id: membershipId, company_id: ctx.companyId, role_key: roleKey },
      { onConflict: "membership_id,role_key" },
    );
  if (error) throw new Error(`assign role ${roleKey}: ${error.message}`);
}

async function seedManager(supabase, ctx) {
  const manager = await ensureAuthUser(supabase, ctx.managerEmail, ctx.managerPassword);
  await upsertProfile(supabase, ctx, manager.id, {
    username: "screenshot-manager",
    fullName: "Screenshot Manager",
    department: "operations",
    isAdmin: false,
  });
  await assignMembership(supabase, ctx, manager.id, "spatial_manager");
  return manager;
}

async function seedFinance(supabase, ctx, ownerId) {
  const now = new Date().toISOString();
  const fyName = "Staging FY 2026";
  const { data: existingFy } = await supabase
    .from("fiscal_years")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("name", fyName)
    .maybeSingle();

  let fiscalYearId = existingFy?.id;
  if (!fiscalYearId) {
    const { data, error } = await supabase
      .from("fiscal_years")
      .insert({
        company_id: ctx.companyId,
        name: fyName,
        start_date: "2026-01-01",
        end_date: "2026-12-31",
        status: "open",
      })
      .select("id")
      .single();
    if (error) throw new Error(`seed fiscal year: ${error.message}`);
    fiscalYearId = data.id;
  }

  const periodName = "August 2026";
  const { data: existingPeriod } = await supabase
    .from("accounting_periods")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("name", periodName)
    .maybeSingle();

  let periodId = existingPeriod?.id;
  if (!periodId) {
    const { data, error } = await supabase
      .from("accounting_periods")
      .insert({
        company_id: ctx.companyId,
        fiscal_year_id: fiscalYearId,
        name: periodName,
        start_date: "2026-08-01",
        end_date: "2026-08-31",
        status: "open",
      })
      .select("id")
      .single();
    if (error) throw new Error(`seed accounting period: ${error.message}`);
    periodId = data.id;
  }

  const accounts = [
    { code: "1000", name: "Cash", type: "asset" },
    { code: "1200", name: "Debtors", type: "asset" },
    { code: "2000", name: "Creditors", type: "liability" },
    { code: "3000", name: "Capital", type: "equity" },
    { code: "4000", name: "Sales", type: "income" },
    { code: "5000", name: "Cost of Sales", type: "expense" },
  ];

  for (const a of accounts) {
    const { error } = await supabase
      .from("chart_of_accounts")
      .upsert(
        { company_id: ctx.companyId, code: a.code, name: a.name, type: a.type, is_active: true },
        { onConflict: "company_id,code" },
      );
    if (error) throw new Error(`seed chart of accounts ${a.code}: ${error.message}`);
  }

  const correlationId = "staging-seed-journal-1";
  const { data: existingJournal } = await supabase
    .from("journal_entries")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("correlation_id", correlationId)
    .maybeSingle();

  if (!existingJournal) {
    const { data: journal, error: jErr } = await supabase
      .from("journal_entries")
      .insert({
        company_id: ctx.companyId,
        period_id: periodId,
        posting_date: "2026-08-24",
        currency: "LKR",
        exchange_rate: 1,
        memo: "Staging seed journal",
        status: "draft",
        correlation_id: correlationId,
        idempotency_key: `${ctx.companyId}:${correlationId}`,
        total_debit: 1000,
        total_credit: 1000,
        created_by: ownerId,
      })
      .select("id")
      .single();
    if (jErr) throw new Error(`seed journal: ${jErr.message}`);

    const lines = [
      { account_code: "1000", debit: 1000, credit: 0, line_no: 1 },
      { account_code: "4000", debit: 0, credit: 1000, line_no: 2 },
    ];
    const { error: lErr } = await supabase.from("journal_lines").insert(
      lines.map((l) => ({
        journal_id: journal.id,
        company_id: ctx.companyId,
        account_code: l.account_code,
        debit: l.debit,
        credit: l.credit,
        line_no: l.line_no,
      })),
    );
    if (lErr) throw new Error(`seed journal lines: ${lErr.message}`);
  }

  const { error: bankErr } = await supabase
    .from("bank_accounts")
    .upsert(
      {
        company_id: ctx.companyId,
        name: "Staging Bank Account",
        account_number: "STAGE-1234",
        currency: "LKR",
        gl_account_code: "1000",
        opening_balance: 5000,
        status: "active",
      },
      { onConflict: "company_id, account_number" },
    );
  if (bankErr) throw new Error(`seed bank account: ${bankErr.message}`);
}

async function seedAssets(supabase, ctx, ownerId) {
  const { error } = await supabase
    .from("vehicles")
    .upsert(
      {
        company_id: ctx.companyId,
        registration_no: "STAGE-LK-01",
        make: "Toyota",
        model: "Hilux",
        year: 2024,
        status: "active",
        odometer: 1234,
      },
      { onConflict: "company_id, registration_no" },
    );
  if (error) throw new Error(`seed vehicle: ${error.message}`);
}

export async function seedForStaging() {
  // Reuse the screenshot seed for owner, staff, roles, permissions and arrivals.
  const base = await seedForScreenshots();
  const config = getConfig();
  const supabase = createClient(config.url, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const ctx = { ...config, supabase };

  console.log("Seeding staging-specific manager, finance and assets…");
  await ensureRoles(supabase, ctx);
  const manager = await seedManager(supabase, ctx);
  await seedFinance(supabase, ctx, base.owner.id);
  await seedAssets(supabase, ctx, base.owner.id);
  console.log("Staging seed complete.");

  return { ...base, manager, ...config };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  seedForStaging().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
