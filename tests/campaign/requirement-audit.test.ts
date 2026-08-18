/**
 * The requirement audit is the tripwire that stops a completion claim without evidence. A tripwire
 * with no test is an assumption, so these scenarios exercise the rules directly.
 *
 * The rule added here after it caught a real placeholder in this repository: a completion status may
 * not cite `pending`, a branch name, or anything else that is not a commit id. Emptiness alone is
 * too weak — "pending" is not empty, and it is not evidence either.
 */
import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lib: any = await import("../../scripts/autonomy/requirements-lib.mjs" as string);
const { validateRequirement, loadRegister, COMPLETE_STATUSES } = lib;

const complete = (over: Record<string, unknown> = {}) => ({
  id: "TST-001",
  title: "t",
  status: "locally_verified",
  runtime_entrypoint: "src/x.ts",
  test_evidence: "tests/x.test.ts",
  last_verified_sha: "6e354b7",
  ...over,
});

describe("requirement audit rules", () => {
  it("accepts a completion status backed by an entrypoint, tests and a commit id", () => {
    expect(validateRequirement(complete())).toEqual([]);
  });

  it("REJECTS a placeholder in place of a tested commit", () => {
    for (const sha of ["pending", "latest", "main", "HEAD", "soon"]) {
      const problems = validateRequirement(complete({ last_verified_sha: sha }));
      expect(problems.join(" "), sha).toMatch(/not a commit id/);
    }
  });

  it("REJECTS a completion status whose evidence fields are empty or say nothing", () => {
    for (const empty of ["", "none", "n/a", "tbd", "-"]) {
      expect(validateRequirement(complete({ test_evidence: empty })).join(" ")).toMatch(/requires evidence/);
      expect(validateRequirement(complete({ runtime_entrypoint: empty })).join(" ")).toMatch(/requires evidence/);
      expect(validateRequirement(complete({ last_verified_sha: empty })).join(" ")).toMatch(/requires evidence/);
    }
  });

  it("does not demand a commit id from a requirement that claims nothing", () => {
    expect(validateRequirement({ id: "TST-002", title: "t", status: "absent" })).toEqual([]);
  });

  it("rejects an invented status", () => {
    expect(validateRequirement({ id: "TST-003", title: "t", status: "nearly_done" }).join(" ")).toMatch(/invalid status/);
  });

  it("the register in this repository has no completion status citing a placeholder", () => {
    const { requirements } = loadRegister();
    const bad = requirements
      .filter((r: { status: string }) => COMPLETE_STATUSES.has(r.status))
      .filter((r: { last_verified_sha?: string }) => !/^[0-9a-f]{7,40}$/.test(String(r.last_verified_sha ?? "").trim()))
      .map((r: { id: string }) => r.id);
    expect(bad).toEqual([]);
  });
});
