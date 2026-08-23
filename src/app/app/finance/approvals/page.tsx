/**
 * Approvals workspace (§7, §6.3). Lists approval requests and lets an eligible
 * approver (finance/admin, not the submitter, one action each) approve or reject —
 * status is recomputed by the pure engine. Below it, the price-confirmation decision
 * log. Company-scoped + audited; graceful.
 */
import { requireDepartment } from "@/lib/auth";

import Link from "next/link";
import { supabaseReadClient, supabaseRpcClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { computeApprovalProgress, canActOnApproval, type ApprovalAction } from "@/policy/approval-progress";
import { checkSeparationOfDuties } from "@/policy/authority";
import { getApproverForUser } from "@/lib/access";
import { actOnApproval } from "./actions";

export const metadata = { title: "Approvals — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function ApprovalsPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  // Counted through the capability-gated queue: someone without `finance.duplicate.resolve`
  // sees 0 rather than a number they cannot act on.
  let pausedDuplicates = 0;
  let pausedUnknown = false;
  try {
    const { data, error } = await supabaseRpcClient().rpc("duplicate_review_queue", { p_company: p.companyId });
    // supabase-js RETURNS errors in the result rather than throwing, so the first version's
    // `catch` was never reached and a failed read silently removed the banner — leaving an
    // approver with an empty queue and no warning, which is the precise situation the banner
    // exists to prevent.
    if (error) pausedUnknown = true;
    else {
      // Count DISTINCT paused PAYMENTS, not review rows. One payment that resembles two earlier
      // ones raises two reviews, and counting rows made the banner say "2 payments are paused"
      // when one was. The label says payments, so the number must mean payments.
      const open = ((data ?? []) as { state: string; candidate_event_id: string }[])
        .filter((r) => r.state === "open");
      pausedDuplicates = new Set(open.map((r) => r.candidate_event_id)).size;
    }
  } catch { pausedUnknown = true; }

  const requests = await safe<any>(() =>
    db.from("approval_requests")
      .select("id, status, approvals_required, submitted_by, financial_event_id, created_at")
      .eq("company_id", p.companyId)
      .order("created_at", { ascending: false })
      .limit(100) as any,
  );
  const reqIds = requests.map((r) => r.id);
  const actions = reqIds.length
    ? await safe<any>(() =>
        db.from("approval_actions")
          .select("approval_request_id, actor_user_id, action")
          .eq("company_id", p.companyId)
          .in("approval_request_id", reqIds) as any,
      )
    : [];
  const events = await safe<any>(() =>
    db.from("financial_events").select("id, amount, currency, event_type").eq("company_id", p.companyId) as any,
  );
  const eventById = new Map(events.map((e) => [e.id, e]));
  const actionsByReq = new Map<string, ApprovalAction[]>();
  for (const a of actions) {
    const list = actionsByReq.get(a.approval_request_id) ?? [];
    list.push({ actorUserId: a.actor_user_id, action: a.action });
    actionsByReq.set(a.approval_request_id, list);
  }

  // GOV-005 — load the actor's membership-based authority once, then use the same
  // separation-of-duties engine the action uses to decide whether the button is shown.
  const actorApprover = await getApproverForUser(p.userId, p.companyId);

  const log = await safe<any>(() =>
    db.from("price_confirmations")
      .select("id, description, currency, resolved_price, status, resolved_at, department")
      .eq("company_id", p.companyId)
      .in("status", ["resolved", "dismissed"])
      .order("resolved_at", { ascending: false })
      .limit(100) as any,
  );

  return (
    <div className="stack gap-3">
      <div>
        <h1>Approvals &amp; decisions</h1>
        <p className="muted mt-1">Approve or reject pending requests. Approval is not payment.</p>
      </div>

      {/* OF-016: a payment paused as a suspected duplicate has NO approval request, so it can
          never appear in the list below. Without this line an approver would see an empty queue
          and reasonably conclude there was nothing waiting on them. */}
      {pausedUnknown && (
        <div className="notice err" data-testid="approvals-paused-unknown">
          This page could not check whether any payments are paused as suspected duplicates, so the
          list below may not be everything waiting on you. This is not a statement that there are
          none.
        </div>
      )}
      {pausedDuplicates > 0 && (
        <div className="notice warn" data-testid="approvals-paused-duplicates">
          <strong>{pausedDuplicates}</strong> payment{pausedDuplicates === 1 ? " is" : "s are"} paused
          as {pausedDuplicates === 1 ? "a " : ""}suspected duplicate{pausedDuplicates === 1 ? "" : "s"} and
          {pausedDuplicates === 1 ? " does" : " do"} not appear below — a suspected duplicate has no
          approval request until a person decides.{" "}
          <Link href="/app/finance/duplicate-reviews">Review {pausedDuplicates === 1 ? "it" : "them"}</Link>.
        </div>
      )}

      <div className="card">
        <div className="card-title">Pending approvals</div>
        {requests.length === 0 ? (
          <div className="empty">No approval requests.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Event</th><th className="num">Amount</th><th>Progress</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {requests.map((r) => {
                  const acts = actionsByReq.get(r.id) ?? [];
                  const progress = computeApprovalProgress(acts, r.approvals_required);
                  const ev = r.financial_event_id ? eventById.get(r.financial_event_id) : null;
                  const actedUsers = acts.map((a) => a.actorUserId);
                  // GOV-005: use the same SoD engine the action uses. Default required role
                  // mirrors the policy engine fallback when no policy evaluation row exists.
                  const sod = actorApprover
                    ? checkSeparationOfDuties(actorApprover, ["finance_reviewer"], {
                        submitter_user_id: r.submitted_by,
                        approver_is_beneficiary: false,
                        action: null,
                      })
                    : { allowed: false, reasons: ["no active membership"] };
                  const gate = canActOnApproval({
                    submitterUserId: r.submitted_by,
                    actorUserId: p.userId,
                    actorIsApprover: sod.allowed,
                    alreadyActedUserIds: actedUsers,
                    status: progress.status,
                  });
                  const canAct = gate.allowed;
                  const badge = progress.status === "approved" ? "ok" : progress.status === "rejected" ? "danger" : "warn";
                  return (
                    <tr key={r.id}>
                      <td>{ev?.event_type ?? "financial event"}</td>
                      <td className="num">{ev?.amount != null ? fmtMoney(ev.amount, ev.currency ?? undefined) : "—"}</td>
                      <td className="dim small">{progress.approvals}/{Math.max(1, r.approvals_required)} approvals</td>
                      <td><span className={`badge ${badge}`}>{progress.status}</span></td>
                      <td>
                        {canAct ? (
                          <div className="row gap-1">
                            <form action={actOnApproval}>
                              <input type="hidden" name="request_id" value={r.id} />
                              <input type="hidden" name="decision" value="approve" />
                              <button className="btn sm" type="submit">Approve</button>
                            </form>
                            <form action={actOnApproval}>
                              <input type="hidden" name="request_id" value={r.id} />
                              <input type="hidden" name="decision" value="reject" />
                              <button className="btn ghost sm danger" type="submit">Reject</button>
                            </form>
                          </div>
                        ) : (
                          <span className="small dim">{progress.status === "pending" ? "—" : progress.status}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Price-confirmation decisions</div>
        {log.length === 0 ? (
          <div className="empty">No decisions recorded yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Item</th><th>Decision</th><th>Confirmed price</th><th>Dept</th><th>When</th></tr></thead>
              <tbody>
                {log.map((r: any) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.description}</td>
                    <td>{r.status === "resolved" ? <span className="badge ok">Confirmed</span> : <span className="badge">Dismissed</span>}</td>
                    <td>{r.resolved_price != null ? fmtMoney(r.resolved_price, r.currency) : "—"}</td>
                    <td><span className="badge">{r.department}</span></td>
                    <td className="dim small">{r.resolved_at ? new Date(r.resolved_at).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
