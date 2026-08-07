#!/usr/bin/env node
/**
 * Dependency-audit gate (WP F.2/F.7). Runs `npm audit --omit=dev` and FAILS if any
 * high/critical production vulnerability is present that is NOT in
 * security/approved-audit-exceptions.json, or if an accepted exception is past its
 * `review_by` date. This lets CI stay green on reviewed, compensated risks while still
 * blocking any NEW or EXPIRED high/critical finding.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function runAudit() {
  try {
    return execSync("npm audit --omit=dev --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // npm audit exits non-zero when vulnerabilities exist; the JSON is still on stdout.
    return e.stdout?.toString() ?? "";
  }
}

const raw = runAudit();
let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error("audit-check: could not parse `npm audit --json` output");
  process.exit(1);
}

const exceptions = JSON.parse(readFileSync("security/approved-audit-exceptions.json", "utf8"));
const acceptedByModule = new Map(exceptions.accepted.map((e) => [e.module, e]));
const today = new Date().toISOString().slice(0, 10);

const vulns = report.vulnerabilities ?? {};

// Key on ROOT-CAUSE advisories, not wrapper module names. Each finding's `via` array
// contains either advisory OBJECTS (a direct advisory on a real package — the root cause)
// or STRINGS (this package is only affected *through* another package). A module that is
// merely transitively affected (e.g. `inngest` via `next`, or `eslint-config-next` via
// `@next/eslint-plugin-next`) has no advisory object of its own, so it never introduces a
// new root cause — it's covered as long as the real vulnerable package is approved. This
// makes the gate robust to npm-version differences in how deduped transitive vulns are
// attributed.
const rootCauses = new Map(); // package name -> highest severity seen
for (const v of Object.values(vulns)) {
  for (const via of v.via ?? []) {
    if (via && typeof via === "object" && ["high", "critical"].includes(via.severity)) {
      rootCauses.set(via.name, via.severity);
    }
  }
}

const unexpected = [];
const expired = [];
for (const [name] of rootCauses) {
  const ex = acceptedByModule.get(name);
  if (!ex) unexpected.push(name);
  else if (ex.review_by && ex.review_by < today) expired.push(`${name} (review_by ${ex.review_by} passed)`);
}

// Approved exceptions that no longer correspond to a live root-cause advisory (stale).
const stale = [...acceptedByModule.keys()].filter((m) => !rootCauses.has(m));

if (unexpected.length || expired.length) {
  if (unexpected.length) console.error("❌ audit-check: unexpected high/critical advisories (not in approved exceptions):", unexpected.join(", "));
  if (expired.length) console.error("❌ audit-check: EXPIRED accepted exceptions:", expired.join(", "));
  console.error("   Fix them, or update security/approved-audit-exceptions.json after review.");
  process.exit(1);
}

const names = [...rootCauses.keys()];
console.log(`✅ audit-check: ${names.length} high/critical root-cause advisory(ies), all covered by approved exceptions${names.length ? ` (${names.join(", ")})` : ""}. Transitively-affected wrapper packages (e.g. inngest via next) are covered, not separate findings.`);
if (stale.length) console.log(`ℹ️  note: approved exceptions no longer matching a live advisory (safe to remove): ${stale.join(", ")}`);
