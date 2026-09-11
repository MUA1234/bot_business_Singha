/**
 * R2E — the two execution boundaries. BOTH are required, and neither is configuration.
 *
 * ── Why the global switch stopped being a compile-time constant ──────────────────────────────
 *
 * It was `false as const`, and the reasoning was good: R2E-F-004 recorded that an environment
 * variable makes the difference between a system that cannot act and one that can into a value
 * nobody reviews in a diff.
 *
 * It changed for exactly one reason. Staging cannot verify the loop's single authorised effect
 * without producing it once, against synthetic data, and a constant cannot be true in staging and
 * false in production. Keeping the constant would have meant shipping a Release 1 whose one
 * automated effect had never been observed working anywhere.
 *
 * What was preserved from the constant, deliberately:
 *
 *   * the default is FALSE — missing, empty, or any value that is not exactly `"on"`;
 *   * it is a plain server variable, never `NEXT_PUBLIC_*`, so no browser bundle carries it, and
 *     a test fails if such a variant is ever introduced;
 *   * it grants ONE thing — permission to pass the global gate. It cannot widen the action
 *     allowlist, which is a single-member union plus a policy table that never read it;
 *   * it is independent of the model-job control, so stopping spend and stopping execution are
 *     two switches rather than one;
 *   * and the SERVER side has its own row (`r1_exec_global_boundary`, default false) which the
 *     execute RPC reads inside its own transaction. Both must permit execution.
 *
 * Production stays disabled. That is now a property of production's configuration rather than of
 * the source, which is a real reduction in strength, and it is why the diagnostics below exist:
 * a system that can act reports so at startup rather than waiting to be asked.
 *
 * ── Why per-company enablement is separate, and why general kernel enablement is not enough ──
 *
 * `management_kernel_enablement` says a company's OBSERVATION cycle may run — that it may read,
 * detect, recommend and file management items. The owner's direction is that this must not
 * implicitly confer the right to produce business effects: those are different powers, granted at
 * different times, and a company that agreed to be observed did not thereby agree to be acted upon.
 *
 * So execution requires its own row, in its own table, defaulting to disabled, and the two are
 * checked independently and reported as distinct refusals.
 */
import type { CompanyId } from "../ask-ai/identity";
import type { RefusalReason } from "./contract";

/**
 * The name of the ONE variable that can enable execution, and the ONE value that does.
 *
 * ── Why this name, and not a `NEXT_PUBLIC_` one ─────────────────────────────────────────────
 *
 * Next.js inlines `NEXT_PUBLIC_*` into the client bundle, so such a variable is readable — and in
 * a compromised build, settable — where the browser can reach it. `EXECUTION_ENABLED` is a plain
 * server variable, never inlined, and `browserReachableExecutionFlags()` below fails a test if a
 * `NEXT_PUBLIC_` variant is ever introduced.
 */
export const EXECUTION_ENABLED_VAR = "EXECUTION_ENABLED" as const;
/** The only accepted value. Anything else — including `true`, `1`, `ON`, `yes` — is OFF. */
export const EXECUTION_ENABLED_VALUE = "on" as const;

/**
 * Is execution enabled at the global boundary?
 *
 * Fail-closed in every direction that matters:
 *   * missing  → false;
 *   * empty    → false;
 *   * anything that is not exactly `"on"` → false, so a typo cannot enable it;
 *   * a `NEXT_PUBLIC_` variant → **ignored entirely**, never consulted.
 *
 * It grants exactly one thing: permission for the executor to proceed past the global gate. It
 * cannot widen the action allowlist — that is `ExecutionHandlerKey`, a single-member union, and
 * the policy table, neither of which reads this — and it cannot enable a model job, which is the
 * separate `MODEL_JOBS` control on the scheduler.
 */
export function executionGloballyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EXECUTION_ENABLED_VAR] === EXECUTION_ENABLED_VALUE;
}

/**
 * Any variable that could enable execution AND be reachable from a browser bundle. Must be empty.
 *
 * Asserted by a test rather than assumed: the danger is not today's code, it is the future commit
 * that adds `NEXT_PUBLIC_EXECUTION_ENABLED` "for the admin screen".
 */
export function browserReachableExecutionFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((k) => /^NEXT_PUBLIC_.*EXECUT/i.test(k));
}

/**
 * What to log at startup. Names and booleans only — never a value, never a secret.
 *
 * Execution being ON is reported at error level by the caller, because a system that can produce
 * business effects without a person saying so each time is a fact an operator must not have to go
 * looking for.
 */
export function executionBoundaryDiagnostics(env: NodeJS.ProcessEnv = process.env): {
  variable: string;
  enabled: boolean;
  browserReachableFlags: string[];
} {
  return {
    variable: EXECUTION_ENABLED_VAR,
    enabled: executionGloballyEnabled(env),
    browserReachableFlags: browserReachableExecutionFlags(env),
  };
}

/**
 * Deterministic local tests are the ONLY context in which a real effect may be produced, and they
 * must pass this token explicitly per call. It is not read from the environment, so no test-runner
 * configuration, no `.env`, and no CI variable can supply it.
 *
 * The value is meaningless; requiring it is the point. A caller that has one is a caller that
 * typed it into a test file.
 */
export const LOCAL_EXECUTION_TOKEN = "r2e-deterministic-local-test-only" as const;
export type LocalExecutionToken = typeof LOCAL_EXECUTION_TOKEN;

/** How the global boundary was satisfied, if it was. Carried into the ledger. */
export type GlobalBoundaryMode = "disabled" | "local_test";

export interface BoundaryInput {
  readonly companyId: CompanyId;
  /**
   * Present ONLY in a deterministic local test. Absent in every server path, because no server
   * path has anywhere to get it from.
   */
  readonly localToken?: string;
  /** Reads the execution-enablement table. Server-controlled; never a caller-supplied list. */
  companyExecutionEnabled(companyId: CompanyId): Promise<boolean>;
}

export type BoundaryDecision =
  | { readonly ok: true; readonly mode: GlobalBoundaryMode }
  | { readonly ok: false; readonly reason: RefusalReason; readonly detail: string };

/**
 * Both boundaries, in order, independently.
 *
 * The global check comes FIRST and returns before the company is looked up. A disabled system
 * therefore performs no query about the company it was asked about, and reveals nothing — including
 * whether that company exists.
 */
export async function checkExecutionBoundaries(input: BoundaryInput): Promise<BoundaryDecision> {
  const globallyOn: boolean = executionGloballyEnabled();
  const localTest = input.localToken === LOCAL_EXECUTION_TOKEN;

  if (!globallyOn && !localTest) {
    return {
      ok: false,
      reason: "global_boundary_disabled",
      detail: "execution is disabled at the global boundary",
    };
  }

  // Independent, and NOT implied by the kernel's own enablement — a company may be observed
  // without being acted upon.
  let enabled = false;
  try {
    enabled = await input.companyExecutionEnabled(input.companyId);
  } catch (e) {
    // A boundary that cannot be read is a boundary that is closed.
    return {
      ok: false,
      reason: "company_not_enabled",
      detail: `execution enablement could not be read: ${(e as Error).message}`,
    };
  }

  if (!enabled) {
    return {
      ok: false,
      reason: "company_not_enabled",
      detail: "this company has no execution enablement",
    };
  }

  return { ok: true, mode: localTest ? "local_test" : "disabled" };
}

/** Raised when a caller reaches an execution path that must never run in this build. */
export class ExecutionDisabledError extends Error {
  constructor(detail: string) {
    super(`R2E execution is disabled: ${detail}`);
    this.name = "ExecutionDisabledError";
  }
}
