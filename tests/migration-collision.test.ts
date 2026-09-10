import { describe, it, expect } from "vitest";

// Untyped .mjs tooling modules — same dynamic-import pattern as
// `tests/campaign/requirement-audit.test.ts`.
const collision: any = await import("../scripts/lib/migration-collision.mjs" as string);
const graph: any = await import("../scripts/lib/migration-graph.mjs" as string);
const { analyzeBranchAgainstBase, checkRenumberPlan } = collision;
const { buildInventory, resolveDependencies, stripComments } = graph;

/**
 * Behavioural tests for the base-aware migration collision gate (product-recovery R0).
 *
 * These drive the analysis with SYNTHETIC main/branch migration sets rather than the real
 * 109-file tree, so each of the five failure conditions is exercised in isolation and the
 * suite keeps passing once the real collision is reconciled. The real tree is checked by
 * `npm run migration-collision-check`, which is a gate, not a test.
 */

type File = { filename: string; content: string };
const f = (filename: string, content: string): File => ({ filename, content });

const codes = (result: { findings: Array<{ code: string }> }) => result.findings.map((x) => x.code);

// A minimal, dependency-free base line.
const BASE_CLEAN: File[] = [
  f("0001_init.sql", "create table public.widgets (id uuid primary key);"),
  f("0002_more.sql", "alter table public.widgets add column if not exists label text;"),
];

describe("migration collision gate — clean cases", () => {
  it("passes when head only appends above the base high-water mark", () => {
    const head = [
      ...BASE_CLEAN,
      f("0003_new.sql", "create table public.gadgets (id uuid primary key);"),
    ];
    const result = analyzeBranchAgainstBase(BASE_CLEAN, head);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.baseHighWater).toBe("0002");
    expect(result.headHighWater).toBe("0003");
  });

  it("passes when head is identical to base", () => {
    const result = analyzeBranchAgainstBase(BASE_CLEAN, [...BASE_CLEAN]);
    expect(result.ok).toBe(true);
  });

  it("ignores a CRLF-only difference — the same committed bytes are the same migration", () => {
    const head = BASE_CLEAN.map((x) => f(x.filename, x.content.replace(/\n/g, "\r\n")));
    const result = analyzeBranchAgainstBase(BASE_CLEAN, head);
    expect(result.ok).toBe(true);
  });
});

describe("condition 1 + 5 — same version, different content, silently skipped", () => {
  // The real defect: base and head each define a DIFFERENT migration numbered 0003.
  const base = [...BASE_CLEAN, f("0003_base_thing.sql", "create table public.base_only (id uuid primary key);")];
  const head = [
    ...BASE_CLEAN,
    f("0003_head_thing.sql", "alter table public.widgets add column if not exists lease_owner text;"),
    f("0004_uses_it.sql", "create index if not exists w_lease_idx on public.widgets (lease_owner);"),
  ];

  it("reports the same number carrying different content", () => {
    const result = analyzeBranchAgainstBase(base, head);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("SAME_VERSION_DIFFERENT_CONTENT");
    const finding = result.findings.find((x: any) => x.code === "SAME_VERSION_DIFFERENT_CONTENT");
    expect(finding.version).toBe("0003");
    expect(finding.detail.baseFilename).toBe("0003_base_thing.sql");
    expect(finding.detail.headFilename).toBe("0003_head_thing.sql");
    expect(finding.detail.baseSha256).not.toBe(finding.detail.headSha256);
  });

  it("reports the runner silently skipping it, naming the orphaned objects and their dependants", () => {
    const result = analyzeBranchAgainstBase(base, head);
    const skip = result.findings.find((x: any) => x.code === "RUNNER_SILENT_SKIP");
    expect(skip).toBeDefined();
    expect(skip.version).toBe("0003");
    // The column head's 0003 adds would never exist...
    expect(skip.detail.orphanedObjects).toContain("column:public.widgets.lease_owner");
    // ...and 0004, which indexes that column, is named as the migration that would break.
    expect(skip.detail.dependants).toContain("0004");
    expect(skip.detail.runnerKey).toBe("filename.slice(0, 4)");
  });

  it("still reports a same-filename content change (an edited, already-applied migration)", () => {
    const edited = [...BASE_CLEAN.slice(0, 1), f("0002_more.sql", "alter table public.widgets add column if not exists other text;")];
    const result = analyzeBranchAgainstBase(BASE_CLEAN, edited);
    expect(codes(result)).toContain("SAME_VERSION_DIFFERENT_CONTENT");
  });
});

describe("condition 2 — inserted below the base high-water mark", () => {
  it("fails a brand-new head number that sits below the base high-water mark", () => {
    const base = [
      f("0001_init.sql", "create table public.widgets (id uuid primary key);"),
      f("0003_far.sql", "create table public.far (id uuid primary key);"),
    ];
    const head = [
      f("0001_init.sql", "create table public.widgets (id uuid primary key);"),
      f("0002_squeezed.sql", "create table public.squeezed (id uuid primary key);"),
      f("0003_far.sql", "create table public.far (id uuid primary key);"),
    ];
    const result = analyzeBranchAgainstBase(base, head);
    expect(result.ok).toBe(false);
    const finding = result.findings.find((x: any) => x.code === "INSERTED_BELOW_HIGH_WATER");
    expect(finding).toBeDefined();
    expect(finding.version).toBe("0002");
    expect(finding.detail.baseHighWater).toBe("0003");
  });
});

describe("condition 4 — two filenames claiming one version", () => {
  it("fails when a single set has two files at the same number", () => {
    const head = [
      ...BASE_CLEAN,
      f("0003_one.sql", "create table public.one (id uuid primary key);"),
      f("0003_two.sql", "create table public.two (id uuid primary key);"),
    ];
    const result = analyzeBranchAgainstBase(BASE_CLEAN, head);
    expect(result.ok).toBe(false);
    const finding = result.findings.find((x: any) => x.code === "DUPLICATE_VERSION_IN_SET");
    expect(finding).toBeDefined();
    expect(finding.detail.branch).toBe("head");
    expect(finding.detail.filenames).toEqual(["0003_one.sql", "0003_two.sql"]);
  });
});

describe("condition 3 — a renumbering that changes dependency order", () => {
  // 0003 adds a column; 0004 and 0005 depend on it.
  const head: File[] = [
    f("0001_init.sql", "create table public.widgets (id uuid primary key);"),
    f("0002_noise.sql", "create table public.unrelated (id uuid primary key);"),
    f("0003_adds_col.sql", "alter table public.widgets add column if not exists lease_owner text;"),
    f("0004_indexes_col.sql", "create index if not exists w_idx on public.widgets (lease_owner);"),
    f("0005_uses_col.sql", "create index if not exists w_idx2 on public.widgets (lease_owner);"),
  ];
  const rows = resolveDependencies(buildInventory(head));

  it("proves the fixture actually has the dependency edges under test", () => {
    const dependants = rows.filter((r: any) => (r.dependsOn ?? []).some((d: any) => d.version === "0003"));
    expect(dependants.map((r: any) => r.version).sort()).toEqual(["0004", "0005"]);
  });

  it("REFUSES a single-file rename that moves a migration above its dependants", () => {
    // This is precisely the rejected "just rename 0069 to 0110" proposal.
    const findings = checkRenumberPlan(rows, { "0003": "0006" });
    const broken = findings.filter((x: any) => x.code === "RENUMBER_BREAKS_DEPENDENCY_ORDER");
    expect(broken.length).toBe(2);
    expect(broken.map((x: any) => x.version).sort()).toEqual(["0004", "0005"]);
    expect(broken[0].detail.dependency).toEqual({ was: "0003", becomes: "0006" });
  });

  it("ACCEPTS shifting the whole dependent sequence upward, preserving order", () => {
    const findings = checkRenumberPlan(rows, { "0003": "0004", "0004": "0005", "0005": "0006" });
    expect(findings).toEqual([]);
  });

  it("refuses a plan that maps two migrations onto one version", () => {
    const findings = checkRenumberPlan(rows, { "0004": "0005" });
    const collision = findings.find((x: any) => x.code === "RENUMBER_COLLISION");
    expect(collision).toBeDefined();
    expect(collision.detail.from).toEqual(["0004", "0005"]);
  });

  it("surfaces a bad plan through the top-level analysis too", () => {
    const result = analyzeBranchAgainstBase(BASE_CLEAN, head, { renumberPlan: { "0003": "0006" } });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("RENUMBER_BREAKS_DEPENDENCY_ORDER");
  });
});

describe("dependency extraction — the parser the gate rests on", () => {
  it("credits the migration that first defined an object, not a later replacement", () => {
    const set = [
      f("0001_defines.sql", "create or replace function public.do_thing() returns void language sql as $$ select 1 $$;"),
      f("0002_replaces.sql", "create or replace function public.do_thing() returns void language sql as $$ select 2 $$;"),
      f("0003_calls.sql", "create or replace function public.caller() returns void language plpgsql as $$ begin perform public.do_thing(); end $$;"),
    ];
    const rows = resolveDependencies(buildInventory(set));
    const calls = rows.find((r: any) => r.version === "0003");
    expect(calls.dependsOn.map((d: any) => d.version)).toContain("0001");
  });

  it("does not fabricate an edge from prose in a comment", () => {
    const set = [
      f("0001_a.sql", "create table public.alpha (id uuid primary key);"),
      f("0002_b.sql", "-- supersedes the alpha design from migration 0001\ncreate table public.beta (id uuid primary key);"),
    ];
    const rows = resolveDependencies(buildInventory(set));
    const b = rows.find((r: any) => r.version === "0002");
    expect(b.dependsOn).toEqual([]);
  });

  it("keeps dollar-quoted function bodies as code, so a body's references count", () => {
    const stripped = stripComments("create function f() as $$ begin -- inner\n perform public.tbl; end $$;");
    expect(stripped).toContain("public.tbl");
  });

  it("does not credit a bare column word without its table", () => {
    const set = [
      f("0001_a.sql", "create table public.alpha (id uuid primary key);"),
      f("0002_col.sql", "alter table public.alpha add column if not exists status text;"),
      // Mentions `status` but about a different table entirely.
      f("0003_other.sql", "create table public.gamma (status text);"),
    ];
    const rows = resolveDependencies(buildInventory(set));
    const g = rows.find((r: any) => r.version === "0003");
    expect(g.dependsOn.map((d: any) => d.version)).not.toContain("0002");
  });
});

describe("malformed input", () => {
  it("flags a head filename the runner's own regex would not match", () => {
    const head = [...BASE_CLEAN, f("003_short.sql", "create table public.x (id uuid primary key);")];
    const result = analyzeBranchAgainstBase(BASE_CLEAN, head);
    expect(codes(result)).toContain("MALFORMED_FILENAME");
  });
});

describe("a base migration that head no longer carries", () => {
  it("warns without failing the gate — the runner never re-applies a recorded version", () => {
    const base = [...BASE_CLEAN, f("0003_dropped.sql", "create table public.dropped (id uuid primary key);")];
    const head = [...BASE_CLEAN];
    const result = analyzeBranchAgainstBase(base, head);
    const warning = result.findings.find((x: any) => x.code === "BASE_VERSION_MISSING_FROM_HEAD");
    expect(warning).toBeDefined();
    expect(warning.severity).toBe("warning");
    expect(warning.detail.baseFilename).toBe("0003_dropped.sql");
    // A warning must not fail the gate.
    expect(result.ok).toBe(true);
  });
});
