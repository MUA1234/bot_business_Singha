#!/usr/bin/env node
/**
 * Session-start status: what the register says, what Git says, and whether they agree.
 * Read-only. Never writes, never fails the build — its job is to orient a resumed session.
 *
 * Usage: node scripts/autonomy/check-status.mjs
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { loadRegister, COMPLETE_STATUSES } from "./requirements-lib.mjs";

const STATE = "docs/autonomy/AUTONOMOUS_DEVELOPMENT_STATE.json";
const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const { requirements, pending } = loadRegister();
const complete = requirements.filter((r) => COMPLETE_STATUSES.has(r.status));
const blocked = requirements.filter((r) => String(r.status).startsWith("blocked_"));
const unaccepted = requirements.filter((r) =>
  ["absent", "foundation_only", "implementation_in_progress", "implemented_unverified"].includes(r.status),
);

const head = sh("git rev-parse --short HEAD");
const branch = sh("git rev-parse --abbrev-ref HEAD");
const dirty = sh("git status --porcelain").split("\n").filter(Boolean).length;
const migrations = existsSync("src/db/migrations")
  ? readdirSync("src/db/migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
  : [];

console.log("── Singha Central · autonomous development status ──");
console.log(`branch            ${branch}`);
console.log(`head              ${head}${dirty ? `  (working tree: ${dirty} change(s))` : "  (clean)"}`);
console.log(`latest migration  ${migrations.at(-1) ?? "none"}  (${migrations.length} total)`);

if (existsSync(STATE)) {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const known = state.lastGreenSha ? sh(`git cat-file -t ${state.lastGreenSha}`) === "commit" : false;
  console.log(`state phase       ${state.activePhase || "—"}`);
  console.log(`last green SHA    ${state.lastGreenSha || "—"}${state.lastGreenSha ? (known ? "  ✅ exists" : "  ❌ NOT FOUND in this repo") : ""}`);
  console.log(`next action       ${state.nextAction || "—"}`);
  if ((state.ownerGates ?? []).length) {
    console.log("owner gates:");
    for (const g of state.ownerGates) console.log(`   · ${g}`);
  }
} else {
  console.log(`state             ${STATE} is MISSING`);
}

console.log("");
console.log(`requirements      registered=${requirements.length} complete=${complete.length} unaccepted=${unaccepted.length} blocked=${blocked.length}`);
console.log(`unexpanded groups ${pending.length}`);
if (unaccepted.length) {
  console.log("next candidates (highest priority, unaccepted, no blocker):");
  const candidates = unaccepted
    .filter((r) => !r.blocker || r.blocker === "none")
    .sort((a, b) => String(a.priority).localeCompare(String(b.priority)))
    .slice(0, 5);
  for (const c of candidates) console.log(`   · ${c.id} [${c.priority}] ${c.title} — ${c.status}`);
}
console.log("");
console.log(
  complete.length === requirements.length && pending.length === 0
    ? "Register shows every REGISTERED requirement complete — this is NOT the same as code-complete until the groups above are expanded."
    : "NOT code-complete. Do not report the system as complete.",
);
