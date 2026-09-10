"use server";

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/access";
import { supabaseRpcClient } from "@/lib/supabase/read";
import { DUPLICATE_REVIEW_CAPABILITY, RESOLUTIONS, type Resolution } from "./capability";

export interface ResolveState {
  error?: string;
  ok?: string;
  conflict?: string;
}

/**
 * Record a human decision on one suspected duplicate (OF-016).
 *
 * TWO independent checks, deliberately, as in the inbound-review action. The app checks the
 * capability here so the UI can say something useful; `resolve_duplicate_review` re-checks the
 * ACTUAL authenticated subject, its active membership and the same capability at the database,
 * under the row locks, in the same transaction as the state change and the audit row. A bug or a
 * bypass in this layer is therefore not sufficient to resolve anything.
 *
 * `supabaseRpcClient()` is the authenticated client — never the service role. That is not a
 * detail: the RPC derives the acting human from `auth.uid()` and is granted to `authenticated`
 * only, so routing it through the service role would both fail and, if it did not, forge a
 * person's decision.
 */
export async function resolveDuplicateReview(
  _prev: ResolveState,
  formData: FormData,
): Promise<ResolveState> {
  const reviewId = String(formData.get("reviewId") ?? "").trim();
  const resolution = String(formData.get("resolution") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (!reviewId) return { error: "No review selected." };
  if (!RESOLUTIONS.includes(resolution as Resolution)) {
    return { error: "Choose whether this is a duplicate or a distinct transaction." };
  }
  if (!reason) {
    return { error: "A reason is required — a decision without one cannot be reviewed later." };
  }

  let membership;
  try {
    membership = await requireCapability(DUPLICATE_REVIEW_CAPABILITY);
  } catch {
    return { error: "You do not have permission to resolve suspected duplicates." };
  }
  void membership;

  const { data, error } = await supabaseRpcClient().rpc("resolve_duplicate_review", {
    p_review: reviewId,
    p_resolution: resolution,
    p_reason: reason,
  });

  if (error) {
    // The database's own refusals are shown as-is where they are actionable. `inconsistent` is the
    // fail-closed case: downstream financial evidence already exists behind this paused event, and
    // deleting it automatically would be worse than stopping.
    if (/inconsistent/i.test(error.message)) {
      return { conflict: error.message };
    }
    if (/state .* only an event paused/i.test(error.message)) {
      return { conflict: "Somebody moved this event while you were deciding. Reload to see where it is now." };
    }
    return { error: `Could not record the decision: ${error.message}` };
  }

  const row = Array.isArray(data) ? data[0] : data;
  const applied = String((row as { resolution?: string } | null)?.resolution ?? resolution);
  const replayed = Boolean((row as { replayed?: boolean } | null)?.replayed);

  revalidatePath("/app/finance/duplicate-reviews");
  revalidatePath("/app/finance/approvals");

  if (replayed) {
    return {
      ok:
        applied === resolution
          ? "Already recorded — your decision was applied earlier and stands."
          : `Already resolved as ${label(applied)} by someone else. That decision stands.`,
    };
  }
  return { ok: applied === "confirmed_duplicate" ? "Marked as a duplicate." : "Released as a distinct transaction." };
}

function label(r: string): string {
  return r === "confirmed_duplicate" ? "a duplicate" : "a distinct transaction";
}
