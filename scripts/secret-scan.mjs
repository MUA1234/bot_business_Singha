#!/usr/bin/env node
/**
 * Secret scan (NEXT_PHASE_DEVELOPER_BRIEF §WP6 required CI gate "secret scanning").
 *
 * Scans git-TRACKED files for high-confidence real-secret shapes and exits non-zero if
 * any are found. Patterns are deliberately narrow (long/structured) so short test
 * fixtures (e.g. `sk-abcdefghijklmno`, `EAA` + a few chars) do NOT trip it. Run in CI
 * before build; run locally with `npm run secret-scan`.
 */
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

// High-confidence secret patterns. Kept narrow to avoid false positives on test fakes.
const PATTERNS = [
  { name: "OpenAI project key", re: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI secret key", re: /sk-[A-Za-z0-9]{40,}/ },
  { name: "Meta long-lived token", re: /EAA[A-Za-z0-9]{80,}/ },
  { name: "Supabase/JWT service key", re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { name: "service-role key assignment", re: /SERVICE_ROLE_KEY\s*[:=]\s*['"][^'"]{20,}['"]/ },
  { name: "known leaked DB password", re: /MUAmusic1234/ },
  { name: "known leaked admin password", re: /Singha1234/ },
];

// Files that legitimately contain secret-SHAPED patterns (redaction regexes, this scan).
const ALLOW = new Set(["src/lib/log.ts", "scripts/secret-scan.mjs"]);

function trackedFiles() {
  return execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
}

function isProbablyText(path) {
  try {
    if (statSync(path).size > 2_000_000) return false; // skip huge files
  } catch {
    return false;
  }
  return !/\.(png|jpg|jpeg|gif|svg|pdf|ico|woff2?|ttf|eot|zip|gz)$/i.test(path);
}

const findings = [];
for (const file of trackedFiles()) {
  if (ALLOW.has(file) || !isProbablyText(file)) continue;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = content.split("\n");
  for (const { name, re } of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) findings.push({ file, line: i + 1, name });
    }
  }
}

if (findings.length) {
  console.error(`❌ secret-scan: ${findings.length} potential secret(s) found:`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  (${f.name})`);
  console.error("\nRemove the secret, rotate it, and never commit credentials (CLAUDE.md).");
  process.exit(1);
}

console.log("✅ secret-scan: no tracked secrets found.");
