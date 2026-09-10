"use server";

/**
 * The authenticated runtime path for a manager giving work to a person.
 *
 * A thin conductor: session → RPC → result. Every rule that matters — the assigner's authority in
 * this company, the target's active membership, the target's own capability, their availability,
 * the binding to what the manager saw, the candidate evidence being revalidated, the atomic write
 * of the task's assignee and the item's accountable owner, the assignment history and the audit —
 * lives in `r1_draft_assign_management_item`, inside one transaction, where nothing that calls it
 * can skip them.
 *
 * ── Why the request-bound client, and never the service-role client ─────────────────────────
 *
 * The RPC identifies the assigner from `auth.uid()`, and `service_role` has EXECUTE revoked on it.
 * That is the owner's decision made unbypassable rather than merely unimplemented: AI assignment is
 * recommendation-only for this phase, so a binding assignment by anything other than an
 * authenticated human is not a policy the code follows — it is a call the database refuses.
 */
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { log } from "@/lib/log";

/**
 * What the caller may say.
 *
 * No company, no assigner, no authority — the RPC derives every one of those and its signature has
 * nowhere to put them. The `seen*` fields describe the screen the manager acted from; they are
 * compared inside the transaction, never trusted.
 */
export interface AssignmentInput {
  readonly itemId: string;
  /** The MEMBERSHIP to make accountable. Resolved to a user server-side. */
  readonly membershipId: string;
  readonly seenState: string;
  readonly seenConditionDigest: string;
  /** The eligibility digest recorded for THIS candidate, or null when nobody recommended them. */
  readonly seenEligibilityDigest: string | null;
  readonly overrideReason?: string | null;
  readonly idempotencyKey?: string | null;
}

export type AssignmentResult =
  | { readonly ok: true; readonly result: "assigned" | "duplicate"; readonly isOverride?: boolean }
  | { readonly ok: false; readonly refusal: string; readonly recommended?: string | null };

/**
 * Record one binding assignment.
 *
 * It means: this person is now accountable for this work, and the underlying task is theirs. Those
 * two facts are written together or not at all — an item naming one person while the task names
 * another is the failure the boundary exists to make impossible.
 */
export async function assignManagementItem(input: AssignmentInput): Promise<AssignmentResult> {
  // Establishes that there IS a session. It does not establish authority — the RPC does that, from
  // the database, inside the transaction.
  await requireProfile();

  const db = supabaseServer();
  const { data, error } = await db.rpc("r1_draft_assign_management_item", {
    p_item_id: input.itemId,
    p_membership_id: input.membershipId,
    p_expected_state: input.seenState,
    p_expected_condition_digest: input.seenConditionDigest,
    p_expected_eligibility_digest: input.seenEligibilityDigest,
    p_override_reason: input.overrideReason ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  });

  if (error) {
    log("error", "assignment rpc failed", {
      event: "assignment.rpc_failed",
      // Ids are not business content; the error message may be, so it is logged and not returned.
      itemId: input.itemId,
      error: error.message,
    });
    return { ok: false, refusal: "unavailable" };
  }

  const row = (data ?? null) as {
    ok?: boolean;
    refusal?: string;
    result?: string;
    is_override?: boolean;
    recommended?: string | null;
  } | null;

  if (!row || typeof row.ok !== "boolean") {
    // An unrecognised shape is not a success. Guessing would be how a manager is told somebody is
    // doing the work when nobody is.
    return { ok: false, refusal: "unavailable" };
  }

  if (row.ok !== true) {
    return { ok: false, refusal: row.refusal ?? "unknown", recommended: row.recommended ?? null };
  }

  // The queue reads from the database, so it must be re-read rather than patched in memory: what
  // the manager sees next is the committed state.
  revalidatePath("/app/command/queue");
  revalidatePath("/app/command");

  return {
    ok: true,
    result: row.result === "duplicate" ? "duplicate" : "assigned",
    isOverride: row.is_override === true,
  };
}
