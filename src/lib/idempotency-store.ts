/**
 * Server-only idempotency claim (NEXT_PHASE_DEVELOPER_BRIEF §WP2). Inserts a key into
 * `idempotency_keys` (migration 0026); the PRIMARY KEY makes a duplicate claim fail,
 * which we report as "duplicate" so the caller can skip re-doing the operation.
 *
 * Graceful: if the table does not exist yet (pre-0026) or another error occurs, we
 * return "unavailable" and the caller proceeds as before — the guard is additive and
 * never blocks a legitimate operation because the feature isn't migrated.
 */
import { supabaseAdmin } from "@/lib/supabase/server";

export type ClaimResult = "claimed" | "duplicate" | "unavailable";

export async function claimIdempotencyKey(
  companyId: string,
  scope: string,
  key: string,
  createdBy: string | null,
): Promise<ClaimResult> {
  try {
    const { error } = await supabaseAdmin()
      .from("idempotency_keys")
      .insert({ company_id: companyId, scope, key, created_by: createdBy });
    if (!error) return "claimed";
    // 23505 = unique_violation → this operation was already performed.
    if ((error as { code?: string }).code === "23505") return "duplicate";
    return "unavailable"; // table missing (pre-migration) or other → don't block
  } catch {
    return "unavailable";
  }
}
