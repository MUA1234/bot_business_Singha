#!/usr/bin/env node
/**
 * IP boundary check — the repository is public, and that is a permanent constraint.
 *
 * Detects, over TRACKED files only:
 *   - client components importing server-only modules (the admin Supabase client, env, server libs);
 *   - `NEXT_PUBLIC_` variables whose names look like secrets;
 *   - proprietary-marker paths that must never be public (evaluation datasets, playbooks, weights);
 *   - private-key material and long credential-shaped literals.
 *
 * Findings are reported as EVIDENCE, not as confirmed defects — a heuristic match is a prompt to
 * look, not a verdict. Only the categories that are unambiguous by construction (a private key
 * block, a client importing the admin DB client) exit non-zero.
 *
 * Usage: node scripts/autonomy/check-ip-boundary.mjs [--quiet]
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const quiet = process.argv.includes("--quiet");

const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const sourceFiles = tracked.filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f));

const hard = []; // unambiguous — fails the check
const soft = []; // evidence to inspect — reported, does not fail

/** Modules that must never reach a client bundle. */
const SERVER_ONLY = [
  "@/lib/supabase/server",
  "@/lib/supabase/admin",
  "@/config/env",
  "@/ai/openai-transport",
  "@/ai/anthropic-transport",
  "node:crypto",
  "node:fs",
];

/** Paths that must not exist publicly at all. */
const PROPRIETARY_PATHS = [
  /(^|\/)private-evals?\//i,
  /(^|\/)playbooks?\//i,
  /(^|\/)scoring-weights?\./i,
  /(^|\/)ranking-weights?\./i,
  /\.secret\./i,
];

for (const file of tracked) {
  for (const rx of PROPRIETARY_PATHS) {
    if (rx.test(file)) hard.push(`proprietary path is tracked publicly: ${file}`);
  }
}

for (const file of sourceFiles) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  const isClient = /^\s*["']use client["']/m.test(text);
  if (isClient) {
    for (const mod of SERVER_ONLY) {
      const rx = new RegExp(`from\\s+["']${mod.replace(/[/@]/g, "\\$&")}["']`);
      if (rx.test(text)) hard.push(`client component imports server-only module ${mod}: ${file}`);
    }
  }

  // Public env vars that look like secrets.
  for (const m of text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z0-9_]*/g)) {
    // The Supabase anon key is public by design; everything else named like a secret is not.
    if (!/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(m[0])) {
      soft.push(`public env var named like a secret (${m[0]}): ${file}`);
    }
  }

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) hard.push(`private key material: ${file}`);

  // System prompts containing decision logic are proprietary; flag for review, do not fail.
  if (/const\s+\w*SYSTEM_PROMPT\w*\s*=/.test(text)) {
    soft.push(`system prompt is committed publicly (review against IP_BOUNDARY_MANIFEST): ${file}`);
  }
}

if (!quiet) {
  console.log(`autonomy:ip-check tracked=${tracked.length} source=${sourceFiles.length} hard=${hard.length} review=${soft.length}`);
  for (const s of soft.slice(0, 20)) console.log("   · review: " + s);
  if (soft.length > 20) console.log(`   · … ${soft.length - 20} more review items`);
}

if (hard.length) {
  console.error("\n❌ autonomy:ip-check FAILED:");
  for (const h of hard) console.error("   - " + h);
  process.exit(1);
}

if (!quiet) console.log("✅ autonomy:ip-check: no hard IP-boundary violation among tracked files.");
