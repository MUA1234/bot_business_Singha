"use server";

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/access";
import { supabaseAdmin } from "@/lib/supabase/server";
import { INBOUND_REVIEW_CAPABILITY } from "./capability";

export interface ReviewActionState {
  error?: string;
  ok?: string;
}

/**
 * Close one inbound review (FOUND-003).
 *
 * TWO independent checks, deliberately. The app checks the capability here, and
 * `resolve_inbound_review` re-checks the NAMED ACTOR at the database (migration 0075). A bug or a
 * bypass in this layer is therefore not sufficient to clear someone else's queue — and the audit
 * event is written inside the same transaction as the state change, so a resolution can never be
 * recorded without its audit trail.
 */
export async function resolveReview(_prev: ReviewActionState, formData: FormData): Promise<ReviewActionState> {
  const reviewId = String(formData.get("reviewId") ?? "").trim();
  const state = String(formData.get("state") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!reviewId) return { error: "No review selected." };
  if (state !== "resolved" && state !== "dismissed") return { error: "Choose resolve or dismiss." };

  let membership;
  try {
    membership = await requireCapability(INBOUND_REVIEW_CAPABILITY);
  } catch {
    return { error: "You do not have permission to review inbound messages." };
  }

  const { data, error } = await supabaseAdmin().rpc("resolve_inbound_review", {
    p_company: membership.companyId,
    p_review: reviewId,
    p_actor: membership.userId,
    p_state: state,
    p_note: note,
  });
  if (error) return { error: `Could not record the decision: ${error.message}` };

  const row = Array.isArray(data) ? data[0] : data;
  const finalState = String((row as { state?: string } | null)?.state ?? state);
  revalidatePath("/app/admin/inbound-review");
  return {
    ok:
      finalState === state
        ? `Marked ${finalState}.`
        : `Already ${finalState} — someone else decided this one first, and that decision stands.`,
  };
}
