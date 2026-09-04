"use server";

/**
 * The authenticated runtime path for a human management decision.
 *
 * ── What this file is, and what it is not ────────────────────────────────────────────────────
 *
 * It is a thin conductor: session → RPC → result. Every rule that matters — membership, capability,
 * authority, the lifecycle map, the binding to what the person saw, idempotency and the atomic
 * append of decision, transition and audit — lives in
 * `r1_draft_record_management_decision`, inside one transaction, where it cannot be skipped by
 * anything that calls it.
 *
 * That placement is deliberate. A rule enforced here is a rule enforced for callers who come
 * through here; a rule enforced in the database is enforced for everyone. The owner's requirement
 * is explicit that hiding a button is not an authorisation boundary, and neither is a check in a
 * server action.
 *
 * ── Why `supabaseServer()` and never `supabaseAdmin()` ───────────────────────────────────────
 *
 * The RPC identifies the actor from `auth.uid()`. Called through the service role there is no
 * `auth.uid()`, so a service-role call cannot record a decision at all — which is the intended
 * shape: a decision is a human act, and the function is granted to `authenticated` only.
 *
 * Using the admin client here would also be refused by the repository's own service-role allowlist
 * check, as it was in R2D-F-007.
 */
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { log } from "@/lib/log";

/**
 * What the caller may say.
 *
 * No company, membership, actor or authority — the RPC derives all of those and its signature has
 * nowhere to put them. The four `seen*` fields describe the screen the person decided from; they
 * are compared inside the transaction, never trusted.
 */
export interface DecisionInput {
  readonly itemId: string;
  readonly decision: "approve" | "reject";
  readonly seenState: string;
  readonly seenActionId: string | null;
  readonly seenEvidenceDigest: string;
  readonly seenParameterDigest: string | null;
  readonly reason?: string | null;
  readonly idempotencyKey?: string | null;
}

/**
 * The result, discriminated.
 *
 * A refusal is not an error: most of them are the system correctly declining, and the caller has to
 * be able to tell "you may not" from "it broke" in order to say something true to the person.
 */
export type DecisionResult =
  | { readonly ok: true; readonly result: "recorded" | "duplicate"; readonly toState?: string }
  | { readonly ok: false; readonly refusal: string; readonly detail?: string }
  | { readonly ok: false; readonly refusal: "unavailable"; readonly detail: string };

/** Refusals that are safe to show a person verbatim, with wording that says what to do next. */
const REFUSAL_MESSAGE: Record<string, string> = {
  unauthenticated: "Your session has expired. Sign in again.",
  not_found: "That item is no longer available to you.",
  insufficient_capability: "You do not have permission to decide this.",
  unresolved_authority:
    "This needs an authority this system cannot yet verify. It has to be decided outside the app.",
  reason_required: "A reason is required to reject.",
  stale_item: "Someone changed this while you were looking at it. Reload and decide again.",
  action_changed: "The proposed action changed while you were looking at it. Reload it.",
  evidence_changed: "The evidence changed since this was recommended. Reload and review it again.",
  state_does_not_admit_decision: "This item is no longer awaiting a decision.",
  conflicting_retry: "A different decision was already recorded under this submission.",
  unavailable: "The management tables are unavailable.",
};

export function decisionMessage(refusal: string): string {
  // An unknown refusal gets a truthful non-specific sentence rather than a raw database string:
  // the detail is logged, not shown.
  return REFUSAL_MESSAGE[refusal] ?? "That decision could not be recorded.";
}

/**
 * Record one decision.
 *
 * Never throws for an expected outcome. A thrown error here means the database was unreachable,
 * which is reported as `unavailable` — deliberately distinct from a refusal, because "we could not
 * ask" and "the answer is no" are different things to tell someone.
 */
export async function recordManagementDecision(input: DecisionInput): Promise<DecisionResult> {
  // Establishes that there IS a session. It does not establish authority — the RPC does that, from
  // the database, inside the transaction.
  await requireProfile();

  const db = supabaseServer();
  const { data, error } = await db.rpc("r1_draft_record_management_decision", {
    p_item_id: input.itemId,
    p_decision: input.decision,
    p_expected_state: input.seenState,
    p_expected_action_id: input.seenActionId,
    p_expected_evidence_digest: input.seenEvidenceDigest,
    p_expected_parameter_digest: input.seenParameterDigest,
    p_reason: input.reason ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  });

  if (error) {
    log("error", "management decision rpc failed", {
      event: "management_decision.rpc_failed",
      // The item id is not business content; the error message may be, so it is logged and not
      // returned to the browser.
      itemId: input.itemId,
      error: error.message,
    });
    return { ok: false, refusal: "unavailable", detail: "the decision could not be recorded" };
  }

  const row = (data ?? null) as {
    ok?: boolean;
    refusal?: string;
    detail?: string;
    result?: string;
    to_state?: string;
  } | null;

  if (!row || typeof row.ok !== "boolean") {
    // An unrecognised shape is not a success. Guessing would be how a person is told their
    // decision was recorded when it was not.
    return { ok: false, refusal: "unavailable", detail: "unrecognised response" };
  }

  if (row.ok !== true) {
    return { ok: false, refusal: row.refusal ?? "unknown", detail: row.detail };
  }

  // The queue reads from the database, so it must be re-read rather than patched in memory:
  // what the person sees next is the committed state, not what we hoped happened.
  revalidatePath("/app/command/queue");
  revalidatePath("/app/command");

  return {
    ok: true,
    result: row.result === "duplicate" ? "duplicate" : "recorded",
    toState: row.to_state,
  };
}
