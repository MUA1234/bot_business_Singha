/**
 * Which integration suites belong to which campaign.
 *
 * Declared ONCE, here, and imported by both vitest configs and by the test that checks every
 * suite has a home. Two independent lists would drift, and the way that drift shows up is a
 * suite silently running in neither campaign — which is how the kernel suites came to run in the
 * core one against a database that could never satisfy them.
 *
 * The split is by DATABASE SHAPE, not by subject matter:
 *
 *   * CORE   — released numbered migrations only. No draft object exists.
 *   * KERNEL — released migrations PLUS the quarantined R1 draft chain
 *              (`src/db/draft-migrations-r1/`), applied once by the campaign runner.
 *
 * A kernel suite cannot run in the core campaign: its tables do not exist there. A core suite
 * must not run in the kernel campaign either, because the enumeration gates assert that every
 * SECURITY DEFINER function in `public` is classified, and the draft functions are deliberately
 * not on that allowlist — they are quarantined objects, not released ones.
 */

/**
 * Kernel suites are named `r1…-` or `r2…-`: `r1-security-baseline`, `r2-operations-slice`,
 * but also `r2b-capability-routing`, `r2d-ask-ai`, `r2e-execution-ledger`, `r2s-p-pagination`.
 *
 * The letter suffixes are why this is a pattern and not a list of two prefixes. A first attempt
 * used `["r1-", "r2-"]`, which silently left the 20-odd `r2b/r2c/r2d/r2e/r2s` suites in the CORE
 * campaign — where they ran against a database with no draft schema and failed, which is the
 * exact defect the split exists to remove.
 *
 * The `[12]` is load-bearing in the other direction too: `rls-coverage`, `routing-provenance`
 * and `rpc-concurrency` are core suites that begin with `r`, and a looser pattern would drag the
 * enumeration gates out of the campaign that is written for them.
 *
 * `r1-draft-schema` is the exception that proves the rule: it builds and drops its OWN database,
 * so it is safe anywhere — but it belongs with the kernel campaign by subject.
 */
export const KERNEL_FILE_PATTERN = /^r[12][a-z0-9]*-/;

/** Glob form, for a vitest `exclude`/`include`. Broader than the pattern; the pattern decides. */
export const KERNEL_SUITE_GLOBS = [
  "tests/integration/r1*.test.ts",
  "tests/integration/r2*.test.ts",
];

/** True when a bare filename (e.g. `r2s-p-pagination.test.ts`) is a kernel suite. */
export function isKernelSuite(filename: string): boolean {
  return KERNEL_FILE_PATTERN.test(filename);
}
