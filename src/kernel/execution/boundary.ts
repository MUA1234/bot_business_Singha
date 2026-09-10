/**
 * R2E — the two execution boundaries. BOTH are required, and neither is configuration.
 *
 * ── Why the global switch is a compile-time constant ─────────────────────────────────────────
 *
 * R2E-F-004 recorded the contrast. The management kernel's own switch is
 * `MANAGEMENT_KERNEL === "on"` — an environment variable, which is deployment configuration, and
 * deployment configuration is exactly the boundary the owner's standing constraints treat as
 * requiring separate approval each time. An env var also means the difference between a system
 * that cannot act and one that can is a value nobody reviews in a diff.
 *
 * `EXECUTION_GLOBALLY_ENABLED` is therefore `false as const`, following `worker-boundary.ts`. No
 * deployment can turn it on. Turning it on is a code change, in a reviewed diff, in a commit with
 * an author. Staging and production consequently execute nothing, and that is a property of the
 * source rather than a property of their configuration.
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
 * Hard-coded. Deliberately NOT an environment variable, NOT a feature flag, NOT a database row.
 *
 * `as const` so its type is `false`, which makes any code guarded by it visibly unreachable to the
 * compiler rather than merely inactive at runtime.
 */
export const EXECUTION_GLOBALLY_ENABLED = false as const;

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
  const globallyOn: boolean = EXECUTION_GLOBALLY_ENABLED;
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
