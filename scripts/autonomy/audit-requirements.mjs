#!/usr/bin/env node
/**
 * Requirement audit — the tripwire that stops a completion claim without evidence.
 *
 * FAILS (exit 1) when:
 *   - a requirement carries a completion status but lacks runtime entrypoint, tests or a tested SHA;
 *   - a status is not one of the permitted values;
 *   - a requirement is missing an id, title or status;
 *   - `--strict` is passed and any requirement is still absent / foundation_only /
 *     implementation_in_progress / implemented_unverified (i.e. the program is not code-complete).
 *
 * Always regenerates ORIGINAL_VISION_COVERAGE_MATRIX.md so the human-readable view cannot drift
 * from the register.
 *
 * Usage: node scripts/autonomy/audit-requirements.mjs [--strict] [--quiet]
 */
import { execFileSync, execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { loadRegister, validateRequirement, COMPLETE_STATUSES, groupOf } from "./requirements-lib.mjs";

/**
 * Every owner-approved requirement group. A group with ZERO records is a hard failure: the register
 * must never be able to look complete by leaving a group out.
 */
const APPROVED_GROUPS = [
  "FOUND", "INT", "MEM", "AIM", "GOV", "WRK", "PRJ", "FIN", "AST", "CRM",
  "SCH", "LNG", "COM", "CTL", "MOD", "IMP", "RSK", "MOB", "OPS", "IP",
  // Approved by the owner's Original Vision Reconciliation instruction, 2026-09-02, which directed
  // creating stable requirement IDs where no existing record accurately covered an original
  // requirement. Each group was added only after confirming the register had NO coverage:
  //   KRN — the reusable management kernel (the loop itself)
  //   WMP — work marketplace, opportunity/bidding window and its fairness guardrails
  //   CSA — customer-facing AI agents as a SEPARATE subsystem supervised through adapters
  //   PRC — procurement, suppliers and inventory (implemented in code, never registered)
  //   MKT — marketing and campaigns (implemented thinly, never registered)
  //   UX  — primary experience: spatial workspace with flat/reduced-motion/mobile fallbacks
  //   GTD — GPS, CCTV and attendance device integration, preserved as FUTURE owner-gated
  "KRN", "WMP", "CSA", "PRC", "MKT", "UX", "GTD",
];

/** Committed snapshot of known ids. A requirement may not vanish without an owner decision. */
const SNAPSHOT = "docs/autonomy/REQUIREMENT_IDS.snapshot";
const RETIRED = "docs/autonomy/RETIRED_REQUIREMENTS.txt";

const strict = process.argv.includes("--strict");
const quiet = process.argv.includes("--quiet");

const { requirements, pending } = loadRegister();
const problems = requirements.flatMap(validateRequirement);

// 1. `_pending_population` is no longer permitted — every approved group must be expanded.
if (pending.length > 0) {
  problems.push(
    `_pending_population is a HARD FAILURE: ${pending.length} group(s) still unexpanded — ${pending.join("; ")}`,
  );
}

// 2. Every approved group must carry at least one record.
const presentGroups = new Set(requirements.map((r) => groupOf(r.id)));
for (const g of APPROVED_GROUPS) {
  if (!presentGroups.has(g)) problems.push(`approved group ${g} has ZERO requirements in the register`);
}

// 3. Unknown group prefixes are a typo or an unapproved invention.
for (const g of presentGroups) {
  if (!APPROVED_GROUPS.includes(g)) problems.push(`requirement group "${g}" is not an approved group`);
}

// 4. A requirement may not disappear between revisions without a recorded owner decision.
const ids = requirements.map((r) => r.id).filter(Boolean).sort();
if (existsSync(SNAPSHOT)) {
  const previous = readFileSync(SNAPSHOT, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  const retired = existsSync(RETIRED)
    ? readFileSync(RETIRED, "utf8").split("\n").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean)
    : [];
  for (const id of previous) {
    if (!ids.includes(id) && !retired.includes(id)) {
      problems.push(`requirement ${id} DISAPPEARED from the register and is not listed in ${RETIRED} — an owner decision is required to retire a requirement`);
    }
  }
}

// 5. A cited commit must EXIST. A well-formed SHA that is not in this repository is not evidence.
//    Only checked when Git itself is usable here, so a shallow or Git-less checkout reports nothing
//    rather than inventing a failure.
let gitUsable = true;
try {
  execSync("git rev-parse HEAD", { stdio: "ignore" });
} catch {
  gitUsable = false;
}
if (gitUsable) {
  for (const r of requirements) {
    if (!COMPLETE_STATUSES.has(r.status)) continue;
    const sha = String(r.last_verified_sha ?? "").trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) continue; // already reported by validateRequirement
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    } catch {
      problems.push(`${r.id}: last_verified_sha ${sha} is not a commit in this repository`);
    }
  }
}

const byStatus = {};
for (const r of requirements) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

const complete = requirements.filter((r) => COMPLETE_STATUSES.has(r.status));
const notComplete = requirements.filter((r) => !COMPLETE_STATUSES.has(r.status));
/**
 * INCOMPLETE AND IMPLEMENTABLE — work this program can still do without an owner.
 *
 * `specified` belongs here. A specification is not an implementation: it describes what should be
 * built. Counting it outside the incomplete total let 5 requirements look settled when nothing had
 * been built for them, which is exactly the "documentation is not implementation" rule this audit
 * exists to enforce. Corrected on owner instruction.
 */
const IMPLEMENTABLE_INCOMPLETE = [
  "absent",
  "specified",
  "foundation_only",
  "implementation_in_progress",
  "implemented_unverified",
];
const unaccepted = requirements.filter((r) => IMPLEMENTABLE_INCOMPLETE.includes(r.status));
const blockedOwner = requirements.filter((r) => r.status === "blocked_owner");
const blockedExternal = requirements.filter((r) => r.status === "blocked_external");
const deferred = requirements.filter((r) => r.status === "deliberately_deferred");

// ── Coverage matrix (generated — do not hand-edit) ───────────────────────────────────────────
const groups = APPROVED_GROUPS.slice().sort();
const perGroup = groups.map((g) => {
  const inGroup = requirements.filter((r) => groupOf(r.id) === g);
  const done = inGroup.filter((r) => COMPLETE_STATUSES.has(r.status)).length;
  return `| ${g} | ${inGroup.length} | ${done} | ${inGroup.length - done} |`;
});
const rows = requirements
  .slice()
  .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  .map((r) => `| ${r.id} | ${r.title} | ${r.priority ?? "-"} | **${r.status}** | ${r.runtime_entrypoint || "—"} | ${r.last_verified_sha || "—"} | ${r.owner_gate && r.owner_gate !== "none" ? r.owner_gate : "—"} |`)
  .join("\n");

const matrix = `# Original Vision coverage matrix

> GENERATED by \`npm run autonomy:audit\` from \`ORIGINAL_VISION_REQUIREMENTS.yaml\`. Do not hand-edit.
> A status is only as good as the evidence columns beside it; the audit refuses a completion status
> with empty evidence.

Generated at: ${new Date().toISOString().slice(0, 10)}

## Totals

| Status | Count |
|---|---|
${Object.entries(byStatus)
  .sort((a, b) => b[1] - a[1])
  .map(([s, n]) => `| ${s} | ${n} |`)
  .join("\n")}

## Completion accounting

Reported in the four categories the owner requires. \`specified\` counts as INCOMPLETE — a
specification describes what should be built; it is not built.

| Category | Count |
|---|---|
| **Verified** (locally / preview / staging / production) | **${complete.length}** |
| **Incomplete and implementable** (absent + specified + foundation_only + in_progress + unverified) | **${unaccepted.length}** |
| **Blocked — owner** | **${blockedOwner.length}** |
| **Blocked — external** | **${blockedExternal.length}** |
| **Deliberately deferred** | **${deferred.length}** |
| Registered total | ${requirements.length} |

A blocked-owner requirement is excluded from autonomous implementation, but it still PREVENTS any
operating-mode claim that depends on it. Blocked is not done.

## Per approved group — no group is omitted from totals

| Group | Registered | Complete | Remaining |
|---|---|---|---|
${perGroup.join("\n")}

## Requirements

| ID | Title | Pri | Status | Runtime entrypoint | Verified SHA | Owner gate |
|---|---|---|---|---|---|---|
${rows}

## Groups not yet expanded into individual records

These are counted as **unregistered**, not as complete. Expanding them is register work, not a
completion claim.

${pending.map((p) => `- ${p}`).join("\n") || "_none_"}

## Honest reading of this table

The program is **not** code-complete while any requirement is \`absent\`, \`specified\`,
\`foundation_only\`, \`implementation_in_progress\` or \`implemented_unverified\`, or while any
group above remains unexpanded, or while any \`blocked_owner\` requirement gates a claimed operating
mode. Incomplete and implementable: **${unaccepted.length}**; blocked (owner): **${blockedOwner.length}**;
deferred: **${deferred.length}**; unexpanded groups: **${pending.length}**.
`;

writeFileSync("docs/autonomy/ORIGINAL_VISION_COVERAGE_MATRIX.md", matrix);

// Refresh the id snapshot ONLY when the register is otherwise valid, so a failing run cannot
// quietly bless a disappearance by overwriting the evidence of it.
if (problems.length === 0) writeFileSync(SNAPSHOT, ids.join("\n") + "\n");

// ── Report ───────────────────────────────────────────────────────────────────────────────────
if (!quiet) {
  console.log(
    `autonomy:audit registered=${requirements.length} verified=${complete.length} ` +
      `incomplete-implementable=${unaccepted.length} blocked-owner=${blockedOwner.length} ` +
      `blocked-external=${blockedExternal.length} deferred=${deferred.length} unexpanded-groups=${pending.length}`,
  );
  console.log(
    "  " +
      Object.entries(byStatus)
        .sort()
        .map(([s, n]) => `${s}=${n}`)
        .join(" "),
  );
}

if (problems.length) {
  console.error("\n❌ autonomy:audit FAILED — evidence problems:");
  for (const p of problems) console.error("   - " + p);
  process.exit(1);
}

if (strict && unaccepted.length > 0) {
  console.error(`\n❌ autonomy:audit --strict: not code-complete (${unaccepted.length} unaccepted requirement(s)).`);
  process.exit(1);
}

if (!quiet) console.log("✅ autonomy:audit: register is internally consistent; matrix regenerated.");
