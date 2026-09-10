#!/usr/bin/env node
/**
 * Migration lint (NEXT_PHASE_DEVELOPER_BRIEF §WP6.8 migration validation — the
 * filename/ordering half that needs no database). Enforces that
 * `src/db/migrations/*.sql` are the single, well-formed source of truth:
 *   - every file matches `NNNN_snake_name.sql`
 *   - numbers are unique (no two migrations share a number)
 *   - numbers are sequential from 0001 with no gaps
 *
 * BASE-AWARE MODE (`--base <ref>`, product-recovery R0). The checks above inspect ONE
 * branch and cannot see the defect that actually corrupts databases: `main` and a feature
 * branch each defining a DIFFERENT migration under the SAME number. `scripts/migrate.mjs`
 * keys `schema_migrations` on the four-digit prefix, so the second one is silently
 * skipped and every later migration runs against a schema missing its objects. With
 * `--base` this command additionally compares the working tree against a base ref and
 * fails on that class. See `lib/migration-collision.mjs` for the five conditions.
 *
 * Exits non-zero on any violation. Run with `npm run migration-lint`, or
 * `npm run migration-collision-check` for the base-aware gate.
 */
import { readdirSync } from "node:fs";
import { analyzeBranchAgainstBase } from "./lib/migration-collision.mjs";
import { readMigrationsAtRef, readMigrationsFromWorkingTree, refExists, resolveSha } from "./lib/migration-git.mjs";

const DIR = "src/db/migrations";
const NAME_RE = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

const argv = process.argv.slice(2);
const flagValue = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const baseRef = argv.includes("--base") ? flagValue("--base", "origin/main") : null;
/** Missing base ref is fatal by default; shallow CI clones may pass --allow-missing-base. */
const allowMissingBase = argv.includes("--allow-missing-base");

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const errors = [];

const numbers = [];
for (const f of files) {
  const m = f.match(NAME_RE);
  if (!m) {
    errors.push(`bad filename: ${f} (expected NNNN_snake_name.sql)`);
    continue;
  }
  numbers.push({ n: Number(m[1]), f });
}

// Duplicate numbers.
const seen = new Map();
for (const { n, f } of numbers) {
  if (seen.has(n)) errors.push(`duplicate migration number ${String(n).padStart(4, "0")}: ${seen.get(n)} and ${f}`);
  else seen.set(n, f);
}

// Sequential from 1 with no gaps.
const sorted = [...seen.keys()].sort((a, b) => a - b);
for (let i = 0; i < sorted.length; i++) {
  const expected = i + 1;
  if (sorted[i] !== expected) {
    errors.push(`gap/ordering: expected ${String(expected).padStart(4, "0")} but found ${String(sorted[i]).padStart(4, "0")}`);
    break;
  }
}

if (errors.length) {
  console.error(`❌ migration-lint: ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

console.log(`✅ migration-lint: ${numbers.length} migrations, sequential 0001–${String(sorted[sorted.length - 1] ?? 0).padStart(4, "0")}, no gaps or duplicates.`);

// ── Base-aware collision gate ───────────────────────────────────────────────────────
if (baseRef) {
  if (!refExists(baseRef)) {
    const msg = `migration-lint: base ref '${baseRef}' does not resolve in this clone (fetch it, or pass --base <ref>)`;
    if (allowMissingBase) {
      console.warn(`⚠️  ${msg} — skipped by --allow-missing-base.`);
      process.exit(0);
    }
    console.error(`❌ ${msg}`);
    console.error("   Refusing to report a collision-free result that was never checked.");
    process.exit(2);
  }

  const baseFiles = readMigrationsAtRef(baseRef);
  const headFiles = readMigrationsFromWorkingTree(DIR);
  const result = analyzeBranchAgainstBase(baseFiles, headFiles);

  const label = `${baseRef} @ ${resolveSha(baseRef).slice(0, 8)}`;
  const errors = result.findings.filter((f) => f.severity === "error");
  const warnings = result.findings.filter((f) => f.severity !== "error");

  // Warnings are reported whether or not the gate fails; silence would be misleading.
  for (const w of warnings) {
    console.warn(`⚠️  [${w.code}] version ${w.version}: ${w.message}`);
  }

  if (result.ok) {
    console.log(
      `✅ migration-collision: no collision against ${label} ` +
        `(base high-water ${result.baseHighWater}, head high-water ${result.headHighWater})` +
        (warnings.length ? `; ${warnings.length} warning(s) above.` : "."),
    );
    process.exit(0);
  }

  console.error(`\n❌ migration-collision: ${errors.length} error(s) against ${label}:`);
  for (const f of errors) {
    console.error(`\n  [${f.code}] version ${f.version}`);
    console.error(`    ${f.message}`);
    if (f.detail?.dependants?.length) {
      console.error(`    dependants: ${f.detail.dependants.join(", ")}`);
    }
    if (f.detail?.orphanedObjects?.length) {
      const o = f.detail.orphanedObjects;
      console.error(`    objects never created (${o.length}): ${o.slice(0, 6).join(", ")}${o.length > 6 ? ", …" : ""}`);
    }
  }
  console.error(
    "\n  A collision is resolved by renumbering the whole dependent SEQUENCE in order, " +
      "never by renaming one file: see docs/product-recovery/r0-integration/02-MIGRATION-DECISION-TREE.md.",
  );
  process.exit(1);
}
