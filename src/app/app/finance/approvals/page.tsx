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
import { Card, CardHeader, CardBody, Button, Badge, DataTable, type DataTableColumn } from "@/components/ui";
import { StatusBadge } from "@/components/ui/Badge";
import { fmtDateTime } from "@/lib/format";

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

  const pendingColumns: DataTableColumn<any>[] = [
    { key: "event", header: "Event", render: (r) => {
      const ev = r.financial_event_id ? eventById.get(r.financial_event_id) : null;
      return ev?.event_type ?? "financial event";
    } },
    { key: "amount", header: "Amount", align: "right", render: (r) => {
      const ev = r.financial_event_id ? eventById.get(r.financial_event_id) : null;
      return ev?.amount != null ? fmtMoney(ev.amount, ev.currency ?? undefined) : "—";
    } },
    { key: "progress", header: "Progress", render: (r) => {
      const acts = actionsByReq.get(r.id) ?? [];
      const progress = computeApprovalProgress(acts, r.approvals_required);
      return `${progress.approvals}/${Math.max(1, r.approvals_required)} approvals`;
    } },
    { key: "status", header: "Status", render: (r) => {
      const acts = actionsByReq.get(r.id) ?? [];
      const progress = computeApprovalProgress(acts, r.approvals_required);
      return <StatusBadge status={progress.status} />;
    } },
    { key: "action", header: "Action", render: (r) => {
      const acts = actionsByReq.get(r.id) ?? [];
      const progress = computeApprovalProgress(acts, r.approvals_required);
      const actedUsers = acts.map((a) => a.actorUserId);
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
      return gate.allowed ? (
        <div className="row gap-1 wrap">
          <form action={actOnApproval}>
            <input type="hidden" name="request_id" value={r.id} />
            <input type="hidden" name="decision" value="approve" />
            <Button size="sm" type="submit">Approve</Button>
          </form>
          <form action={actOnApproval}>
            <input type="hidden" name="request_id" value={r.id} />
            <input type="hidden" name="decision" value="reject" />
            <Button variant="danger" size="sm" type="submit">Reject</Button>
          </form>
        </div>
      ) : (
        <span className="small dim">{progress.status === "pending" ? "—" : progress.status}</span>
      );
    } },
  ];

  const logColumns: DataTableColumn<any>[] = [
    { key: "item", header: "Item", render: (r) => <span style={{ fontWeight: 600 }}>{r.description}</span> },
    { key: "decision", header: "Decision", render: (r) =>
      r.status === "resolved" ? <Badge variant="ok">Confirmed</Badge> : <Badge>Dismissed</Badge>,
    },
    { key: "price", header: "Confirmed price", render: (r) =>
      r.resolved_price != null ? fmtMoney(r.resolved_price, r.currency) : "—",
    },
    { key: "dept", header: "Dept", render: (r) => <Badge>{r.department}</Badge> },
    { key: "when", header: "When", render: (r) => <span className="dim small">{fmtDateTime(r.resolved_at)}</span> },
  ];

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

      <Card>
        <CardHeader title="Pending approvals" />
        <CardBody>
          <DataTable
            columns={pendingColumns}
            rows={requests}
            keyExtractor={(r) => r.id}
            emptyTitle="No approval requests"
            emptyDescription="There are no pending requests waiting for your decision."
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Price-confirmation decisions" />
        <CardBody>
          <DataTable
            columns={logColumns}
            rows={log}
            keyExtractor={(r) => r.id}
            emptyTitle="No decisions recorded yet"
            emptyDescription="Resolved or dismissed price confirmations will appear here."
          />
        </CardBody>
      </Card>
    </div>
  );
}
