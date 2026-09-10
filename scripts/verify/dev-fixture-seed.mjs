#!/usr/bin/env node
/**
 * DEVELOPMENT FIXTURE SEED — for a DISPOSABLE LOCAL Supabase only.
 *
 * Populates one clearly-labelled synthetic company across every domain, so the
 * REAL authenticated application can be rendered and inspected in a browser.
 * Users are created through the real GoTrue admin API and then sign in through
 * the real `/login` form — there is NO authentication bypass anywhere in this
 * harness, and nothing in the application is weakened to accommodate it.
 *
 * SAFETY, in order of strength:
 *
 *   1. It REFUSES to run unless the Supabase URL is loopback (127.0.0.1 /
 *      localhost / [::1]). A hosted or staging project cannot be seeded by this
 *      script even by accident.
 *   2. It REFUSES to run when APP_ENV is production.
 *   3. Every credential is read from the environment. Nothing is embedded, so
 *      this file is safe to commit and passes the repository secret scanner.
 *   4. The company name, every person, every counterparty and every reference is
 *      obviously synthetic and prefixed so it can never be mistaken for real
 *      business information in a screenshot.
 *
 * Required env:
 *   DEV_FIXTURE_SUPABASE_URL      (or NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL)
 *   DEV_FIXTURE_SERVICE_ROLE_KEY  (or SUPABASE_SERVICE_ROLE_KEY)
 *   DEV_FIXTURE_PASSWORD          — one password used for every fixture user
 *
 * The email domain MUST match USERNAME_EMAIL_DOMAIN in src/lib/constants.ts:
 * employees sign in with a username and the app maps it to <username>@<domain>,
 * so a fixture user on any other domain simply cannot sign in.
 *
 * Usage:
 *   node scripts/verify/dev-fixture-seed.mjs
 */
import { createClient } from "@supabase/supabase-js";

/* ── Guards ─────────────────────────────────────────────────────────────── */

const url =
  process.env.DEV_FIXTURE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL;
const serviceRoleKey =
  process.env.DEV_FIXTURE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const password = process.env.DEV_FIXTURE_PASSWORD;

if (!url || !serviceRoleKey) {
  console.error("dev-fixture-seed: DEV_FIXTURE_SUPABASE_URL and DEV_FIXTURE_SERVICE_ROLE_KEY are required.");
  process.exit(2);
}
if (!password) {
  console.error("dev-fixture-seed: DEV_FIXTURE_PASSWORD is required (never hard-coded).");
  process.exit(2);
}
if ((process.env.APP_ENV ?? "development") === "production") {
  console.error("dev-fixture-seed: refusing to run with APP_ENV=production.");
  process.exit(2);
}
{
  const host = new URL(url).hostname;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!loopback) {
    console.error(
      `dev-fixture-seed: refusing to seed a non-loopback Supabase host (${host}). ` +
        "This script is for a disposable LOCAL stack only.",
    );
    process.exit(2);
  }
}

const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

/* ── Deterministic identifiers ──────────────────────────────────────────── */

const CO = "0000f1de-0000-4000-8000-000000000001";
const id = (n) => `0000f1de-0000-4000-8000-${String(n).padStart(12, "0")}`;

const today = new Date();
const day = (offset) => {
  const d = new Date(today.getTime() + offset * 86_400_000);
  return d.toISOString().slice(0, 10);
};
const ts = (offsetHours) => new Date(today.getTime() + offsetHours * 3_600_000).toISOString();

/** Everything in this fixture wears this prefix, so a screenshot is unmistakable. */
const P = "FIXTURE";

const USERS = [
  {
    key: "owner",
    email: "fixture.owner@singha.local",
    username: "fixture.owner",
    fullName: "FIXTURE Owner (Priya D.)",
    department: "admin",
    isAdmin: true,
    roles: ["owner_management", "system_administrator"],
  },
  {
    key: "finance",
    email: "fixture.finance@singha.local",
    username: "fixture.finance",
    fullName: "FIXTURE Finance Lead (Rohan P.)",
    department: "finance",
    isAdmin: false,
    roles: ["finance_reviewer", "accountant", "payment_approver"],
  },
  {
    key: "staff",
    email: "fixture.staff@singha.local",
    username: "fixture.staff",
    fullName: "FIXTURE Site Supervisor (Nimal K.)",
    department: "operations",
    isAdmin: false,
    roles: ["staff_submitter", "project_manager"],
  },
  {
    key: "sales",
    email: "fixture.sales@singha.local",
    username: "fixture.sales",
    fullName: "FIXTURE Sales (Ayesha M.)",
    department: "sales",
    isAdmin: false,
    roles: ["staff_submitter"],
  },
];

async function upsert(table, rows, onConflict = "id") {
  if (!rows.length) return;
  const { error } = await db.from(table).upsert(rows, { onConflict });
  if (error) throw new Error(`${table}: ${error.message}`);
  console.log(`  ${table.padEnd(24)} ${rows.length}`);
}

/**
 * Insert into an APPEND-ONLY table. `audit_events` refuses UPDATE by design, so
 * an upsert cannot be used: on a repeat run the on-conflict clause would attempt
 * an update and be rejected. A duplicate key here simply means the rows are
 * already present from an earlier run, which is the desired end state.
 */
async function appendOnly(table, rows) {
  if (!rows.length) return;
  const { error } = await db.from(table).insert(rows);
  if (error && !/duplicate key|already exists/i.test(error.message)) {
    throw new Error(`${table}: ${error.message}`);
  }
  console.log(`  ${table.padEnd(24)} ${rows.length}${error ? " (already present)" : ""}`);
}

/** Create (or find) an auth user through the real GoTrue admin API. */
async function ensureAuthUser(email) {
  const { data: created, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (!error && created?.user) return created.user.id;
  // Already exists — find it and reset the password so the login form works.
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const found = list?.users?.find((u) => u.email === email);
  if (!found) throw new Error(`could not create or find auth user ${email}: ${error?.message}`);
  await db.auth.admin.updateUserById(found.id, { password, email_confirm: true });
  return found.id;
}

/**
 * Remove any previous run of THIS fixture before seeding.
 *
 * Deleting the fixture company cascades to every row that references it, and
 * the auth users are removed by id so the seed is repeatable — without it, a
 * changed email produces a new auth user whose profile collides with the old
 * one on the unique username. Scoped strictly to the fixture company and to
 * users whose email carries the fixture prefix; nothing else is touched.
 */
/**
 * Child-first sweep order. Not every table cascades from `companies`, and some
 * carry immutability triggers that (correctly) refuse to let an upsert rewrite a
 * stale row — `approval_requests.submitted_by` is one. Deleting rather than
 * overwriting keeps the seed repeatable without weakening any guard.
 */
const SWEEP = [
  "budget_lines", "budgets",
  "approval_actions", "approval_requests", "financial_events",
  "task_evidence", "task_check_ins", "task_assignments", "tasks",
  "project_scenarios", "project_decisions", "project_risks", "projects",
  "quotation_items", "price_confirmations", "quotations", "orders",
  "wa_messages", "wa_conversations", "opportunities",
  "customer_invoices", "supplier_bills", "payments", "commitments",
  "purchase_orders", "bank_accounts", "cash_accounts", "customers", "suppliers",
  "vehicle_documents", "maintenance_records", "vehicles", "drivers",
  "obligations", "contracts", "licences", "insurances", "risks", "incidents",
  "capacity_snapshots", "leave_requests", "employee_profiles",
  "membership_roles", "memberships",
  "documents", "notifications", "ai_runs",
  "profiles",
];

/**
 * Tables the WP12 delivery boundary refuses to let a non-owner delete from —
 * `message_outbox` rows may not be removed because doing so would orphan a
 * claimed delivery. The fixture therefore never sweeps them; its rows carry
 * deterministic ids and byte-identical content, so re-running upserts cleanly
 * without tripping the content freeze. This is the control working.
 */
const NO_DELETE = [
  "message_outbox", "audit_events", "journal_entries", "journal_lines",
  // Posted journals reference these, and a posted journal cannot be deleted,
  // so the accounting scaffolding is write-once too. Their seeds upsert.
  "accounting_periods", "fiscal_years", "chart_of_accounts",
];

async function resetFixture() {
  for (const table of SWEEP) {
    const { error } = await db.from(table).delete().eq("company_id", CO);
    if (error && !/does not exist|schema cache/i.test(error.message)) {
      throw new Error(`reset ${table}: ${error.message}`);
    }
  }
  await db.from("companies").delete().eq("id", CO);

  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const stale = (list?.users ?? []).filter((u) => (u.email ?? "").startsWith("fixture."));
  for (const u of stale) {
    await db.from("users").delete().eq("id", u.id);
    await db.auth.admin.deleteUser(u.id);
  }
  console.log(
    `  reset                    ${SWEEP.length} tables, ${stale.length} previous user(s)` +
      ` (${NO_DELETE.join(", ")} left intact — delivery boundary)`,
  );
}

async function main() {
  console.log(`dev-fixture-seed → ${url}`);
  await resetFixture();

  /* ── Company ──────────────────────────────────────────────────────────── */
  await upsert("companies", [
    {
      id: CO,
      name: `${P} — Northwind Placeholder (Pvt) Ltd`,
      legal_name: `${P} Northwind Placeholder Private Limited`,
      base_currency: "LKR",
      country: "LK",
      status: "active",
    },
  ]);

  /* ── People (real auth users) ─────────────────────────────────────────── */
  const uid = {};
  for (const u of USERS) uid[u.key] = await ensureAuthUser(u.email);
  console.log(`  auth users              ${USERS.length} (real GoTrue)`);

  await upsert(
    "profiles",
    USERS.map((u) => ({
      id: uid[u.key],
      company_id: CO,
      username: u.username,
      full_name: u.fullName,
      department: u.department,
      is_admin: u.isAdmin,
      is_active: true,
      job_title: u.fullName.replace(`${P} `, "").replace(/\s*\(.*\)$/, ""),
      skills: ["placeholder"],
    })),
  );

  // The identity model has its own `users` table (migration-era identity
  // unification); `memberships.user_id` references it, not `auth.users`. Both
  // rows carry the same id so the two models stay aligned.
  await upsert(
    "users",
    USERS.map((u) => ({ id: uid[u.key], email: u.email, full_name: u.fullName, is_active: true })),
  );

  const mid = {};
  USERS.forEach((u, i) => (mid[u.key] = id(100 + i)));
  await upsert(
    "memberships",
    USERS.map((u) => ({ id: mid[u.key], company_id: CO, user_id: uid[u.key], status: "active" })),
  );
  await upsert(
    "membership_roles",
    USERS.flatMap((u) => u.roles.map((r) => ({ membership_id: mid[u.key], company_id: CO, role_key: r }))),
    "membership_id,role_key",
  );
  await upsert(
    "employee_profiles",
    USERS.map((u) => ({
      membership_id: mid[u.key],
      company_id: CO,
      employment_status: "active",
      start_date: day(-500),
      contracted_weekly_hours: 40,
      reserved_weekly_hours: 4,
      skills: ["placeholder"],
    })),
    "membership_id",
  );

  /* ── Capacity: one person genuinely over, one under ───────────────────── */
  const weekStart = (() => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  })();
  await upsert(
    "capacity_snapshots",
    [
      { key: "staff", alloc: 46, status: "overloaded", util: 127.8 },
      { key: "finance", alloc: 30, status: "healthy", util: 83.3 },
      { key: "sales", alloc: 11, status: "underallocated", util: 30.6 },
      { key: "owner", alloc: 24, status: "healthy", util: 66.7 },
    ].map((r, i) => ({
      id: id(200 + i),
      company_id: CO,
      membership_id: mid[r.key],
      week_start: weekStart,
      total_hours: 40,
      net_capacity_hours: 36,
      allocated_hours: r.alloc,
      available_hours: 36 - r.alloc,
      utilization_pct: r.util,
      status: r.status,
    })),
  );

  await upsert("leave_requests", [
    {
      id: id(210),
      company_id: CO,
      profile_id: uid.staff,
      start_date: day(9),
      end_date: day(13),
      days: 5,
      reason: `${P} — family commitment`,
      status: "pending",
    },
    {
      id: id(211),
      company_id: CO,
      profile_id: uid.sales,
      start_date: day(21),
      end_date: day(22),
      days: 2,
      reason: `${P} — approved study leave`,
      status: "approved",
      decided_by: uid.owner,
      decided_at: ts(-72),
    },
  ]);

  /* ── Projects ─────────────────────────────────────────────────────────── */
  const PRJ_A = id(300);
  const PRJ_B = id(301);
  const PRJ_C = id(302);
  await upsert("projects", [
    { id: PRJ_A, company_id: CO, name: `${P} — Kandy site fit-out`, code: "FX-KDY-01", status: "active" },
    { id: PRJ_B, company_id: CO, name: `${P} — Depot automation`, code: "FX-DEP-02", status: "active" },
    { id: PRJ_C, company_id: CO, name: `${P} — Legacy migration`, code: "FX-LEG-03", status: "on_hold" },
  ]);

  await upsert("project_risks", [
    {
      id: id(310),
      company_id: CO,
      project_id: PRJ_A,
      title: `${P} — workshop inspection slot may slip`,
      description: "The only certified inspector is booked out for three weeks.",
      owner_id: uid.staff,
      mitigation: "Second inspector quoted; awaiting a price confirmation.",
      impact: "high",
      likelihood: "high",
      status: "open",
      review_date: day(4),
    },
    {
      id: id(311),
      company_id: CO,
      project_id: PRJ_A,
      title: `${P} — imported switchgear lead time`,
      impact: "critical",
      likelihood: "medium",
      status: "open",
      review_date: day(-2),
      mitigation: "Local equivalent identified but not yet approved.",
      owner_id: uid.owner,
    },
    {
      id: id(312),
      company_id: CO,
      project_id: PRJ_B,
      title: `${P} — depot access outside working hours`,
      impact: "medium",
      likelihood: "low",
      status: "mitigated",
      review_date: day(30),
    },
  ]);

  await upsert("project_decisions", [
    {
      id: id(320),
      company_id: CO,
      project_id: PRJ_A,
      title: `${P} — switchgear: import or source locally`,
      context: "Imported units carry an 11-week lead time; the local equivalent is 6% dearer.",
      options: [
        { id: "import", label: "Import the specified units (11 weeks)" },
        { id: "local", label: "Source the local equivalent (2 weeks, +6%)" },
      ],
      status: "pending",
    },
    {
      id: id(321),
      company_id: CO,
      project_id: PRJ_A,
      title: `${P} — first fix sequencing`,
      context: "Whether to run first fix before or after the inspection.",
      options: [
        { id: "before", label: "First fix before inspection" },
        { id: "after", label: "First fix after inspection" },
      ],
      decided_option_id: "after",
      rationale: "Re-work risk outweighed the two-week saving.",
      decided_by: uid.owner,
      decided_at: ts(-96),
      status: "decided",
    },
  ]);

  await upsert("project_scenarios", [
    {
      id: id(330),
      company_id: CO,
      project_id: PRJ_A,
      title: `${P} — Proceed now`,
      best_case_total: "4200000.00",
      expected_total: "4850000.00",
      worst_case_total: "6100000.00",
      currency: "LKR",
      chosen: false,
    },
    {
      id: id(331),
      company_id: CO,
      project_id: PRJ_A,
      title: `${P} — Defer six months`,
      best_case_total: "3900000.00",
      expected_total: "4400000.00",
      worst_case_total: "5200000.00",
      currency: "LKR",
      chosen: false,
    },
  ]);

  /* ── Work ─────────────────────────────────────────────────────────────── */
  const tasks = [
    ["Confirm delivery window with the switchgear supplier", "blocked", -6, PRJ_A, "staff", 1, "Supplier has not answered in 4 days"],
    ["Resolve the unmatched bank line from 14 Aug", "in_progress", -4, null, "finance", 1, null],
    ["Return the signed variation order", "in_progress", -2, PRJ_A, "staff", 2, null],
    ["Site survey — second depot bay", "blocked", 3, PRJ_B, "staff", 2, "Awaiting site access permit"],
    ["Issue monthly customer statements", "scheduled", 1, null, "finance", 2, null],
    ["Close the August accounting period", "awaiting_estimate", 2, null, "finance", 1, null],
    ["Supplier performance review — Q3", "planned", 4, null, "owner", 3, null],
    ["Fleet fuel reconciliation", "scheduled", 5, null, "staff", 3, null],
    ["Capacity plan for next month", "captured", 6, null, "owner", 3, null],
    ["Commission the depot conveyor", "in_progress", 12, PRJ_B, "staff", 2, null],
    ["Draft the handover pack", "planned", 18, PRJ_A, "staff", 3, null],
    ["Quarterly insurance renewal filed", "completed", -3, null, "owner", 3, null],
    ["New starter onboarding pack", "completed", -5, null, "owner", 4, null],
    ["Verify first-fix evidence", "verification", 0, PRJ_A, "staff", 1, null],
    ["Update the price catalogue", "awaiting_evidence", 7, null, "sales", 3, null],
  ];
  await upsert(
    "tasks",
    tasks.map(([title, status, due, project, owner, priority, blocker], i) => ({
      id: id(400 + i),
      company_id: CO,
      project_id: project,
      title: `${P} — ${title}`,
      description:
        "Synthetic fixture task used to render the real application. It carries no business meaning.",
      status,
      priority,
      requires_evidence: status === "verification" || status === "awaiting_evidence",
      estimate_hours: 6 + (i % 5) * 2,
      actual_hours: status === "completed" ? 8 : status === "in_progress" ? 3 : null,
      remaining_hours: status === "in_progress" ? 5 : null,
      due_date: day(due),
      blocker_reason: blocker,
      created_by: uid.owner,
      assigned_to: uid[owner],
      updated_at: ts(-(i + 1) * 3),
    })),
  );

  await upsert(
    "task_assignments",
    tasks.slice(0, 10).map((t, i) => ({
      id: id(430 + i),
      task_id: id(400 + i),
      company_id: CO,
      membership_id: mid[t[4]],
      estimate_hours: 6 + (i % 5) * 2,
      accepted: true,
    })),
  );

  await upsert("task_check_ins", [
    { id: id(450), task_id: id(413), company_id: CO, note: `${P} — first fix complete on bays 1–3`, progress_pct: 70, created_by: uid.staff, created_at: ts(-20) },
    { id: id(451), task_id: id(413), company_id: CO, note: `${P} — photographs attached`, progress_pct: 85, created_by: uid.staff, created_at: ts(-4) },
    { id: id(452), task_id: id(401), company_id: CO, note: `${P} — traced to a duplicated reference`, progress_pct: 40, created_by: uid.finance, created_at: ts(-9) },
  ]);

  /* ── Evidence documents ───────────────────────────────────────────────── */
  await upsert(
    "documents",
    [
      ["first-fix-bay-1.jpg", "image/jpeg", 842_113, "clean"],
      ["first-fix-bay-2.jpg", "image/jpeg", 911_004, "clean"],
      ["delivery-note-4471.pdf", "application/pdf", 128_442, "clean"],
      ["supplier-invoice-SB-2041.pdf", "application/pdf", 204_881, "pending"],
      ["site-access-permit.pdf", "application/pdf", 96_233, "clean"],
      ["variation-order-signed.pdf", "application/pdf", 311_902, "clean"],
    ].map(([name, mime, size, scan], i) => ({
      id: id(460 + i),
      company_id: CO,
      storage_path: `${CO}/f1de${String(i).padStart(12, "0")}-${name}`,
      mime_type: mime,
      byte_size: size,
      content_hash: `f1de${String(i).padStart(60, "0")}`,
      scanned_status: scan,
      created_by: uid.staff,
      created_at: ts(-(i + 1) * 18),
    })),
  );

  await upsert("task_evidence", [
    { id: id(470), task_id: id(413), company_id: CO, kind: "photo", reference: "first-fix-bay-1.jpg", document_id: id(460), verified_by: uid.owner },
    { id: id(471), task_id: id(413), company_id: CO, kind: "photo", reference: "first-fix-bay-2.jpg", document_id: id(461), verified_by: uid.owner },
    { id: id(472), task_id: id(400), company_id: CO, kind: "document", reference: "delivery-note-4471.pdf", document_id: id(462) },
  ]);

  /* ── Money ────────────────────────────────────────────────────────────── */
  await upsert("bank_accounts", [
    { id: id(500), company_id: CO, name: `${P} — Operating account`, account_number: "•••• 4417", currency: "LKR", opening_balance: "5250000.00", gl_account_code: "1010" },
    { id: id(501), company_id: CO, name: `${P} — Payroll account`, account_number: "•••• 9082", currency: "LKR", opening_balance: "1800000.00", gl_account_code: "1011" },
  ]);
  await upsert("cash_accounts", [
    { id: id(510), company_id: CO, name: `${P} — Site petty cash`, currency: "LKR", opening_balance: "125000.00", gl_account_code: "1000" },
  ]);

  const CUST = [id(520), id(521), id(522), id(523)];
  await upsert("customers", [
    { id: CUST[0], company_id: CO, name: `${P} — Highland Tea Exports`, email: "ap@highland.invalid", phone: "+94770000001" },
    { id: CUST[1], company_id: CO, name: `${P} — Colombo Freight Co`, email: "accounts@cfc.invalid", phone: "+94770000002" },
    { id: CUST[2], company_id: CO, name: `${P} — Galle Marine Services`, phone: "+94770000003" },
    { id: CUST[3], company_id: CO, name: `${P} — Ceylon Retail Group`, phone: "+94770000004" },
  ]);

  const SUPP = [id(530), id(531), id(532)];
  await upsert("suppliers", [
    { id: SUPP[0], company_id: CO, name: `${P} — Lanka Switchgear (Pvt) Ltd`, email: "sales@lswitch.invalid", compliance_status: "verified", insurance_status: "valid", insurance_expiry: day(120) },
    { id: SUPP[1], company_id: CO, name: `${P} — Metro Builders`, compliance_status: "pending", insurance_status: "expired", insurance_expiry: day(-20) },
    { id: SUPP[2], company_id: CO, name: `${P} — Island Logistics`, compliance_status: "verified", insurance_status: "valid", insurance_expiry: day(200) },
  ]);

  await upsert("customer_invoices", [
    { id: id(540), company_id: CO, customer_id: CUST[0], invoice_number: `${P}-INV-1041`, currency: "LKR", issue_date: day(-75), due_date: day(-45), total_amount: "1240000.00", amount_settled: "0.00", status: "issued" },
    { id: id(541), company_id: CO, customer_id: CUST[1], invoice_number: `${P}-INV-1042`, currency: "LKR", issue_date: day(-40), due_date: day(-10), total_amount: "684000.00", amount_settled: "184000.00", status: "part_paid" },
    { id: id(542), company_id: CO, customer_id: CUST[2], invoice_number: `${P}-INV-1043`, currency: "LKR", issue_date: day(-14), due_date: day(16), total_amount: "2310000.00", amount_settled: "0.00", status: "issued" },
    { id: id(543), company_id: CO, customer_id: CUST[3], invoice_number: `${P}-INV-1044`, currency: "LKR", issue_date: day(-5), due_date: day(25), total_amount: "455000.00", amount_settled: "0.00", status: "issued" },
  ]);

  await upsert("supplier_bills", [
    { id: id(550), company_id: CO, supplier_id: SUPP[0], bill_number: `${P}-SB-2041`, currency: "LKR", issue_date: day(-44), due_date: day(-14), total_amount: "1840000.00", amount_settled: "0.00", status: "approved" },
    { id: id(551), company_id: CO, supplier_id: SUPP[1], bill_number: `${P}-SB-2044`, currency: "LKR", issue_date: day(-28), due_date: day(2), total_amount: "312500.00", amount_settled: "0.00", status: "approved" },
    { id: id(552), company_id: CO, supplier_id: SUPP[2], bill_number: `${P}-SB-2048`, currency: "LKR", issue_date: day(-9), due_date: day(21), total_amount: "96000.00", amount_settled: "48000.00", status: "part_paid" },
  ]);

  await upsert("payments", [
    { id: id(560), company_id: CO, direction: "out", party_type: "supplier", party_id: SUPP[2], currency: "LKR", amount: "48000.00", method: "bank_transfer", payment_date: day(-6), bank_account_id: id(500), status: "recorded", correlation_id: "fixture-pay-1", idempotency_key: "fixture-pay-1" },
    { id: id(561), company_id: CO, direction: "in", party_type: "customer", party_id: CUST[1], currency: "LKR", amount: "184000.00", method: "bank_transfer", payment_date: day(-8), bank_account_id: id(500), status: "recorded", correlation_id: "fixture-pay-2", idempotency_key: "fixture-pay-2" },
  ]);

  await upsert("commitments", [
    { id: id(570), company_id: CO, description: `${P} — Depot conveyor stage payment`, counterparty: `${P} — Lanka Switchgear`, currency: "LKR", amount: "1150000.00", committed_date: day(-20), expected_settlement_date: day(11), status: "open" },
    { id: id(571), company_id: CO, description: `${P} — Annual software licences`, counterparty: `${P} — Vendor`, currency: "LKR", amount: "410000.00", committed_date: day(-60), expected_settlement_date: day(34), status: "open" },
  ]);

  await upsert("purchase_orders", [
    { id: id(580), company_id: CO, supplier_id: SUPP[0], po_number: `${P}-PO-0188`, currency: "LKR", total_amount: "1840000.00", status: "sent", expected_payment_date: day(7) },
    { id: id(581), company_id: CO, supplier_id: SUPP[2], po_number: `${P}-PO-0191`, currency: "LKR", total_amount: "265000.00", status: "sent", expected_payment_date: day(19) },
  ]);

  /* ── The accounting core ──────────────────────────────────────────────
   * Without a chart of accounts, periods and posted journals, the trial
   * balance, P&L and balance sheet render an honest but uninformative "no
   * posted journals yet" — which cannot demonstrate whether dense accounting
   * surfaces stay usable. Each journal below balances exactly. */
  await upsert("chart_of_accounts", [
    ["1000", "Cash on hand", "asset"], ["1010", "Bank — operating", "asset"],
    ["1011", "Bank — payroll", "asset"], ["1100", "Trade receivables", "asset"],
    ["1200", "Inventory", "asset"], ["2000", "Trade payables", "liability"],
    ["2100", "Accruals", "liability"], ["3000", "Retained earnings", "equity"],
    ["4000", "Revenue — projects", "income"], ["4010", "Revenue — services", "income"],
    ["5000", "Materials", "expense"], ["5010", "Subcontractors", "expense"],
    ["5020", "Fuel and transport", "expense"], ["5030", "Staff costs", "expense"],
    ["5040", "Insurance", "expense"],
  ].map(([code, name, type], i) => ({
    id: id(900 + i), company_id: CO, code, name, type, is_active: true,
  })), "company_id,code");

  const FY = id(950);
  await upsert("fiscal_years", [
    { id: FY, company_id: CO, name: `${P} FY2026`, start_date: day(-240), end_date: day(125), status: "open" },
  ]);

  const PERIODS = [
    { id: id(960), name: `${P} 2026-06`, start: -90, end: -61, status: "closed" },
    { id: id(961), name: `${P} 2026-07`, start: -60, end: -31, status: "closed" },
    { id: id(962), name: `${P} 2026-08`, start: -30, end: -1, status: "open" },
  ];
  await upsert(
    "accounting_periods",
    PERIODS.map((p) => ({
      id: p.id, company_id: CO, fiscal_year_id: FY, name: p.name,
      start_date: day(p.start), end_date: day(p.end), status: p.status,
    })),
  );

  // Balanced double-entry journals: each has equal debits and credits.
  const JOURNALS = [
    { n: 0, period: id(960), date: -75, memo: "Project revenue invoiced", lines: [["1100", "1240000.00", "0"], ["4000", "0", "1240000.00"]] },
    { n: 1, period: id(961), date: -44, memo: "Materials purchased on credit", lines: [["5000", "1840000.00", "0"], ["2000", "0", "1840000.00"]] },
    { n: 2, period: id(961), date: -40, memo: "Services invoiced", lines: [["1100", "684000.00", "0"], ["4010", "0", "684000.00"]] },
    { n: 3, period: id(962), date: -14, memo: "Project revenue invoiced", lines: [["1100", "2310000.00", "0"], ["4000", "0", "2310000.00"]] },
    { n: 4, period: id(962), date: -9, memo: "Subcontractor costs", lines: [["5010", "96000.00", "0"], ["2000", "0", "96000.00"]] },
    { n: 5, period: id(962), date: -8, memo: "Customer receipt", lines: [["1010", "184000.00", "0"], ["1100", "0", "184000.00"]] },
    { n: 6, period: id(962), date: -6, memo: "Supplier part payment", lines: [["2000", "48000.00", "0"], ["1010", "0", "48000.00"]] },
    { n: 7, period: id(962), date: -5, memo: "Fuel and transport", lines: [["5020", "128500.00", "0"], ["1000", "0", "128500.00"]] },
    { n: 8, period: id(962), date: -3, memo: "Insurance premium", lines: [["5040", "410000.00", "0"], ["1010", "0", "410000.00"]] },
  ];
  // A posted journal and its lines are IMMUTABLE — the ledger refuses to let
  // anything rewrite history, which is exactly the guarantee an accounting core
  // exists to give. The fixture therefore posts the way the application does:
  // create the entry as a draft, write its lines, then move it to posted. On a
  // repeat run the journals already exist and are left untouched.
  // Check for posted LINES, not entries: a run that failed between creating the
  // entry and writing its lines would otherwise leave empty posted journals that
  // can never be completed (they are immutable) and would be skipped forever.
  const { data: existingLines } = await db
    .from("journal_lines").select("id").eq("company_id", CO).limit(1);

  if ((existingLines?.length ?? 0) > 0) {
    console.log("  journal_entries          already posted — left untouched (immutable)");
  } else {
    await upsert(
      "journal_entries",
      JOURNALS.map((j) => {
        const total = j.lines.reduce((s, l) => s + Number(l[1]) + Number(l[2]), 0) / 2;
        return {
          id: id(1000 + j.n), company_id: CO, period_id: j.period, posting_date: day(j.date),
          currency: "LKR", exchange_rate: 1, memo: `${P} — ${j.memo}`, status: "draft",
          correlation_id: `fixture-jnl-${j.n}`, idempotency_key: `fixture-jnl-${j.n}`,
          total_debit: total.toFixed(2), total_credit: total.toFixed(2),
          created_by: uid.finance,
        };
      }),
    );
    await upsert(
      "journal_lines",
      JOURNALS.flatMap((j) =>
        j.lines.map(([code, debit, credit], k) => ({
          id: id(1100 + j.n * 4 + k), journal_id: id(1000 + j.n), company_id: CO,
          account_code: code, debit, credit, line_no: k + 1,
          description: `${P} — ${j.memo}`,
          project_id: j.n === 1 || j.n === 4 ? PRJ_A : null,
        })),
      ),
    );
    for (const j of JOURNALS) {
      const { error } = await db
        .from("journal_entries")
        .update({ status: "posted", posted_at: ts(j.date * 24), posted_by: uid.finance })
        .eq("id", id(1000 + j.n));
      if (error) throw new Error(`journal post ${j.n}: ${error.message}`);
    }
    console.log(`  journal_entries          ${JOURNALS.length} posted`);
  }

  const BUDGET = id(1200);
  await upsert("budgets", [
    { id: BUDGET, company_id: CO, name: `${P} FY2026 operating budget`, fiscal_year_id: FY, currency: "LKR" },
  ]);
  await upsert(
    "budget_lines",
    [
      ["5000", PRJ_A, "2000000.00"], ["5010", PRJ_A, "600000.00"],
      ["5020", null, "400000.00"], ["5030", null, "3200000.00"],
      ["5040", null, "500000.00"],
    ].flatMap(([code, project, amount], i) =>
      PERIODS.map((p, k) => ({
        id: id(1210 + i * 4 + k), budget_id: BUDGET, company_id: CO,
        account_code: code, project_id: project, period_id: p.id,
        amount: (Number(amount) / 3).toFixed(2),
      })),
    ),
  );

  /* ── Approvals: two pending, one submitted by finance so the owner may act ── */
  await upsert("financial_events", [
    { id: id(590), company_id: CO, event_type: "supplier_payment", state: "awaiting_approval", amount: "1840000.00", currency: "LKR", transaction_date: day(-1), counterparty_name: `${P} — Lanka Switchgear (Pvt) Ltd`, purpose: "First fix materials — bill SB-2041", payment_method: "bank_transfer", correlation_id: "fixture-fe-1", confidence_overall: 0.94 },
    { id: id(591), company_id: CO, event_type: "expense_claim", state: "awaiting_approval", amount: "48250.00", currency: "LKR", transaction_date: day(-2), counterparty_name: `${P} — Site fuel`, purpose: "Site travel, week 34", payment_method: "cash", correlation_id: "fixture-fe-2", confidence_overall: 0.71 },
    { id: id(592), company_id: CO, event_type: "supplier_payment", state: "approved", amount: "265000.00", currency: "LKR", transaction_date: day(-12), counterparty_name: `${P} — Island Logistics`, purpose: "Delivery charges", payment_method: "bank_transfer", correlation_id: "fixture-fe-3" },
  ]);

  await upsert("approval_requests", [
    { id: id(600), company_id: CO, financial_event_id: id(590), status: "pending", approvals_required: 2, submitted_by: uid.finance, submitted_by_source: "human", created_at: ts(-96) },
    { id: id(601), company_id: CO, financial_event_id: id(591), status: "pending", approvals_required: 1, submitted_by: uid.staff, submitted_by_source: "human", created_at: ts(-30) },
    { id: id(602), company_id: CO, financial_event_id: id(592), status: "approved", approvals_required: 1, submitted_by: uid.finance, submitted_by_source: "human", created_at: ts(-300) },
  ]);
  await upsert("approval_actions", [
    { id: id(610), approval_request_id: id(602), company_id: CO, actor_user_id: uid.owner, action: "approve", note: "Within delegated limit." },
  ]);

  /* ── CRM & communications ─────────────────────────────────────────────── */
  const CONV = [id(620), id(621), id(622), id(623), id(624)];
  await upsert("wa_conversations", [
    { id: CONV[0], company_id: CO, customer_wa_id: "94770000001", customer_name: `${P} — Highland Tea Exports`, status: "awaiting_price", last_inbound_at: ts(-3), updated_at: ts(-3) },
    { id: CONV[1], company_id: CO, customer_wa_id: "94770000002", customer_name: `${P} — Colombo Freight Co`, status: "quoted", last_inbound_at: ts(-30), updated_at: ts(-26) },
    { id: CONV[2], company_id: CO, customer_wa_id: "94770000003", customer_name: `${P} — Galle Marine Services`, status: "collecting", last_inbound_at: ts(-2), updated_at: ts(-2) },
    { id: CONV[3], company_id: CO, customer_wa_id: "94770000004", customer_name: `${P} — Ceylon Retail Group`, status: "quoting", last_inbound_at: ts(-200), updated_at: ts(-200) },
    { id: CONV[4], company_id: CO, customer_wa_id: "94770000005", customer_name: `${P} — Dormant Enquiry`, status: "closed", last_inbound_at: ts(-1400), updated_at: ts(-1400) },
  ]);

  const msgs = [
    [CONV[0], "in", "Good morning — can you quote for 40 units of the 3-phase board, delivered to Kandy?", -6],
    [CONV[0], "out", "Good morning. Noted — 40 units, 3-phase board, delivery to Kandy. Confirming the price with our team now.", -5],
    [CONV[0], "in", "Thank you. We need it before the end of the month if possible.", -3],
    [CONV[1], "in", "Please send the quotation for the depot racking.", -34],
    [CONV[1], "out", "Quotation FX-QT-0188 has been sent to your email.", -26],
    [CONV[2], "in", "Do you handle marine-grade enclosures?", -2],
    [CONV[3], "in", "We are reviewing internally and will revert.", -200],
  ];
  await upsert(
    "wa_messages",
    msgs.map(([conv, dir, body, h], i) => ({
      id: id(630 + i),
      conversation_id: conv,
      company_id: CO,
      direction: dir === "in" ? "inbound" : "outbound",
      body,
      wa_message_id: `fixture-wamid-${i}`,
      created_at: ts(h),
    })),
  );

  await upsert("orders", [
    { id: id(650), company_id: CO, conversation_id: CONV[0], customer_name: `${P} — Highland Tea Exports`, customer_phone: "+94770000001", customer_address: "FIXTURE address, Kandy", customer_email: "ap@highland.invalid", request_text: "40 units 3-phase board, delivered Kandy", status: "new" },
    { id: id(651), company_id: CO, conversation_id: CONV[1], customer_name: `${P} — Colombo Freight Co`, customer_phone: "+94770000002", request_text: "Depot racking", status: "quoted" },
  ]);

  // WP12 delivery boundary (migrations 0063–0066): a non-trusted writer may
  // create a quotation ONLY in its initial state, and the privileged delivery
  // transitions (ready→queued→sent) are reachable only through the service-only
  // atomic RPCs. The fixture therefore CANNOT manufacture a "sent" quotation —
  // and that is the control working, not an obstacle to work around. Both rows
  // are created as `draft` and then moved through the ordinary editing
  // transitions the application itself uses.
  await upsert("quotations", [
    { id: id(660), company_id: CO, order_id: id(650), quote_number: `${P}-QT-0190`, currency: "LKR", status: "draft", subtotal: "0.00", tax_amount: "0.00", total: "0.00", public_token: "f1xture-token-awaiting-price", notes: "Synthetic fixture quotation." },
    { id: id(661), company_id: CO, order_id: id(651), quote_number: `${P}-QT-0188`, currency: "LKR", status: "draft", subtotal: "1980000.00", tax_amount: "356400.00", total: "2336400.00", public_token: "f1xture-token-ready", notes: "Synthetic fixture quotation." },
  ]);

  await upsert("quotation_items", [
    { id: id(670), quotation_id: id(660), company_id: CO, description: `${P} — 3-phase distribution board`, quantity: 40, currency: "LKR", status: "needs_confirmation" },
    { id: id(671), quotation_id: id(661), company_id: CO, description: `${P} — Heavy duty racking bay`, quantity: 12, unit_price: "165000.00", line_total: "1980000.00", currency: "LKR", status: "priced" },
  ]);

  // Ordinary pre-delivery editing transitions, applied after the items exist so
  // the item-freeze and total-consistency guards see a coherent quotation.
  for (const [qid, status] of [
    [id(660), "awaiting_price"],
    [id(661), "ready"],
  ]) {
    const { error } = await db.from("quotations").update({ status }).eq("id", qid);
    if (error) {
      console.log(`  quotations               ${qid} → ${status} refused: ${error.message}`);
    }
  }
  console.log("  quotations               lifecycle advanced (delivery states remain RPC-only)");

  await upsert("price_confirmations", [
    { id: id(680), company_id: CO, quotation_id: id(660), quotation_item_id: id(670), department: "sales", description: `${P} — 3-phase distribution board ×40`, quantity: 40, currency: "LKR", ai_suggested_price: "142000.00", status: "open" },
    { id: id(681), company_id: CO, quotation_id: id(660), quotation_item_id: id(670), department: "finance", description: `${P} — delivery to Kandy`, quantity: 1, currency: "LKR", status: "open" },
  ]);

  await upsert("opportunities", [
    { id: id(690), company_id: CO, title: `${P} — Highland annual supply agreement`, amount: "8400000.00", currency: "LKR", probability: 40, expected_close: day(45), status: "open" },
    { id: id(691), company_id: CO, title: `${P} — Galle marine enclosures`, amount: "1250000.00", currency: "LKR", probability: 20, expected_close: day(70), status: "open" },
  ]);

  /* ── Governance ───────────────────────────────────────────────────────── */
  await upsert("licences", [
    { id: id(700), company_id: CO, name: `${P} — Electrical contractor licence`, authority: "FIXTURE Authority", licence_number: "FX-EL-2231", issue_date: day(-330), expiry_date: day(6), status: "active" },
    { id: id(701), company_id: CO, name: `${P} — Goods transport permit`, authority: "FIXTURE Authority", licence_number: "FX-TR-8890", issue_date: day(-700), expiry_date: day(-11), status: "active" },
    { id: id(702), company_id: CO, name: `${P} — Premises trade licence`, authority: "FIXTURE Council", expiry_date: day(210), status: "active" },
  ]);
  await upsert("contracts", [
    { id: id(710), company_id: CO, title: `${P} — Northwind × Highland supply agreement`, counterparty: `${P} — Highland Tea Exports`, start_date: day(-400), end_date: day(330), renewal_date: day(28), status: "active" },
    { id: id(711), company_id: CO, title: `${P} — Depot lease`, counterparty: `${P} — Metro Properties`, start_date: day(-900), end_date: day(-30), renewal_date: day(-30), status: "active" },
  ]);
  await upsert("insurances", [
    { id: id(720), company_id: CO, policy_name: `${P} — Public liability`, insurer: "FIXTURE Insurers", policy_number: "FX-PL-771", cover_amount: "50000000.00", currency: "LKR", expiry_date: day(88), status: "active" },
    { id: id(721), company_id: CO, policy_name: `${P} — Motor fleet`, insurer: "FIXTURE Insurers", policy_number: "FX-MF-118", cover_amount: "12000000.00", currency: "LKR", expiry_date: day(-4), status: "active" },
  ]);
  await upsert("obligations", [
    { id: id(730), company_id: CO, contract_id: id(710), description: `${P} — Submit quarterly volume report`, due_date: day(3), status: "open", obligation_type: "contractual" },
    { id: id(731), company_id: CO, description: `${P} — File statutory annual return`, due_date: day(-7), status: "open", obligation_type: "statutory" },
    { id: id(732), company_id: CO, description: `${P} — Renew depot fire certificate`, due_date: day(40), status: "open", obligation_type: "statutory" },
  ]);
  await upsert("risks", [
    { id: id(740), company_id: CO, title: `${P} — Single supplier for switchgear`, description: "No qualified second source approved.", owner_id: uid.owner, mitigation: "Second supplier under compliance review.", review_date: day(9), status: "open" },
    { id: id(741), company_id: CO, title: `${P} — Depot lease has lapsed its renewal date`, owner_id: uid.owner, review_date: day(-1), status: "open" },
  ]);
  await upsert("incidents", [
    { id: id(750), company_id: CO, title: `${P} — Near miss: unsecured load at depot`, description: "Load shifted during loading; no injury.", occurred_at: ts(-120), severity: "high", status: "open", corrective_action: "Toolbox talk scheduled." },
  ]);

  /* ── Assets ───────────────────────────────────────────────────────────── */
  const VEH = [id(760), id(761), id(762), id(763)];
  await upsert("vehicles", [
    { id: VEH[0], company_id: CO, registration_no: "FX-1234", make: "FIXTURE", model: "Panel Van", year: 2021, status: "active", odometer: 84210 },
    { id: VEH[1], company_id: CO, registration_no: "FX-5678", make: "FIXTURE", model: "Flatbed", year: 2019, status: "active", odometer: 154880 },
    { id: VEH[2], company_id: CO, registration_no: "FX-9012", make: "FIXTURE", model: "Pickup", year: 2023, status: "maintenance", odometer: 22140 },
    { id: VEH[3], company_id: CO, registration_no: "FX-3456", make: "FIXTURE", model: "Site Buggy", year: 2018, status: "retired", odometer: 61002 },
  ]);
  await upsert("drivers", [
    { id: id(770), company_id: CO, name: `${P} — Driver A`, licence_number: "FX-D-001", licence_expiry: day(14), phone: "+94770000010", status: "active" },
    { id: id(771), company_id: CO, name: `${P} — Driver B`, licence_number: "FX-D-002", licence_expiry: day(-3), phone: "+94770000011", status: "active" },
    { id: id(772), company_id: CO, name: `${P} — Driver C`, licence_number: "FX-D-003", licence_expiry: day(300), status: "active" },
  ]);
  await upsert("vehicle_documents", [
    { id: id(780), company_id: CO, vehicle_id: VEH[0], doc_type: "insurance", reference: "FX-MF-118", expiry_date: day(-4) },
    { id: id(781), company_id: CO, vehicle_id: VEH[1], doc_type: "registration", reference: "FX-REG-5678", expiry_date: day(17) },
    { id: id(782), company_id: CO, vehicle_id: VEH[2], doc_type: "emission", reference: "FX-EM-9012", expiry_date: day(120) },
  ]);
  await upsert("maintenance_records", [
    { id: id(790), company_id: CO, vehicle_id: VEH[1], kind: "service", description: `${P} — 150,000 km service`, cost: "88000.00", currency: "LKR", service_date: day(-60), next_service_date: day(9) },
    { id: id(791), company_id: CO, vehicle_id: VEH[2], kind: "repair", description: `${P} — gearbox`, cost: "410000.00", currency: "LKR", service_date: day(-5), next_service_date: day(175) },
  ]);

  /* ── Platform: AI runs, audit, outbox, notifications ──────────────────── */
  await upsert(
    "ai_runs",
    [
      ["manager_observation", true, 0.0182, 0.91],
      ["manager_observation", true, 0.0164, 0.88],
      ["quote_extraction", true, 0.0051, 0.96],
      ["quote_extraction", false, 0.0049, 0.42],
      ["receipt_extraction", true, 0.0073, 0.79],
      ["manager_observation", true, 0.0201, 0.85],
      ["receipt_extraction", false, 0.0068, 0.38],
    ].map(([route, ok, cost, conf], i) => ({
      id: `fixture-airun-${i}`,
      company_id: CO,
      route,
      model: "fixture-model-v1",
      prompt_version: "fx-2026-08",
      input_tokens: 1200 + i * 90,
      output_tokens: 300 + i * 20,
      cost_usd: String(cost),
      validation_ok: ok,
      confidence_overall: conf,
      latency_ms: 900 + i * 120,
      correlation_id: `fixture-cor-${i}`,
      created_at: ts(-(i + 1) * 7),
    })),
    "id",
  );

  await appendOnly(
    "audit_events",
    [
      ["user", "approval.approved", "approval_request", id(602)],
      ["ai", "task.captured", "task", id(408)],
      ["system", "outbox.sent", "message_outbox", id(800)],
      ["user", "project.decision.recorded", "project_decision", id(321)],
      ["ai", "management_case.raised", "management_case", id(590)],
      ["system", "period.closed", "accounting_period", id(810)],
      ["user", "employee.created", "profile", "fixture"],
      ["ai", "quotation.priced", "quotation", id(661)],
    ].map(([actor, action, entity, eid], i) => ({
      id: id(820 + i),
      company_id: CO,
      actor_type: actor,
      actor_id: actor === "user" ? "fixture.owner" : actor,
      action,
      entity_type: entity,
      entity_id: String(eid),
      correlation_id: `fixture-audit-${i}`,
      created_at: ts(-(i + 1) * 9),
    })),
  );

  await upsert("notifications", [
    { id: id(840), company_id: CO, recipient_id: uid.owner, type: "approval", title: `${P} — A payment of LKR 1,840,000 needs your decision`, body: "Raised by the finance lead 4 days ago.", link: "/app/finance/approvals", is_read: false, created_at: ts(-96) },
    { id: id(841), company_id: CO, recipient_id: uid.owner, type: "risk", title: `${P} — A licence expires in 6 days`, body: "Electrical contractor licence FX-EL-2231.", link: "/app/legal/licences", is_read: false, created_at: ts(-20) },
    { id: id(842), company_id: CO, recipient_id: uid.owner, type: "task", title: `${P} — Two tasks became blocked`, link: "/app/operations/tasks", is_read: false, created_at: ts(-8) },
    { id: id(843), company_id: CO, recipient_id: uid.owner, type: "system", title: `${P} — Inbound queue drained`, is_read: true, created_at: ts(-40) },
    { id: id(844), company_id: CO, recipient_id: uid.staff, type: "task", title: `${P} — You were assigned a site survey`, link: "/app/me", is_read: false, created_at: ts(-14) },
  ]);

  await upsert("message_outbox", [
    { id: id(800), company_id: CO, channel: "whatsapp", recipient: "94770000002", body: `${P} — Your quotation FX-QT-0188 is attached.`, idempotency_key: "fixture-outbox-1", status: "sent", attempts: 1, sent_at: ts(-26) },
    { id: id(801), company_id: CO, channel: "whatsapp", recipient: "94770000001", body: `${P} — Confirming your enquiry.`, idempotency_key: "fixture-outbox-2", status: "pending", attempts: 0 },
    { id: id(802), company_id: CO, channel: "whatsapp", recipient: "94770000009", body: `${P} — Undeliverable test message.`, idempotency_key: "fixture-outbox-3", status: "failed", attempts: 4, last_error: "FIXTURE: recipient not on WhatsApp" },
  ]);

  console.log("\ndev-fixture-seed: done.");
  console.log(`  company: ${CO}`);
  for (const u of USERS) console.log(`  ${u.key.padEnd(8)} ${u.email}`);
}

main().catch((e) => {
  console.error("dev-fixture-seed failed:", e.message);
  process.exit(1);
});
