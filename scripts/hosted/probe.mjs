/**
 * HOSTED READ-ONLY PROBE — Singha production Supabase, via PostgREST.
 *
 * Runs under `railway run` so credentials arrive in the environment and are NEVER printed,
 * logged, or written to disk. This script prints only: migration ledger rows (deployment
 * metadata), and booleans for object existence.
 *
 * SAFETY PROPERTIES
 *   * every request is a GET;
 *   * object-existence probes use `limit=0`, so ZERO business rows are ever returned;
 *   * the only rows read are `schema_migrations` (version/filename/applied_at) — the
 *     migration ledger, which is deployment metadata, not customer or business data;
 *   * no RPC is called, nothing is written, no DDL, no migration.
 */

const URL_ = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !KEY) {
  console.error("MISSING_CREDENTIALS: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not in environment");
  process.exit(2);
}
// Prove we have them without revealing them.
console.log(`endpoint host: ${new URL(URL_).host}`);
console.log(`service key: present (${KEY.length} chars, never printed)`);
console.log("");

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: "application/json" };

async function get(path) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: H });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

/** Does a table exist and is it reachable? Returns zero rows. */
async function tableExists(name) {
  const r = await get(`${name}?select=*&limit=0`);
  return { present: r.status === 200, status: r.status };
}

/** Does a column exist? `limit=0` returns no rows; a bad column is a 400. */
async function columnExists(table, column) {
  const r = await get(`${table}?select=${column}&limit=0`);
  if (r.status === 200) return { present: true, status: 200 };
  if (r.status === 400) return { present: false, status: 400 };
  return { present: null, status: r.status, note: r.body?.message ?? r.body?.code ?? null };
}

const out = {};

// ── Q1/Q2/Q3 — the migration ledger ────────────────────────────────────────────────
console.log("=== Q1/Q2 — schema_migrations ===");
const ledger = await get("schema_migrations?select=version,filename,applied_at&order=version.asc");
out.ledgerStatus = ledger.status;
if (ledger.status !== 200) {
  console.log(`schema_migrations NOT readable via PostgREST — HTTP ${ledger.status}`);
  console.log("detail:", JSON.stringify(ledger.body));
  out.ledger = null;
} else {
  const rows = ledger.body ?? [];
  out.ledger = rows;
  console.log(`rows: ${rows.length}`);
  if (rows.length) {
    console.log(`lowest : ${rows[0].version}  ${rows[0].filename}`);
    console.log(`HIGH-WATER: ${rows[rows.length - 1].version}  ${rows[rows.length - 1].filename}`);
    console.log(`first applied: ${rows[0].applied_at}`);
    console.log(`last  applied: ${rows[rows.length - 1].applied_at}`);
    // Gaps.
    const nums = rows.map((r) => Number(r.version)).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i <= nums[nums.length - 1]; i++) if (!nums.includes(i)) gaps.push(String(i).padStart(4, "0"));
    out.gaps = gaps;
    console.log(`gaps: ${gaps.length ? gaps.join(", ") : "none"}`);
    // The 0069 row specifically.
    const r69 = rows.find((r) => r.version === "0069");
    out.row0069 = r69 ?? null;
    console.log(`0069 row: ${r69 ? `${r69.filename} @ ${r69.applied_at}` : "(ABSENT)"}`);
    console.log("");
    console.log("--- all rows ---");
    for (const r of rows) console.log(`  ${r.version}  ${r.filename}`);
  }
}
console.log("");

// ── Q4 — which 0069 is actually present? ───────────────────────────────────────────
console.log("=== Q4 — 0069 object markers ===");
const markers = {
  "main-0069: companies.whatsapp_phone_number_id": await columnExists("companies", "whatsapp_phone_number_id"),
  "main-0069: companies.default_price_confirmation_department": await columnExists("companies", "default_price_confirmation_department"),
  "branch-0069: source_events.next_attempt_at": await columnExists("source_events", "next_attempt_at"),
  "branch-0069: source_events.lease_owner": await columnExists("source_events", "lease_owner"),
  "branch-0069: source_events.dead_lettered_at": await columnExists("source_events", "dead_lettered_at"),
};
out.markers = {};
for (const [k, v] of Object.entries(markers)) {
  out.markers[k] = v.present;
  console.log(`  ${v.present === true ? "PRESENT" : v.present === false ? "absent " : "UNKNOWN"}  ${k}${v.note ? ` (${v.note})` : ""}`);
}
console.log("");

// ── Q5 — company-resolution designs ────────────────────────────────────────────────
console.log("=== Q5 — company resolution ===");
const q5 = {
  "table channel_accounts": await tableExists("channel_accounts"),
  "table channel_identities": await tableExists("channel_identities"),
};
out.q5 = {};
for (const [k, v] of Object.entries(q5)) {
  out.q5[k] = v.present;
  console.log(`  ${v.present ? "PRESENT" : "absent "}  ${k} (HTTP ${v.status})`);
}
console.log("");

// ── Q6 — is any of the 0069-0109 range already present? ────────────────────────────
console.log("=== Q6 — branch-range tables (27) ===");
const EXPECTED = [
  "ai_guide_messages", "ai_model_attempts", "ai_model_budget_policies", "channel_accounts",
  "channel_identities", "communication_preferences", "connectors", "duplicate_reviews",
  "funding_requirements", "inbound_reviews", "incidents", "insurances",
  "integration_command_contracts", "integration_event_contracts", "integrations", "investments",
  "management_directive_conflicts", "management_directives", "project_decisions", "project_risks",
  "project_scenarios", "push_subscriptions", "risks", "service_providers",
  "task_duplicate_suggestions", "task_routing", "task_routing_events",
];
const present = [];
for (const t of EXPECTED) {
  const r = await tableExists(t);
  if (r.present) present.push(t);
}
out.branchRangePresent = present;
console.log(`present: ${present.length} of ${EXPECTED.length}`);
if (present.length) console.log(`  ${present.join(", ")}`);
console.log("");

// ── Q6c — the quarantined R1 draft track must NOT be hosted ────────────────────────
console.log("=== Q6c — R1 draft quarantine ===");
for (const t of ["r1_draft_migrations", "management_kernel_enablement", "management_items"]) {
  const r = await tableExists(t);
  out[`draft_${t}`] = r.present;
  console.log(`  ${r.present ? "PRESENT ⚠" : "absent "}  ${t}`);
}
console.log("");

// ── Core schema sanity ─────────────────────────────────────────────────────────────
console.log("=== core tables ===");
for (const t of ["companies", "source_events", "quotations", "message_outbox", "journals", "tasks"]) {
  const r = await tableExists(t);
  console.log(`  ${r.present ? "PRESENT" : "absent "}  ${t} (HTTP ${r.status})`);
}

const { writeFileSync } = await import("node:fs");
writeFileSync("hosted-evidence.json", JSON.stringify(out, null, 2) + "\n");
console.log("\nwrote hosted-evidence.json (ledger + booleans only; no credentials, no business rows)");
