/**
 * Reusable Approvals panel — the Decision Chamber.
 *
 * Used by `/app/finance/approvals` and the spatial workspace.
 *
 * The runtime wiring is UNCHANGED and deliberately preserved:
 *   import { checkSeparationOfDuties } from "@/policy/authority";
 *   checkSeparationOfDuties(
 *   getApproverForUser
 *   supabaseRpcClient().rpc("duplicate_review_queue", { p_company: companyId })
 *
 * What changed is the surface. An approval is the most consequential thing a
 * person does in this system, so it is presented as a decision rather than as a
 * table row with two buttons:
 *
 *   - the CONSEQUENCE leads — the amount and what it does, at a size that
 *     cannot be skimmed past;
 *   - the AUTHORITY REQUIREMENT is stated in words. Where the reader may not
 *     act, the screen says exactly why (separation of duties, already acted,
 *     already decided) instead of silently hiding the controls;
 *   - approval is never presented as payment. That distinction is written on
 *     the surface, not left to be inferred;
 *   - the duplicate-pause warnings keep their exact wording and test ids: they
 *     state what the screen does NOT know, which is the only honest thing to
 *     say when the queue could not be read.
 */
import Link from "next/link";
import { supabaseReadClient, supabaseRpcClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { computeApprovalProgress, canActOnApproval, type ApprovalAction } from "@/policy/approval-progress";
import { checkSeparationOfDuties } from "@/policy/authority";
import { getApproverForUser } from "@/lib/access";
import { actOnApproval } from "@/app/app/finance/approvals/actions";
import { SpatialForm } from "@/components/spatial/SpatialForm";
import { Badge, DataTable, type DataTableColumn } from "@/components/ui";
import { StatusBadge } from "@/components/ui/Badge";
import { fmtDateTime } from "@/lib/format";
import {
  AuthorityNotice,
  Consequence,
  Facts,
  PageHead,
  Section,
  Signal,
  StateNote,
} from "@/components/os/primitives";

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

/**
 * Turn the policy layer's machine reason into a sentence for the person reading
 * it. The reasons come from `canActOnApproval`, which is written for callers and
 * says things like "actor is not an approver" — accurate, but it is not what a
 * finance lead should be shown when they are wondering why there are no buttons.
 * The meaning is preserved exactly; only the wording changes, and an unmapped
 * reason falls through verbatim rather than being swallowed.
 */
function explainGate(reason: string): string {
  const map: Record<string, string> = {
    "actor is not an approver":
      "You do not hold an approver record for this company, so no approval you give would be recorded",
    "submitter cannot approve their own request":
      "You raised this request yourself, and the person who raises a request may never approve it",
    "actor has already acted":
      "You have already recorded a decision on this request",
  };
  if (map[reason]) return map[reason];
  if (reason.startsWith("request is already ")) {
    return `This request is already ${reason.replace("request is already ", "")}`;
  }
  return reason;
}

interface ApprovalsPanelProps {
  userId: string;
  companyId: string;
  embedded?: boolean;
}

export async function ApprovalsPanel({ userId, companyId, embedded }: ApprovalsPanelProps) {
  const db = supabaseReadClient();

  let pausedDuplicates = 0;
  let pausedUnknown = false;
  try {
    const { data, error } = await supabaseRpcClient().rpc("duplicate_review_queue", { p_company: companyId });
    if (error) pausedUnknown = true;
    else {
      const open = ((data ?? []) as { state: string; candidate_event_id: string }[])
        .filter((r) => r.state === "open");
      pausedDuplicates = new Set(open.map((r) => r.candidate_event_id)).size;
    }
  } catch { pausedUnknown = true; }

  const requests = await safe<any>(() =>
    db.from("approval_requests")
      .select("id, status, approvals_required, submitted_by, financial_event_id, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(100) as any,
  );
  const reqIds = requests.map((r) => r.id);
  const actions = reqIds.length
    ? await safe<any>(() =>
        db.from("approval_actions")
          .select("approval_request_id, actor_user_id, action")
          .eq("company_id", companyId)
          .in("approval_request_id", reqIds) as any,
      )
    : [];
  const events = await safe<any>(() =>
    db.from("financial_events").select("id, amount, currency, event_type").eq("company_id", companyId) as any,
  );
  const eventById = new Map(events.map((e) => [e.id, e]));
  const actionsByReq = new Map<string, ApprovalAction[]>();
  for (const a of actions) {
    const list = actionsByReq.get(a.approval_request_id) ?? [];
    list.push({ actorUserId: a.actor_user_id, action: a.action });
    actionsByReq.set(a.approval_request_id, list);
  }

  const actorApprover = await getApproverForUser(userId, companyId);

  const log = await safe<any>(() =>
    db.from("price_confirmations")
      .select("id, description, currency, resolved_price, status, resolved_at, department")
      .eq("company_id", companyId)
      .in("status", ["resolved", "dismissed"])
      .order("resolved_at", { ascending: false })
      .limit(100) as any,
  );

  /** Everything the surface needs to state about one request, derived once. */
  const decisions = requests.map((r) => {
    const ev = r.financial_event_id ? eventById.get(r.financial_event_id) : null;
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
      actorUserId: userId,
      actorIsApprover: sod.allowed,
      alreadyActedUserIds: actedUsers,
      status: progress.status,
    });
    return { r, ev, progress, gate, sod };
  });

  const pending = decisions.filter((d) => d.progress.status === "pending");
  const settled = decisions.filter((d) => d.progress.status !== "pending");

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

  const settledColumns: DataTableColumn<(typeof decisions)[number]>[] = [
    { key: "event", header: "Event", render: (d) => d.ev?.event_type ?? "financial event" },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      render: (d) => (d.ev?.amount != null ? fmtMoney(d.ev.amount, d.ev.currency ?? undefined) : "—"),
    },
    {
      key: "progress",
      header: "Progress",
      render: (d) => `${d.progress.approvals}/${Math.max(1, d.r.approvals_required)} approvals`,
    },
    { key: "status", header: "Status", render: (d) => <StatusBadge status={d.progress.status} /> },
    {
      key: "when",
      header: "Raised",
      render: (d) => <span className="dim small">{fmtDateTime(d.r.created_at)}</span>,
    },
  ];

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      {!embedded && (
        <PageHead
          eyebrow="Decision chamber"
          title="Approvals & decisions"
          lede="Each request below states what it does before it asks you to decide. Approving a payment record is not an instruction to a bank — this system does not move money."
        />
      )}

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

      <Section title="Waiting on a decision" meta={`${pending.length} pending`} />

      {pending.length === 0 ? (
        <StateNote kind="empty" title="No approval requests waiting">
          Nothing is pending your decision right now.
          {pausedUnknown && " Note the warning above: the duplicate-pause queue could not be read, so this is not a complete picture."}
        </StateNote>
      ) : (
        <div className="stack gap-2">
          {pending.map(({ r, ev, progress, gate }) => {
            const amount = ev?.amount != null ? fmtMoney(ev.amount, ev.currency ?? undefined) : null;
            const kind = (ev?.event_type ?? "financial event").replace(/_/g, " ");
            return (
              <article className="card pad-lg is-priority" key={r.id}>
                <Consequence value={amount ?? "Amount not recorded"} tone={amount ? "critical" : "warn"}>
                  {amount ? (
                    <>
                      is recorded against <strong>{kind}</strong> once this is approved. Recording a
                      payment is not making one — no transfer leaves any account through this system.
                    </>
                  ) : (
                    <>
                      This request has no financial event amount attached, so the consequence cannot
                      be stated. Open the underlying record before deciding.
                    </>
                  )}
                </Consequence>

                <Facts
                  items={[
                    { k: "Event type", v: kind },
                    {
                      k: "Amount",
                      v: amount ?? "",
                      numeric: true,
                      missing: !amount,
                    },
                    {
                      k: "Approvals collected",
                      v: `${progress.approvals} of ${Math.max(1, r.approvals_required)}`,
                      numeric: true,
                    },
                    { k: "Still required", v: String(progress.remaining), numeric: true },
                    { k: "Raised", v: fmtDateTime(r.created_at) },
                    {
                      k: "Submitted by",
                      v: r.submitted_by ? "a person in this company" : "the system",
                    },
                    {
                      // The full uuid is an internal identifier, not information
                      // an approver acts on. A short reference is enough to tie
                      // the decision to the record in the audit trail — taken
                      // from the END of the id, because identifiers issued in a
                      // sequence share their leading characters and a prefix
                      // would be identical on every row.
                      k: "Reference",
                      v: r.financial_event_id ? String(r.financial_event_id).slice(-8) : "",
                      missing: !r.financial_event_id,
                    },
                  ]}
                />

                <div className="card-footer">
                  {gate.allowed ? (
                    <>
                      {/* `remaining` counts approvals still outstanding INCLUDING
                        * the reader's own. Saying "N more after yours" without
                        * subtracting it told a sole approver that someone else
                        * still had to sign after them, which was false. */}
                      {progress.remaining > 1 ? (
                        <Signal kind="warn">
                          {progress.remaining - 1} more approval
                          {progress.remaining - 1 === 1 ? "" : "s"} needed after yours
                        </Signal>
                      ) : (
                        <Signal kind="warn">Yours is the last approval required</Signal>
                      )}
                      <div className="row gap-1 wrap">
                        <SpatialForm
                          action={actOnApproval}
                          hidden={{ request_id: r.id, decision: "reject" }}
                          submitLabel="Reject"
                          submitVariant="danger"
                        />
                        <SpatialForm
                          action={actOnApproval}
                          hidden={{ request_id: r.id, decision: "approve" }}
                          submitLabel="Approve"
                        />
                      </div>
                    </>
                  ) : (
                    /* The controls are not merely hidden — the reason is stated,
                     * because "no buttons" is indistinguishable from a bug. */
                    <div style={{ width: "100%" }}>
                      <AuthorityNotice>
                        <strong>You cannot decide this one.</strong> {explainGate(gate.reason)}. It
                        remains pending until someone who may act does so — this is a
                        separation-of-duties control, not an error.
                      </AuthorityNotice>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Section title="Already decided" meta={`${settled.length} recorded`} />
      <div className="card">
        <DataTable
          columns={settledColumns}
          rows={settled}
          keyExtractor={(d) => d.r.id}
          emptyTitle="No decisions recorded yet"
          emptyDescription="Approved and rejected requests appear here with the progress they reached."
        />
      </div>

      <Section title="Price-confirmation decisions" meta={`${log.length} recorded`} />
      <div className="card">
        <DataTable
          columns={logColumns}
          rows={log}
          keyExtractor={(r) => r.id}
          emptyTitle="No decisions recorded yet"
          emptyDescription="Resolved or dismissed price confirmations will appear here."
        />
      </div>
    </div>
  );
}
