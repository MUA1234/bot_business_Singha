import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { KERNEL_FILE_PATTERN, isKernelSuite, isSelfManaged, SELF_MANAGED_SUITES } from "./integration/campaigns";

/**
 * Every integration suite belongs to exactly one campaign, and CI runs both.
 *
 * The failure this prevents already happened twice over. `npm run test:integration` swept all 111
 * files after `shim + migrate` alone, including 35 kernel suites whose tables are quarantined
 * outside the numbered sequence — so CI's integration job could not be green, and the real
 * signal (74 core suites, 671 tests, all passing) was buried under 27 failures that meant
 * nothing. Splitting the campaigns fixes that only while BOTH are actually run and every file
 * lands in one of them; a suite in neither would simply never execute again, and nothing would
 * say so.
 */

const DIR = "tests/integration";
const CI = ".github/workflows/ci.yml";

const suites = readdirSync(DIR)
  .filter((f) => /\.test\.tsx?$/.test(f))
  .sort();

describe("campaign partition", () => {
  it("finds the integration suites at all (guards against a moved directory)", () => {
    expect(suites.length).toBeGreaterThan(50);
  });

  it("every suite lands in exactly one of the three buckets", () => {
    // core | kernel | self-managed. A suite in none would never run again, with nothing saying so.
    for (const f of suites) {
      const buckets = [isKernelSuite(f), isSelfManaged(f), !isKernelSuite(f) && !isSelfManaged(f)];
      expect(buckets.filter(Boolean).length, `${f} is not in exactly one bucket`).toBe(1);
    }
  });

  it("the kernel campaign is not empty and the core campaign is not empty", () => {
    const kernel = suites.filter(isKernelSuite);
    const core = suites.filter((f) => !isKernelSuite(f) && !isSelfManaged(f));
    expect(kernel.length, "no kernel suites matched — did the pattern change?").toBeGreaterThan(10);
    expect(core.length, "no core suites matched").toBeGreaterThan(50);
  });

  it("a self-managed suite is excluded from BOTH campaigns and really exists", () => {
    for (const f of SELF_MANAGED_SUITES) {
      expect(suites, `${f} is listed as self-managed but no such suite exists`).toContain(f);
      expect(isKernelSuite(f), `${f} must not also be claimed by the kernel campaign`).toBe(false);
    }
  });

  it("a self-managed suite has a campaign of its own, so excluding it does not silence it", () => {
    // Excluding a suite from both campaigns is only legitimate while something else runs it.
    // Without this, "self-managed" becomes a way of retiring a failing suite quietly.
    const cfg = readFileSync("vitest.draft-schema.config.ts", "utf8");
    expect(cfg).toMatch(/SELF_MANAGED_SUITES/);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:draft-schema"]).toMatch(/vitest\.draft-schema\.config\.ts/);
  });

  it("the pattern claims every kernel naming variant, including the lettered ones", () => {
    // The first attempt matched only `r1-` and `r2-`, which silently left ~20 `r2b/r2c/r2d/r2e/
    // r2s` suites in the CORE campaign, against a database with no draft schema.
    for (const f of [
      "r1-security-baseline.test.ts", "r1-runtime-e2e.test.ts", "r2-operations-slice.test.ts",
      "r2b-capability-routing.test.ts", "r2c-role-routing.test.ts", "r2d-ask-ai.test.ts",
      "r2e-execution-ledger.test.ts", "r2s-loader-contract.test.ts", "r2s-p-pagination.test.ts",
    ]) {
      expect(isKernelSuite(f), `${f} must be a kernel suite`).toBe(true);
    }
    // `r1-draft-schema` matches the naming pattern but is SELF-MANAGED, and the exclusion has to
    // win — otherwise it rejoins the kernel campaign and resumes rolling the schema back
    // underneath its neighbours.
    expect(KERNEL_FILE_PATTERN.test("r1-draft-schema.test.ts")).toBe(true);
    expect(isKernelSuite("r1-draft-schema.test.ts")).toBe(false);
  });

  it("the pattern is specific enough not to swallow a core suite", () => {
    // `rls-coverage`, `routing-provenance`, `rpc-concurrency` all begin with "r". A looser
    // pattern would drag the enumeration gates out of the campaign written for them.
    for (const f of [
      "rls-coverage.test.ts", "rls-matrix-coverage.test.ts", "routing-provenance.test.ts",
      "rpc-concurrency.test.ts", "settlement.test.ts", "outbox.test.ts",
    ]) {
      expect(isKernelSuite(f), `${f} must be a core suite`).toBe(false);
    }
    // The digit is what separates them, so it must stay in the pattern.
    expect(KERNEL_FILE_PATTERN.source).toContain("[12]");
  });
});

describe("CI runs both campaigns", () => {
  const ci = readFileSync(CI, "utf8");

  it("runs the core integration campaign", () => {
    expect(ci).toMatch(/npm run test:integration/);
  });

  it("runs the kernel campaign too — a split that only runs one half is worse than no split", () => {
    expect(ci).toMatch(/npm run test:kernel/);
  });

  it("runs the draft-schema campaign too — all three, or the split hides a suite", () => {
    expect(ci).toMatch(/npm run test:draft-schema/);
  });

  it("prepares the draft chain before the kernel campaign, and not before the core one", () => {
    // The core campaign must see a database with NO draft object: its enumeration gates assert
    // every SECURITY DEFINER function is classified.
    const kernelStep = ci.slice(ci.indexOf("test:kernel") - 800, ci.indexOf("test:kernel"));
    expect(kernelStep, "the kernel job must apply the draft chain").toMatch(/draft-migrate/);
  });
});

describe("the canonical security campaign runs exactly the kernel suites", () => {
  const RUNNER = "scripts/r1/run-r1-security-tests.mjs";
  const runner = readFileSync(RUNNER, "utf8");

  it("holds NO hand-written list of suite filenames", () => {
    // It held 33, and they had drifted: `r2-cross-company-attack-matrix` and both
    // `r2f-postgrest-*` suites were kernel suites the canonical campaign did not run. A list
    // beside a pattern is the exact defect `campaigns.ts` was written to prevent, and having it
    // in a second file did not make it a different defect.
    const quotedSuites = [...runner.matchAll(/"tests\/integration\/[^"]+\.test\.tsx?"/g)];
    expect(quotedSuites.map((m) => m[0]), "the runner names suites by hand again").toEqual([]);
  });

  it("derives them with the SAME pattern the campaign configs use", () => {
    // Duplicated rather than imported — the runner is plain Node and `campaigns.ts` is
    // TypeScript — so the duplication is asserted here instead of being trusted.
    const m = runner.match(/const KERNEL_FILE_PATTERN = (\/[^\n]+\/);/);
    expect(m, "the runner does not declare a kernel pattern").not.toBeNull();
    expect(m![1]).toBe(KERNEL_FILE_PATTERN.toString());
    expect(runner).toMatch(/const SELF_MANAGED = \["r1-draft-schema\.test\.ts"\]/);
    expect([...SELF_MANAGED_SUITES]).toEqual(["r1-draft-schema.test.ts"]);
  });

  it("and would refuse to run a suspiciously small selection", () => {
    // A pattern that stopped matching would otherwise run a handful of suites and exit 0, which
    // is how a campaign reports success for work it did not do.
    expect(runner).toMatch(/ALL\.length < 30/);
    expect(suites.filter(isKernelSuite).length).toBeGreaterThanOrEqual(30);
  });
});
