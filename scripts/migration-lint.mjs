#!/usr/bin/env node
/**
 * Migration lint (NEXT_PHASE_DEVELOPER_BRIEF §WP6.8 migration validation — the
 * filename/ordering half that needs no database). Enforces that
 * `src/db/migrations/*.sql` are the single, well-formed source of truth:
 *   - every file matches `NNNN_snake_name.sql`
 *   - numbers are unique (no two migrations share a number)
 *   - numbers are sequential from 0001 with no gaps
 * Exits non-zero on any violation. Run with `npm run migration-lint`.
 */
import { readdirSync } from "node:fs";

const DIR = "src/db/migrations";
const NAME_RE = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

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
