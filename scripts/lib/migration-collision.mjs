/**
 * Base-aware migration collision gate (product-recovery R0).
 *
 * The pre-existing `migration-lint` inspects ONE branch and asks whether its filenames are
 * well formed, unique and gapless. The 109-file recovery branch passes that check
 * perfectly and would still corrupt a database, because the defect is not visible from
 * inside a single branch: `main` and the branch each define a DIFFERENT migration under
 * the same number, and `scripts/migrate.mjs` keys `schema_migrations` on the four-digit
 * prefix alone.
 *
 * This module compares TWO migration sets — base (what the deployed line has) and head
 * (what this branch proposes) — and models what the runner would actually do. It is pure:
 * both inputs are `Array<{filename, content}>`, so the behavioural tests drive it with
 * synthetic sets.
 *
 * The five conditions it must fail on, and the finding each raises:
 *
 *   1. same migration number, different content .......... SAME_VERSION_DIFFERENT_CONTENT
 *   2. branch migration inserted below base high-water ... INSERTED_BELOW_HIGH_WATER
 *   3. renumbering changes dependency order .............. RENUMBER_BREAKS_DEPENDENCY_ORDER
 *   4. two filenames claiming one version ................ DUPLICATE_VERSION_IN_SET
 *   5. runner silently skips differing content ........... RUNNER_SILENT_SKIP
 *
 * A finding is an object `{code, severity, version, message, detail}`. `severity` is
 * `error` for everything that can corrupt a schema; callers exit non-zero on any error.
 */

import { buildInventory, resolveDependencies, runnerVersion, VERSION_RE } from "./migration-graph.mjs";

/** Group a file set by the version key the RUNNER would use (first four characters). */
function byRunnerVersion(files) {
  const map = new Map();
  for (const f of files) {
    const v = runnerVersion(f.filename);
    if (!map.has(v)) map.set(v, []);
    map.get(v).push(f);
  }
  return map;
}

function highWater(files) {
  let hw = null;
  for (const f of files) {
    const v = runnerVersion(f.filename);
    if (hw === null || v > hw) hw = v;
  }
  return hw;
}

/**
 * Compare a head (branch) migration set against a base (deployed line) migration set.
 *
 * `opts.renumberPlan` — optional `{ [oldVersion]: newVersion }` describing a proposed
 * renumbering of head migrations. When supplied it is validated against head's own
 * dependency graph, which is what catches a single-file rename that moves a migration
 * above its dependants.
 */
export function analyzeBranchAgainstBase(baseFiles, headFiles, opts = {}) {
  const findings = [];
  const push = (code, version, message, detail) =>
    findings.push({ code, severity: "error", version, message, ...(detail ? { detail } : {}) });

  const baseByVersion = byRunnerVersion(baseFiles);
  const headByVersion = byRunnerVersion(headFiles);

  // ── 4. Two different filenames claiming the same version, within either set ────────
  for (const [label, map] of [["base", baseByVersion], ["head", headByVersion]]) {
    for (const [version, files] of map) {
      if (files.length > 1) {
        push(
          "DUPLICATE_VERSION_IN_SET",
          version,
          `${label}: ${files.length} files claim version ${version} — the runner records one row and skips the rest`,
          { branch: label, filenames: files.map((f) => f.filename).sort() },
        );
      }
    }
  }

  // Malformed filenames: the runner's regex would not even pick these up.
  for (const f of headFiles) {
    if (!VERSION_RE.test(f.filename)) {
      push("MALFORMED_FILENAME", runnerVersion(f.filename), `head: ${f.filename} does not match NNNN_snake_name.sql`);
    }
  }

  const headRows = resolveDependencies(buildInventory(headFiles));
  const baseRows = buildInventory(baseFiles);
  const headByV = new Map(headRows.map((r) => [r.version, r]));
  const baseByV = new Map(baseRows.map((r) => [r.version, r]));

  // ── 1 + 5. Same version, different content → the runner silently skips it ─────────
  for (const [version, headRow] of headByV) {
    const baseRow = baseByV.get(version);
    if (!baseRow) continue;
    if (baseRow.sha256 === headRow.sha256) continue;

    const renamed = baseRow.filename !== headRow.filename;
    push(
      "SAME_VERSION_DIFFERENT_CONTENT",
      version,
      `version ${version} has different content on base and head` +
        (renamed ? ` (base: ${baseRow.filename}; head: ${headRow.filename})` : ` (${headRow.filename})`),
      {
        baseFilename: baseRow.filename,
        headFilename: headRow.filename,
        baseSha256: baseRow.sha256,
        headSha256: headRow.sha256,
      },
    );

    // The operational consequence, stated separately because it is the one that
    // corrupts a database rather than merely confusing a reader.
    const orphanedObjects = headRow.defines;
    const dependants = headRows
      .filter((r) => (r.dependsOn ?? []).some((d) => d.version === version))
      .map((r) => r.version)
      .sort();
    push(
      "RUNNER_SILENT_SKIP",
      version,
      `if base version ${version} is already recorded in schema_migrations, migrate.mjs would SKIP head's ` +
        `${headRow.filename} without error; ${orphanedObjects.length} object(s) would never be created and ` +
        `${dependants.length} later head migration(s) reference them`,
      { orphanedObjects, dependants, runnerKey: "filename.slice(0, 4)" },
    );
  }

  // ── 2. A head migration inserted at or below the base high-water mark ────────────
  const baseHighWater = highWater(baseFiles);
  if (baseHighWater !== null) {
    for (const [version, headRow] of headByV) {
      if (baseByV.has(version)) continue; // handled by 1/5 above
      if (version <= baseHighWater) {
        push(
          "INSERTED_BELOW_HIGH_WATER",
          version,
          `head adds ${headRow.filename} at version ${version}, at or below base high-water ${baseHighWater}; ` +
            `a database already migrated past ${baseHighWater} would never apply it`,
          { baseHighWater, headFilename: headRow.filename },
        );
      }
    }
  }

  // ── A base version that head no longer carries ───────────────────────────────────
  // Not an error: the runner never re-applies a recorded version, so nothing breaks at
  // apply time. It is still worth saying, because the repository then no longer describes
  // a migration that a deployed database has applied.
  for (const [version, baseRow] of baseByV) {
    if (headByV.has(version)) continue;
    findings.push({
      code: "BASE_VERSION_MISSING_FROM_HEAD",
      severity: "warning",
      version,
      message:
        `base carries ${baseRow.filename} at version ${version} and head does not; a database that ` +
        `applied it keeps its objects, but this branch no longer documents them`,
      detail: { baseFilename: baseRow.filename },
    });
  }

  // ── Head's own graph must never point forward ────────────────────────────────────
  // (A dependency on a higher-numbered migration cannot be satisfied at apply time.)
  for (const r of headRows) {
    for (const d of r.dependsOn ?? []) {
      if (d.version >= r.version) {
        push(
          "FORWARD_DEPENDENCY",
          r.version,
          `${r.filename} depends on ${d.version}, which is not below it`,
          { via: d.via },
        );
      }
    }
  }

  // ── 3. A proposed renumbering that reorders dependencies ────────────────────────
  if (opts.renumberPlan) {
    findings.push(...checkRenumberPlan(headRows, opts.renumberPlan));
  }

  return {
    findings,
    baseHighWater,
    headHighWater: highWater(headFiles),
    headRows,
    baseRows,
    ok: findings.every((f) => f.severity !== "error"),
  };
}

/**
 * Validate a proposed renumbering against the dependency graph it must preserve.
 *
 * This is the check that refuses a single-file rename. Moving one migration to the end of
 * the sequence without moving its dependants moves it ABOVE code that needs its objects,
 * so the objects are created after their first use. Order, not number, is what the runner
 * guarantees; a plan is safe only when every existing edge still runs low-to-high.
 *
 * `plan`: `{ [oldVersion]: newVersion }`. Versions are four-character strings. Migrations
 * absent from the plan keep their current version.
 */
export function checkRenumberPlan(headRows, plan) {
  const findings = [];
  const newVersion = (v) => plan[v] ?? v;

  // A plan must stay injective: two migrations landing on one version is condition 4
  // reintroduced by the fix itself.
  const landing = new Map();
  for (const r of headRows) {
    const nv = newVersion(r.version);
    if (!landing.has(nv)) landing.set(nv, []);
    landing.get(nv).push(r.version);
  }
  for (const [nv, olds] of landing) {
    if (olds.length > 1) {
      findings.push({
        code: "RENUMBER_COLLISION",
        severity: "error",
        version: nv,
        message: `renumber plan maps ${olds.sort().join(", ")} onto the same version ${nv}`,
        detail: { from: olds.sort(), to: nv },
      });
    }
  }

  // Every dependency edge must still point low-to-high after the plan is applied.
  for (const r of headRows) {
    for (const d of r.dependsOn ?? []) {
      const from = newVersion(d.version); // the dependency (must stay lower)
      const to = newVersion(r.version); // the dependant
      if (from >= to) {
        findings.push({
          code: "RENUMBER_BREAKS_DEPENDENCY_ORDER",
          severity: "error",
          version: r.version,
          message:
            `renumber plan moves ${d.version}→${from} and ${r.version}→${to}, but ${r.version} depends on ` +
            `${d.version}; after renumbering the dependency would run at or after its dependant`,
          detail: {
            dependant: { was: r.version, becomes: to, filename: r.filename },
            dependency: { was: d.version, becomes: from },
            via: d.via,
          },
        });
      }
    }
  }

  return findings;
}
