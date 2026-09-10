/**
 * The duplicate-review queue (OF-016).
 *
 * Migration 0083 made duplicate suspicion honest — a score pauses a payment, it never discards one
 * — and then left the paused payment with no screen and no way back. This is that screen. Every
 * pending review from 0083 onwards appears here with no data migration.
 *
 * The reviewer sees BOTH transactions side by side with their own amounts and currencies, the
 * score, what each feature contributed, what evidence was missing, and the rule version that
 * produced the suspicion — so the decision is made from evidence rather than from a number.
 *
 * The read is `duplicate_review_queue`, called through the AUTHENTICATED client. That matters: the
 * function checks `finance.duplicate.resolve` against `auth.uid()` inside its own predicate, so
 * routing it through the service role would return nothing at all. It is the same identity the
 * resolution RPC will re-check under the row locks.
 */
import { requireMembership, membershipHasCapability } from "@/lib/access";
import { supabaseRpcClient } from "@/lib/supabase/read";
import { ReviewCard, type ReviewItem } from "./ReviewCard";
import { DUPLICATE_REVIEW_CAPABILITY } from "./capability";
import { Badge, EmptyState } from "@/components/ui";

export const metadata = { title: "Suspected duplicates — Singha Central" };

export default async function DuplicateReviewsPage() {
  const membership = await requireMembership();
  const allowed = await membershipHasCapability(membership, DUPLICATE_REVIEW_CAPABILITY);

  if (!allowed) {
    return (
      <div className="stack gap-3">
        <h1>Suspected duplicates</h1>
        <div className="notice err" data-testid="dup-forbidden">
          You do not have the <code>{DUPLICATE_REVIEW_CAPABILITY}</code> capability in this company,
          so this queue is not shown. It contains paused payments and their supporting evidence.
        </div>
      </div>
    );
  }

  let items: ReviewItem[] = [];
  let unavailable: string | null = null;
  try {
    const { data, error } = await supabaseRpcClient().rpc("duplicate_review_queue", {
      p_company: membership.companyId,
    });
    // A failed read is NOT an empty queue. Saying "nothing to review" when the query broke is the
    // same class of lie the duplicate detector itself was corrected for.
    if (error) unavailable = error.message;
    else items = (data ?? []) as ReviewItem[];
  } catch (e) {
    unavailable = e instanceof Error ? e.message : "unknown error";
  }

  const open = items.filter((i) => i.state === "open");
  const closed = items.filter((i) => i.state !== "open");

  return (
    <div className="stack gap-4">
      <div>
        <h1 className="m-0">Suspected duplicates</h1>
        <p className="muted mt-1">
          Payments the system paused because they resemble an earlier one. Each is <strong>reversible</strong>
          {" "}and waiting for a person. Nothing here has been discarded.
        </p>
      </div>

      {unavailable ? (
        <div className="notice err" data-testid="dup-unavailable">
          The review queue could not be loaded, so this page cannot tell you whether anything is
          waiting. This is not an empty queue. ({unavailable})
        </div>
      ) : (
        <>
          <div className="row gap-3 items-center">
            <span data-testid="dup-pending-count"><Badge variant="warn">{open.length} awaiting a decision</Badge></span>
            <span className="muted text-sm">{closed.length} resolved</span>
          </div>

          {open.length === 0 ? (
            <div data-testid="dup-empty">
              <EmptyState
                title="Nothing is waiting"
                description="Payments appear here only when the duplicate rule finds a close enough resemblance to ask a person about it."
                icon="inbox"
              />
            </div>
          ) : (
            <ul className="stack gap-4 list-none p-0" data-testid="dup-open-list">
              {open.map((i) => <ReviewCard key={i.review_id} item={i} />)}
            </ul>
          )}

          {closed.length > 0 && (
            <details data-testid="dup-resolved-section">
              <summary>Resolved ({closed.length})</summary>
              <ul className="stack gap-4 list-none p-0 mt-3">
                {closed.map((i) => <ReviewCard key={i.review_id} item={i} />)}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
