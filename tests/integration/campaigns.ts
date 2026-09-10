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

/**
 * Suites that belong to NEITHER campaign, because they manage their own database lifecycle and
 * would corrupt a shared one.
 *
 * `r1-draft-schema` applies the whole draft chain and then ROLLS IT BACK — proving the rollback
 * leaves nothing behind is one of the things it exists to prove. On a shared database that
 * teardown removes the schema its neighbours depend on, and when it does not complete it leaves
 * residue: after two whole-directory runs the shared `r1_draft_migrations` ledger held 8 rows and
 * then 15, of 28, so which suites failed became a function of file ordering. It has its own
 * runner, `scripts/r1/run-draft-schema-tests.mjs`, which builds a container per run.
 *
 * TWO OPEN DEFECTS are recorded against it rather than papered over — see
 * `docs/release-1/DEPLOYMENT-READINESS.md`:
 *
 *   1. Its dedicated runner gives it a BARE database, but the draft chain outgrew that: unit
 *      `R1_DRAFT_023_authority_and_scope` needs `public.permissions`, so `--up` fails at 023.
 *   2. On a database that DOES carry the released migrations, its rollback fails —
 *      `R1_DRAFT_008_accountable_owner.down.sql` drops `memberships_id_company_uq`, which
 *      released objects depend on. The down migration undoes more than its up created.
 *
 * Excluding it here is not a way of making those go away. It stops one broken suite from
 * deciding the result of thirty others, and both defects are named in the readiness document as
 * blocking items with the evidence above.
 */
export const SELF_MANAGED_SUITES = ["r1-draft-schema.test.ts"] as const;

/** True when a suite runs itself and must not be swept into a campaign. */
export function isSelfManaged(filename: string): boolean {
  return (SELF_MANAGED_SUITES as readonly string[]).includes(filename);
}

/** True when a bare filename (e.g. `r2s-p-pagination.test.ts`) is a kernel suite. */
export function isKernelSuite(filename: string): boolean {
  return KERNEL_FILE_PATTERN.test(filename) && !isSelfManaged(filename);
}
