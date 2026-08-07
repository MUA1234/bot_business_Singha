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
const highs = Object.entries(vulns).filter(([, v]) => ["high", "critical"].includes(v.severity)).map(([name]) => name);

const unexpected = [];
const expired = [];
for (const name of highs) {
  const ex = acceptedByModule.get(name);
  if (!ex) unexpected.push(name);
  else if (ex.review_by && ex.review_by < today) expired.push(`${name} (review_by ${ex.review_by} passed)`);
}

// Warn about accepted exceptions that no longer correspond to a live finding (stale).
const stale = [...acceptedByModule.keys()].filter((m) => !highs.includes(m));

if (unexpected.length || expired.length) {
  if (unexpected.length) console.error("❌ audit-check: unexpected high/critical vulns (not in approved exceptions):", unexpected.join(", "));
  if (expired.length) console.error("❌ audit-check: EXPIRED accepted exceptions:", expired.join(", "));
  console.error("   Fix them, or update security/approved-audit-exceptions.json after review.");
  process.exit(1);
}

console.log(`✅ audit-check: ${highs.length} high/critical finding(s), all covered by current approved exceptions${highs.length ? ` (${highs.join(", ")})` : ""}.`);
if (stale.length) console.log(`ℹ️  note: approved exceptions no longer matching a live finding (safe to remove): ${stale.join(", ")}`);
