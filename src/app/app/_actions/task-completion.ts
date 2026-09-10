"use server";

/**
 * The authenticated runtime path for a person reporting their own work complete.
 *
 * A thin conductor: session → RPC → result. Every rule that matters — the claimant's identity, the
 * company, the item-to-task link, active membership, capability, the task assignment, the task's
 * real status, required evidence, the binding to what the person saw, idempotency and the atomic
 * append of claim, transition and audit — lives in `r1_draft_claim_task_completion`, inside one
 * transaction, where nothing that calls it can skip them.
 *
 * That placement is the point. A rule enforced here is enforced for callers who come through here;
 * a rule enforced in the database is enforced for everyone. Hiding a button is not an authorisation
 * boundary, and neither is a check in a server action.
 *
 * ── Why the request-bound client, and never the service-role client ─────────────────────────
 *
 * The RPC identifies the claimant from `auth.uid()`. Through the service role there is no
 * `auth.uid()` — and the function is not granted to `service_role` at all, so the call would be
 * refused outright. That is the intended shape: a completion claim is a person's report of their
 * own work, and no machine may make one on their behalf.
 */
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { log } from "@/lib/log";

/**
 * What the caller may say.
 *
 * No company, membership, actor, assignee or authority — the RPC derives every one of those and
 * its signature has nowhere to put them. The three `seen*` fields describe the screen the person
 * acted from; they are compared inside the transaction, never trusted.
 */
export interface CompletionClaimInput {
  readonly itemId: string;
  readonly taskId: string;
  readonly seenState: string;
  readonly seenActionId: string | null;
  readonly seenEvidenceDigest: string;
  readonly note?: string | null;
  readonly idempotencyKey?: string | null;
}

export type CompletionClaimResult =
  | { readonly ok: true; readonly result: "claimed" | "duplicate"; readonly linkKind?: string }
  | { readonly ok: false; readonly refusal: string; readonly detail?: string };

/**
 * Record one completion claim.
 *
 * It means exactly one thing: the assigned person reports that their work is complete. It does not
 * mean the action succeeded, the condition is resolved, the evidence was verified or the item may
 * be closed — and the RPC performs no verification and writes no learning signal.
 */
export async function claimTaskCompletion(
  input: CompletionClaimInput,
): Promise<CompletionClaimResult> {
  // Establishes that there IS a session. It does not establish that this person may claim — the
  // RPC does that, from the database, inside the transaction.
  await requireProfile();

  const db = supabaseServer();
  const { data, error } = await db.rpc("r1_draft_claim_task_completion", {
    p_item_id: input.itemId,
    p_task_id: input.taskId,
    p_expected_state: input.seenState,
    p_expected_action_id: input.seenActionId,
    p_expected_evidence_digest: input.seenEvidenceDigest,
    p_note: input.note ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  });

  if (error) {
    log("error", "completion claim rpc failed", {
      event: "completion_claim.rpc_failed",
      // Ids are not business content; the error message may be, so it is logged and not returned.
      itemId: input.itemId,
      error: error.message,
    });
    return { ok: false, refusal: "unavailable", detail: "the claim could not be recorded" };
  }

  const row = (data ?? null) as {
    ok?: boolean;
    refusal?: string;
    result?: string;
    link_kind?: string;
  } | null;

  if (!row || typeof row.ok !== "boolean") {
    // An unrecognised shape is not a success. Guessing would be how a person is told their work
    // was reported when it was not.
    return { ok: false, refusal: "unavailable", detail: "unrecognised response" };
  }

  if (row.ok !== true) return { ok: false, refusal: row.refusal ?? "unknown" };

  // The queue reads from the database, so it must be re-read rather than patched in memory: what
  // the person sees next is the committed state, not what we hoped happened.
  revalidatePath("/app/command/queue");
  revalidatePath("/app/command");

  return {
    ok: true,
    result: row.result === "duplicate" ? "duplicate" : "claimed",
    linkKind: row.link_kind,
  };
}
