#!/usr/bin/env node
/**
 * Migration dependency inventory (product-recovery R0, item 1).
 *
 * Emits a machine-readable matrix of every migration on the base branch and the head
 * branch: number, filename, SHA-256, branch, objects created/altered, dependencies on
 * earlier migrations, and later migrations that reference its objects.
 *
 * READ-ONLY. It touches git and the working tree only; it opens no database connection
 * and reads no hosted state.
 *
 * Usage:
 *   node scripts/migration-inventory.mjs                      # JSON to stdout
 *   node scripts/migration-inventory.mjs --out docs/x.json    # JSON to a file
 *   node scripts/migration-inventory.mjs --markdown           # human-readable summary
 *   node scripts/migration-inventory.mjs --focus 0069         # dependants of one version
 *   node scripts/migration-inventory.mjs --base origin/main   # choose the base ref
 *
 * The dependency edges come from a conservative DDL scan (see `lib/migration-graph.mjs`).
 * An absent edge is "no dependency proven", never "proven independent".
 */

import { writeFileSync } from "node:fs";
import { buildInventory, resolveDependencies, transitiveDependents } from "./lib/migration-graph.mjs";
import { readMigrationsAtRef, readMigrationsFromWorkingTree, refExists, resolveSha } from "./lib/migration-git.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes(name);

const baseRef = flag("--base", "origin/main");
const focus = flag("--focus", null);
const outPath = flag("--out", null);

if (!refExists(baseRef)) {
  console.error(`❌ migration-inventory: base ref '${baseRef}' does not resolve in this clone.`);
  console.error("   Fetch it first (git fetch origin) or pass --base <ref>.");
  process.exit(2);
}

const headSha = resolveSha("HEAD");
const baseSha = resolveSha(baseRef);

const baseRows = resolveDependencies(buildInventory(readMigrationsAtRef(baseRef)));
const headRows = resolveDependencies(buildInventory(readMigrationsFromWorkingTree()));

/** Strip the internal mention set (large, and not part of the published matrix). */
const publish = (rows, branch) =>
  rows.map((r) => ({
    number: Number.isNaN(r.number) ? null : r.number,
    version: r.version,
    filename: r.filename,
    branch,
    sha256: r.sha256,
    bytes: r.bytes,
    wellFormed: r.wellFormed,
    objects: r.definesDetail.map((d) => ({ kind: d.kind, name: d.name, ...(d.anonymous ? { anonymous: true } : {}) })),
    dependsOn: r.dependsOn,
    dependedOnBy: r.dependedOnBy,
  }));

// Cross-branch reconciliation: which versions exist on both, and do they agree?
const baseByV = new Map(baseRows.map((r) => [r.version, r]));
const headByV = new Map(headRows.map((r) => [r.version, r]));
const reconciliation = [];
for (const v of new Set([...baseByV.keys(), ...headByV.keys()].sort())) {
  const b = baseByV.get(v);
  const h = headByV.get(v);
  reconciliation.push({
    version: v,
    base: b ? { filename: b.filename, sha256: b.sha256 } : null,
    head: h ? { filename: h.filename, sha256: h.sha256 } : null,
    status:
      b && h
        ? b.sha256 === h.sha256
          ? "identical"
          : b.filename === h.filename
            ? "same_filename_different_content"
            : "COLLISION_different_migration_same_number"
        : b
          ? "base_only"
          : "head_only",
  });
}

const report = {
  generatedBy: "scripts/migration-inventory.mjs",
  readOnly: true,
  base: { ref: baseRef, sha: baseSha, migrationCount: baseRows.length },
  head: { ref: "HEAD", sha: headSha, migrationCount: headRows.length },
  method: {
    dependencyEdges:
      "conservative DDL scan; an absent edge means 'no dependency proven', never 'proven independent'",
    hashNormalisation: "CRLF normalised to LF before hashing",
    runnerVersionKey: "filename.slice(0, 4) — exactly as scripts/migrate.mjs computes it",
  },
  reconciliation,
  migrations: { base: publish(baseRows, baseRef), head: publish(headRows, "HEAD") },
};

if (focus) {
  const version = String(focus).padStart(4, "0");
  const t = transitiveDependents(headRows, version);
  const row = headByV.get(version);
  report.focus = {
    version,
    branch: "HEAD",
    filename: row?.filename ?? null,
    objectsDefined: row ? row.definesDetail.length : 0,
    directDependents: t.direct,
    transitiveDependents: t.all,
    dependentCount: t.all.length,
  };
}

const json = JSON.stringify(report, null, 2);

if (outPath && typeof outPath === "string") {
  writeFileSync(outPath, json + "\n");
  console.log(`✅ migration-inventory: wrote ${outPath}`);
  console.log(`   base ${baseRef} @ ${baseSha.slice(0, 8)} — ${baseRows.length} migrations`);
  console.log(`   head HEAD @ ${headSha.slice(0, 8)} — ${headRows.length} migrations`);
  const collisions = reconciliation.filter((r) => r.status.startsWith("COLLISION"));
  if (collisions.length) {
    console.log(`   ⚠️  ${collisions.length} version collision(s): ${collisions.map((c) => c.version).join(", ")}`);
  }
} else if (has("--markdown")) {
  const lines = [];
  lines.push(`# Migration inventory — ${baseRef} @ ${baseSha.slice(0, 8)} vs HEAD @ ${headSha.slice(0, 8)}`);
  lines.push("");
  lines.push(`Base migrations: ${baseRows.length} · Head migrations: ${headRows.length}`);
  lines.push("");
  lines.push("| Version | Base file | Head file | Status |");
  lines.push("|---|---|---|---|");
  for (const r of reconciliation) {
    if (r.status === "identical") continue;
    lines.push(`| ${r.version} | ${r.base?.filename ?? "—"} | ${r.head?.filename ?? "—"} | ${r.status} |`);
  }
  if (report.focus) {
    lines.push("");
    lines.push(`## Dependants of ${report.focus.version} (${report.focus.filename})`);
    lines.push("");
    lines.push(`Direct: ${report.focus.directDependents.join(", ") || "none"}`);
    lines.push("");
    lines.push(`Transitive (${report.focus.dependentCount}): ${report.focus.transitiveDependents.join(", ") || "none"}`);
  }
  console.log(lines.join("\n"));
} else {
  console.log(json);
}
