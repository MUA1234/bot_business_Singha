import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { KERNEL_FILE_PATTERN, isKernelSuite } from "./integration/campaigns";

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

  it("every suite is claimed by exactly one campaign", () => {
    const unclaimed = suites.filter((f) => {
      const kernel = isKernelSuite(f);
      const core = !kernel;
      return !(kernel !== core); // exactly one must be true
    });
    expect(unclaimed).toEqual([]);
  });

  it("the kernel campaign is not empty and the core campaign is not empty", () => {
    const kernel = suites.filter(isKernelSuite);
    const core = suites.filter((f) => !isKernelSuite(f));
    expect(kernel.length, "no kernel suites matched — did the prefixes change?").toBeGreaterThan(10);
    expect(core.length, "no core suites matched").toBeGreaterThan(50);
  });

  it("the pattern claims every kernel naming variant, including the lettered ones", () => {
    // The first attempt matched only `r1-` and `r2-`, which silently left ~20 `r2b/r2c/r2d/r2e/
    // r2s` suites in the CORE campaign, against a database with no draft schema.
    for (const f of [
      "r1-security-baseline.test.ts", "r1-draft-schema.test.ts", "r2-operations-slice.test.ts",
      "r2b-capability-routing.test.ts", "r2c-role-routing.test.ts", "r2d-ask-ai.test.ts",
      "r2e-execution-ledger.test.ts", "r2s-loader-contract.test.ts", "r2s-p-pagination.test.ts",
    ]) {
      expect(isKernelSuite(f), `${f} must be a kernel suite`).toBe(true);
    }
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

  it("prepares the draft chain before the kernel campaign, and not before the core one", () => {
    // The core campaign must see a database with NO draft object: its enumeration gates assert
    // every SECURITY DEFINER function is classified.
    const kernelStep = ci.slice(ci.indexOf("test:kernel") - 800, ci.indexOf("test:kernel"));
    expect(kernelStep, "the kernel job must apply the draft chain").toMatch(/draft-migrate/);
  });
});
