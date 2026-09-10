/**
 * Seed a disposable local Supabase environment with two non-production users for
 * authenticated spatial-workspace screenshots.
 *
 * This script reads ALL credentials from environment variables and never embeds
 * passwords or keys. It is safe to commit.
 *
 * Required env:
 *   SPATIAL_SCREENSHOT_SUPABASE_URL       (defaults to NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL)
 *   SPATIAL_SCREENSHOT_SERVICE_ROLE_KEY   (defaults to SUPABASE_SERVICE_ROLE_KEY)
 *   SPATIAL_SCREENSHOT_OWNER_PASSWORD
 *   SPATIAL_SCREENSHOT_STAFF_PASSWORD
 * Optional env:
 *   SPATIAL_SCREENSHOT_COMPANY_ID
 *   SPATIAL_SCREENSHOT_OWNER_EMAIL
 *   SPATIAL_SCREENSHOT_STAFF_EMAIL
 */
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";

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
    throw new Error("Missing Supabase URL or service role key for screenshot seed.");
  }
  return {
    url,
    serviceRoleKey,
    companyId: process.env.SPATIAL_SCREENSHOT_COMPANY_ID || "00000000-0000-0000-0000-00000000515a",
    ownerEmail: process.env.SPATIAL_SCREENSHOT_OWNER_EMAIL || "owner-screenshot@singha.local",
    staffEmail: process.env.SPATIAL_SCREENSHOT_STAFF_EMAIL || "staff-screenshot@singha.local",
    ownerPassword: required("SPATIAL_SCREENSHOT_OWNER_PASSWORD"),
    staffPassword: required("SPATIAL_SCREENSHOT_STAFF_PASSWORD"),
  };
}

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

const STAFF_CAPS = ["operations.task.manage"];

async function ensureAuthUser(ctx, email, password) {
  const { data: list, error: listErr } = await ctx.supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);
  const existing = list.users.find((u) => u.email === email);
  if (existing) {
    const { data, error } = await ctx.supabase.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`Failed to update ${email}: ${error.message}`);
    return data.user;
  }
  const { data, error } = await ctx.supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`Failed to create ${email}: ${error.message}`);
  return data.user;
}

async function upsertProfile(ctx, userId, { username, fullName, department, isAdmin }) {
  const { error } = await ctx.supabase.from("profiles").upsert(
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

async function ensureRoles(ctx) {
  for (const key of ["spatial_owner", "spatial_staff"]) {
    const { error } = await ctx.supabase
      .from("roles")
      .upsert({ key, label: key.replace(/_/g, " ") }, { onConflict: "key" });
    if (error) throw new Error(`upsert role ${key}: ${error.message}`);
  }
  for (const cap of ALL_CAPS) {
    const { error } = await ctx.supabase
      .from("permissions")
      .upsert({ key: cap, label: cap }, { onConflict: "key" });
    if (error) throw new Error(`upsert permission ${cap}: ${error.message}`);
  }
  async function link(roleKey, caps) {
    for (const cap of caps) {
      const { error } = await ctx.supabase
        .from("role_permissions")
        .upsert({ role_key: roleKey, permission_key: cap }, { onConflict: "role_key,permission_key" });
      if (error) throw new Error(`link ${roleKey} -> ${cap}: ${error.message}`);
    }
  }
  await link("spatial_owner", ALL_CAPS);
  await link("spatial_staff", STAFF_CAPS);
}

async function assignMembership(ctx, userId, roleKey) {
  const { data: existing } = await ctx.supabase
    .from("memberships")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("user_id", userId)
    .maybeSingle();
  let membershipId = existing?.id;
  if (!membershipId) {
    const { data, error } = await ctx.supabase
      .from("memberships")
      .insert({ company_id: ctx.companyId, user_id: userId, status: "active" })
      .select("id")
      .single();
    if (error) throw new Error(`create membership: ${error.message}`);
    membershipId = data.id;
  }
  const { error } = await ctx.supabase
    .from("membership_roles")
    .upsert(
      { membership_id: membershipId, company_id: ctx.companyId, role_key: roleKey },
      { onConflict: "membership_id,role_key" },
    );
  if (error) throw new Error(`assign role ${roleKey}: ${error.message}`);
}

async function seedArrivals(ctx, ownerId, staffId) {
  await ctx.supabase.from("tasks").delete().ilike("title", "[screenshot]%").eq("company_id", ctx.companyId);
  await ctx.supabase.from("notifications").delete().ilike("title", "[screenshot]%").eq("company_id", ctx.companyId);

  const now = new Date().toISOString();
  const tasks = [
    {
      company_id: ctx.companyId,
      title: "[screenshot] Urgent evidence review",
      status: "blocked",
      priority: 1,
      due_date: "2026-08-25",
      created_by: ownerId,
      created_at: now,
    },
    {
      company_id: ctx.companyId,
      title: "[screenshot] Follow-up inspection",
      status: "in_progress",
      priority: 3,
      created_by: ownerId,
      created_at: now,
    },
  ];
  const { error: tErr } = await ctx.supabase.from("tasks").insert(tasks);
  if (tErr) throw new Error(`seed tasks: ${tErr.message}`);

  const { error: nErr } = await ctx.supabase.from("notifications").insert({
    company_id: ctx.companyId,
    recipient_id: ownerId,
    type: "task_assigned",
    title: "[screenshot] New task assigned",
    body: "A task was assigned to you for review.",
    is_read: false,
  });
  if (nErr) throw new Error(`seed notification: ${nErr.message}`);
}

export async function seedForScreenshots() {
  const config = getConfig();
  const supabase = createClient(config.url, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const ctx = { ...config, supabase };

  console.log("Seeding disposable screenshot users and data…");
  const owner = await ensureAuthUser(ctx, config.ownerEmail, config.ownerPassword);
  const staff = await ensureAuthUser(ctx, config.staffEmail, config.staffPassword);
  await ensureRoles(ctx);
  await upsertProfile(ctx, owner.id, {
    username: "screenshot-owner",
    fullName: "Screenshot Owner",
    department: "operations",
    isAdmin: true,
  });
  await upsertProfile(ctx, staff.id, {
    username: "screenshot-staff",
    fullName: "Screenshot Staff",
    department: "operations",
    isAdmin: false,
  });
  await assignMembership(ctx, owner.id, "spatial_owner");
  await assignMembership(ctx, staff.id, "spatial_staff");
  await seedArrivals(ctx, owner.id, staff.id);
  console.log("Seeding complete.");
  return { owner, staff, ...config };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedForScreenshots().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
