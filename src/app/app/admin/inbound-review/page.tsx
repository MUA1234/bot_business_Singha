/**
 * Inbound review queue (FOUND-003).
 *
 * Every inbound message the system honestly could not handle lands here as a ROW, with the reason
 * it could not be handled and the message itself. Before this page existed, `recordForReview` wrote
 * a log line: the message was durable, but nobody was ever going to see it. "Fails closed to manual
 * review" is only true if manual review is a place a person can open.
 *
 * The message text shown here is UNTRUSTED third-party content. It is displayed as data; nothing on
 * this page acts on what it says.
 */
import { requireMembership, membershipHasCapability } from "@/lib/access";
import { supabaseReadClient } from "@/lib/supabase/read";
import { ReviewRow, type ReviewItem } from "./ReviewRow";
import { INBOUND_REVIEW_CAPABILITY } from "./capability";

export const metadata = { title: "Inbound review — Singha Central" };

interface ResolvedRow extends ReviewItem {
  state: string;
  resolution_note: string | null;
  resolved_at: string | null;
}

export default async function InboundReviewPage() {
  const membership = await requireMembership();
  const allowed = await membershipHasCapability(membership, INBOUND_REVIEW_CAPABILITY);

  if (!allowed) {
    return (
      <div className="stack gap-3">
        <h1>Inbound review</h1>
        <div className="notice err">
          You do not have the <code>{INBOUND_REVIEW_CAPABILITY}</code> capability in this company, so
          this queue is not shown. It contains messages sent to the business by people outside it.
        </div>
      </div>
    );
  }

  let open: ResolvedRow[] = [];
  let recentlyClosed: ResolvedRow[] = [];
  let unavailable = false;
  try {
    const db = supabaseReadClient();
    const { data, error } = await db
      .from("inbound_reviews")
      .select(
        "id, channel, provider_message_id, sender_identity, actor_type, identity_match, reason_code, reason_detail, body_excerpt, created_at, state, resolution_note, resolved_at",
      )
      .eq("company_id", membership.companyId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ResolvedRow[];
    open = rows.filter((r) => r.state === "open");
    recentlyClosed = rows.filter((r) => r.state !== "open").slice(0, 20);
  } catch {
    // The table arrives with migration 0075. Say so rather than rendering a confident empty queue.
    unavailable = true;
  }

  return (
    <div className="stack gap-3">
      <div>
        <h1>Inbound review</h1>
        <p className="muted mt-1">
          Messages the system did not act on by itself. Each one is still here, unanswered — nothing
          was sent back to the sender claiming it was handled.
        </p>
      </div>

      {unavailable && (
        <div className="notice err">
          The review queue table is not present in this database yet (migration 0075). Nothing is
          lost — inbound messages are still persisted — but this list cannot be shown.
        </div>
      )}

      {!unavailable && open.length === 0 && (
        <div className="notice ok">Nothing is waiting for a person right now.</div>
      )}

      {open.map((item) => (
        <ReviewRow key={item.id} item={item} />
      ))}

      {recentlyClosed.length > 0 && (
        <div className="card">
          <div className="card-title">Recently closed</div>
          <table className="table mt-2">
            <thead>
              <tr><th>When</th><th>Reason</th><th>Outcome</th><th>Note</th></tr>
            </thead>
            <tbody>
              {recentlyClosed.map((r) => (
                <tr key={r.id}>
                  <td>{r.resolved_at ? new Date(r.resolved_at).toLocaleString() : "—"}</td>
                  <td><code className="small">{r.reason_code}</code></td>
                  <td>{r.state}</td>
                  <td className="muted small">{r.resolution_note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
