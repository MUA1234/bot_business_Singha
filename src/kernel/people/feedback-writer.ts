/**
 * Production wiring for the feedback path (R2B, owner Decision 3).
 *
 * One function, one RPC. Every rule — the company boundary, the actor's active authorised
 * membership, the lifecycle evidence a verified outcome requires, the reopened-work refusal, the
 * burst limit and the correction linkage — lives in `r1_draft_record_feedback`, not here. This
 * file's only job is to hand server-derived values across that boundary without adding a second
 * place where a rule could be written differently.
 */
import type { FeedbackWriter } from "./feedback";

// The Supabase client is structurally typed per table; this wiring needs a table-agnostic handle.
// eslint-disable-next-line
type Db = any;

export function makeFeedbackWriter(db: Db): FeedbackWriter {
  return {
    async record(args) {
      const { data, error } = await db.rpc("r1_draft_record_feedback", {
        p_company: args.companyId,
        p_item: args.itemId,
        p_actor: args.actorMembershipId,
        p_feedback_type: args.event,
        p_subject: args.subjectMembershipId,
        p_proposed: args.proposed,
        p_actual: args.actual,
        p_reason: args.reason,
        p_comment: args.comment,
        p_supersedes: args.supersedesId,
      });
      if (error) throw new Error(error.message);
      const result = data as { ok: boolean; feedback_id: string } | null;
      if (!result?.ok || !result.feedback_id) {
        // Never report a write that did not demonstrably happen.
        throw new Error("feedback RPC returned no identifier");
      }
      return { feedbackId: result.feedback_id };
    },
  };
}
