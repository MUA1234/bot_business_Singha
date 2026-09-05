/**
 * Management queue — server panel (R1 checkpoint 5).
 *
 * Reads REAL, AUTHORISED data through the existing company-scoped read client. There are no
 * fabricated rows and no demo fixtures on this path: an empty database renders the empty
 * state, and an unreadable one renders the error state. Nothing is invented to fill a screen.
 *
 * The R1 tables live in the quarantined draft schema, so on a database where those drafts
 * have not been applied every read fails — and this panel reports that honestly as
 * "management data is unavailable" rather than as an empty, reassuring queue.
 */
import { supabaseReadClient } from "@/lib/supabase/read";
import {
  ManagementQueuePanelContent,
  type ManagementQueueData,
  type QueueExecution,
  type QueueItem,
  type QueueStage,
} from "./ManagementQueuePanelContent";
import { classificationFor } from "@/kernel/execution/policy";
import { evidenceDigest } from "./evidence-digest";
import { EXECUTION_GLOBALLY_ENABLED } from "@/kernel/execution/boundary";
import { getProfile } from "@/lib/auth";
import { supabaseRpcClient } from "@/lib/supabase/read";
import type { CompletionState } from "@/app/app/_actions/completion-messages";
import type { QueueCompletion } from "./ManagementQueuePanelContent";

interface Props {
  companyId: string;
  /** Rendered inside a spatial window rather than a page. */
  embedded?: boolean;
  focusId?: string | null;
}

const STAGES = new Set<QueueStage>([
  "observed", "recommended", "approved", "needs_routing", "assigned",
  "monitoring", "escalated", "completed", "verified", "rejected", "dismissed", "expired",
]);

export async function ManagementQueuePanel({ companyId, focusId = null }: Props) {
  const db = supabaseReadClient();

  let data: ManagementQueueData | null = null;
  let error: string | null = null;

  try {
    const { data: items, error: itemsError } = await db
      .from("management_items")
      .select(
        "id, department, kind, state, priority, confidence, proposed_action_id, required_authority, " +
          "subject_table, subject_id, " +
          "accountable_owner_id, routing_reason, business_deadline, review_by, review_policy_id, " +
          "monitoring_state, evidence_quality",
      )
      .eq("company_id", companyId)
      .not("state", "in", "(verified,rejected,dismissed,expired)")
      .order("priority", { ascending: true })
      .limit(200);

    if (itemsError) throw new Error(itemsError.message);

    // The Supabase client types a select as a union with an error shape. Existing panels
    // narrow with a cast for exactly this reason; the runtime shape is checked below.
    const rows = (items ?? []) as unknown as Array<Record<string, unknown>>;
    const ids = rows.map((i) => String(i.id));

    const [{ data: evidence }, { data: transitions }, { data: sources }] = await Promise.all([
      ids.length
        ? db.from("management_item_evidence").select("item_id, source_table, source_id, facts").in("item_id", ids)
        : Promise.resolve({ data: [] as never[] }),
      ids.length
        ? db
            .from("management_item_transitions")
            .select("item_id, from_state, to_state, actor_type, reason, created_at")
            .in("item_id", ids)
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [] as never[] }),
      // R2F-F-006: the raw table carries a free-text `last_failure_reason` readable by every
      // member. This projection returns one fact per department — observed, or not — which is
      // everything truthful health reporting needs and nothing else.
      db.rpc("r1_draft_source_health", { p_company: companyId }),
    ]);

    // ── R2E execution state, through the SAME RLS-enforced client ────────────────────────
    //
    // Read separately and tolerantly: on a database where draft 021 is not applied these tables
    // do not exist, and the honest report is "execution history unavailable" rather than a
    // reassuring silence — or, worse, the whole queue failing because of a panel that shows
    // automation status.
    let executionUnavailable = false;
    let companyExecutionEnabled = false;
    const attemptsByItem = new Map<string, Record<string, unknown>>();
    try {
      const [{ data: enablement, error: enErr }, { data: attempts, error: atErr }] =
        await Promise.all([
          db.from("management_execution_enablement").select("enabled").eq("company_id", companyId),
          ids.length
            ? db
                .from("management_execution_attempts")
                .select("item_id, status, refusal_reason, effect_ref, created_at, completed_at")
                .eq("company_id", companyId)
                .in("item_id", ids)
                .order("created_at", { ascending: false })
            : Promise.resolve({ data: [] as never[], error: null }),
        ]);
      if (enErr || atErr) throw new Error(enErr?.message ?? atErr?.message ?? "unreadable");
      companyExecutionEnabled =
        ((enablement ?? []) as Array<Record<string, unknown>>)[0]?.enabled === true;
      // Ordered newest first, so the FIRST row seen for an item is its latest attempt.
      for (const a of (attempts ?? []) as Array<Record<string, unknown>>) {
        const key = String(a.item_id);
        if (!attemptsByItem.has(key)) attemptsByItem.set(key, a);
      }
    } catch {
      executionUnavailable = true;
    }

    const bothBoundariesOpen = EXECUTION_GLOBALLY_ENABLED && companyExecutionEnabled;

    // ── May THIS viewer decide? ──────────────────────────────────────────────────────────
    //
    // Resolved on the server through the repository's own capability function, which reads
    // `auth.uid()` and requires an active membership. It is asked, not assumed: the flag used to
    // be left unset and the panel defaulted to permissive, so every viewer — including staff with
    // no approval permission — was shown decision controls (R2-F-016).
    //
    // FAIL CLOSED. A capability lookup that errors, or returns anything but `true`, means no.
    //
    // Resolved per ITEM, because the authority an item needs is a property of the item. Ordinary
    // approval is `approve` + `reject`; `owner_approval` additionally needs the dedicated owner
    // capability; `specialist_approval` needs the capability registered for that item's own
    // domain, and ten of the twelve domains have none — those can never be decided here, which is
    // what the RPC will say too.
    let baseMayDecide = false;
    let ownerMayDecide = false;
    const specialistHeld = new Map<string, boolean>();
    try {
      const [approve, reject, ownerCap, legalCap, hrCap] = await Promise.all([
        db.rpc("has_capability", { target_company: companyId, capability: "approve" }),
        db.rpc("has_capability", { target_company: companyId, capability: "reject" }),
        db.rpc("has_capability", {
          target_company: companyId, capability: "management.decision.approve_owner",
        }),
        db.rpc("has_capability", { target_company: companyId, capability: "legal.matter.manage" }),
        db.rpc("has_capability", { target_company: companyId, capability: "hr.staff.manage" }),
      ]);
      baseMayDecide = approve.data === true && reject.data === true;
      ownerMayDecide = ownerCap.data === true;
      // The same exhaustive map the database holds. A domain absent from it has no specialist.
      specialistHeld.set("legal", legalCap.data === true);
      specialistHeld.set("workforce", hrCap.data === true);
    } catch {
      baseMayDecide = false;
      ownerMayDecide = false;
      specialistHeld.clear();
    }

    /** May this viewer decide THIS item? Fails closed on anything unrecognised. */
    function mayDecideItem(department: string, requiredAuthority: string | null): boolean {
      if (!baseMayDecide) return false;
      if (requiredAuthority === "owner_approval") return ownerMayDecide;
      if (requiredAuthority === "specialist_approval") {
        // `?? false` is the ten unmapped domains: no registered specialist, never decidable.
        return specialistHeld.get(department) ?? false;
      }
      return true;
    }

    /**
     * The honest execution state for one item.
     *
     * Order matters. `not_eligible` is decided from the POLICY and comes first, because "this
     * action can never run automatically" is true regardless of whether the switches are on — and
     * reporting it as merely "disabled" would imply that turning them on would change it.
     */
    function executionFor(itemId: string, actionId: string | null): QueueExecution {
      const empty: QueueExecution = {
        status: "none", refusalReason: null, effectRef: null, at: null, retryable: false,
      };
      if (executionUnavailable) return { ...empty, status: "unavailable" };
      if (!actionId || classificationFor(actionId) !== "locally_executable") {
        return { ...empty, status: "not_eligible" };
      }

      const a = attemptsByItem.get(itemId);
      if (a) {
        const status = String(a.status);
        return {
          status:
            status === "attempting" ? "claimed"
            : status === "executed" ? "executed"
            : status === "refused" ? "refused"
            : "failed",
          refusalReason: a.refusal_reason ? String(a.refusal_reason) : null,
          effectRef: a.effect_ref ? String(a.effect_ref) : null,
          at: String(a.completed_at ?? a.created_at),
          // A refusal can be retried once its cause is gone; an executed or failed attempt is
          // terminal under its own execution identity.
          retryable: status === "refused",
        };
      }
      return bothBoundariesOpen ? empty : { ...empty, status: "disabled" };
    }

    // ── Completion: may THIS person report THIS work complete? ──────────────────────────
    //
    // Every input is read from the database, and the answer is only ever used to decide what to
    // SHOW. The claim RPC re-establishes all of it inside its own transaction, so a stale page, a
    // permission removed after load, or a task reassigned in the meantime produces a refusal
    // rather than a claim. Hiding the control is a courtesy, not the boundary.
    //
    // The capability is asked through the REQUEST-BOUND client. has_capability answers about
    // auth.uid(), and the service-role client has none — it would answer "no" for everyone, which
    // is fail-closed but not true.
    const viewer = await getProfile();
    let completionUnavailable = false;
    let mayWorkTasks = false;
    const tasksById = new Map<string, Record<string, unknown>>();
    const evidenceCountByTask = new Map<string, number>();
    const claimByItem = new Map<string, Record<string, unknown>>();
    const outcomeByItem = new Map<string, string>();

    /** The two REAL links between an item and a task. They mean different things (R2F-F-012). */
    const linkedTasks = new Map<string, { originating: string | null; effect: string | null }>();
    for (const i of rows) {
      const originating =
        String(i.subject_table ?? "") === "tasks" && i.subject_id ? String(i.subject_id) : null;
      const a = attemptsByItem.get(String(i.id));
      const effect =
        a && String(a.status) === "executed" && a.effect_ref ? String(a.effect_ref) : null;
      linkedTasks.set(String(i.id), { originating, effect });
    }
    const taskIds = [
      ...new Set(
        [...linkedTasks.values()]
          .flatMap((l) => [l.originating, l.effect])
          .filter(Boolean) as string[],
      ),
    ];

    try {
      const cap = await supabaseRpcClient().rpc("has_capability", {
        target_company: companyId,
        capability: "operations.task.work",
      });
      mayWorkTasks = cap.data === true;

      const [tasksRes, taskEvidenceRes, claimsRes, scheduleRes] = await Promise.all([
        taskIds.length
          ? db.from("tasks").select("id, assigned_to, status, requires_evidence")
              .eq("company_id", companyId).in("id", taskIds)
          : Promise.resolve({ data: [] as never[], error: null }),
        taskIds.length
          ? db.from("task_evidence").select("task_id")
              .eq("company_id", companyId).in("task_id", taskIds)
          : Promise.resolve({ data: [] as never[], error: null }),
        ids.length
          ? db.from("management_completion_claims").select("item_id, task_id, claimed_at")
              .eq("company_id", companyId).in("item_id", ids)
          : Promise.resolve({ data: [] as never[], error: null }),
        ids.length
          ? db.from("management_verification_schedule").select("item_id, last_outcome")
              .eq("company_id", companyId).in("item_id", ids)
          : Promise.resolve({ data: [] as never[], error: null }),
      ]);
      const firstError =
        tasksRes.error ?? taskEvidenceRes.error ?? claimsRes.error ?? scheduleRes.error;
      if (firstError) throw new Error((firstError as { message?: string }).message ?? "unreadable");

      for (const t of (tasksRes.data ?? []) as Array<Record<string, unknown>>) {
        tasksById.set(String(t.id), t);
      }
      for (const e of (taskEvidenceRes.data ?? []) as Array<Record<string, unknown>>) {
        const k = String(e.task_id);
        evidenceCountByTask.set(k, (evidenceCountByTask.get(k) ?? 0) + 1);
      }
      for (const c of (claimsRes.data ?? []) as Array<Record<string, unknown>>) {
        claimByItem.set(String(c.item_id), c);
      }
      for (const v of (scheduleRes.data ?? []) as Array<Record<string, unknown>>) {
        if (v.last_outcome) outcomeByItem.set(String(v.item_id), String(v.last_outcome));
      }
    } catch {
      // On a database without the quarantined completion schema this whole block is unreadable.
      // Reported as unavailable, never as "there is nothing for you to do".
      completionUnavailable = true;
    }

    /**
     * The completion state of one item, in the order the person needs to be told things.
     *
     * A claim already made comes FIRST: what happened after it — awaiting a check, the condition
     * persisting, a contradiction — matters more to the claimant than whether they could claim
     * again, and the item's own state has usually moved on by then.
     */
    function completionFor(itemId: string, itemState: string): QueueCompletion {
      const links = linkedTasks.get(itemId) ?? { originating: null, effect: null };
      const claim = claimByItem.get(itemId);
      const none = (state: CompletionState, taskId: string | null = null): QueueCompletion => ({
        state, taskId, linkKind: null, claimedAt: null,
      });

      if (completionUnavailable) return none("unavailable");

      if (claim) {
        const outcome = outcomeByItem.get(itemId);
        const claimedAt = claim.claimed_at ? String(claim.claimed_at) : null;
        const after: CompletionState =
          itemState === "verified"
            ? "verified_resolved"
            : itemState === "reopened"
              ? outcome === "contradicted"
                ? "contradicted"
                : "condition_persists"
              : outcome === "condition_persists" || outcome === "condition_worsened"
                ? "condition_persists"
                : outcome === "contradicted"
                  ? "contradicted"
                  : outcome === "unavailable" || outcome === "pending_clean_observation"
                    ? "verification_unavailable"
                    : "claimed_awaiting_verification";
        return { state: after, taskId: String(claim.task_id), linkKind: null, claimedAt };
      }

      // No claim yet. Which of the two linked tasks is THIS person's, if either?
      const candidates: Array<[string, "originating" | "effect"]> = [];
      if (links.effect) candidates.push([links.effect, "effect"]);
      if (links.originating) candidates.push([links.originating, "originating"]);
      if (candidates.length === 0) return none("not_applicable");

      const mine = candidates.find(
        ([id]) => viewer && String(tasksById.get(id)?.assigned_to ?? "") === viewer.userId,
      );
      const [taskId, linkKind] = mine ?? candidates[0]!;
      const task = tasksById.get(taskId);
      if (!task) return none("unavailable", taskId);

      const base = { taskId, linkKind, claimedAt: null } as const;
      const assignedTo = task.assigned_to ? String(task.assigned_to) : null;
      if (assignedTo === null) return { ...base, state: "task_unassigned" };
      if (!viewer || assignedTo !== viewer.userId) return { ...base, state: "assigned_to_another" };
      if (!mayWorkTasks) return { ...base, state: "capability_missing" };
      // The task's REAL terminal statuses, from the task lifecycle — not a guess about what
      // "finished" means.
      if (!["completed", "cancelled"].includes(String(task.status))) {
        return { ...base, state: "task_not_completed" };
      }
      if (task.requires_evidence === true && (evidenceCountByTask.get(taskId) ?? 0) < 1) {
        return { ...base, state: "evidence_required" };
      }
      if (!["monitoring", "escalated"].includes(itemState)) {
        return { ...base, state: "state_not_claimable" };
      }
      return { ...base, state: "claimable" };
    }

    const evidenceByItem = new Map<string, QueueItem["evidence"]>();
    for (const e of (evidence ?? []) as Array<Record<string, unknown>>) {
      const list = evidenceByItem.get(String(e.item_id)) ?? [];
      list.push({
        sourceTable: String(e.source_table),
        sourceId: String(e.source_id),
        facts: (e.facts ?? {}) as QueueItem["evidence"][number]["facts"],
      });
      evidenceByItem.set(String(e.item_id), list);
    }

    const timelineByItem = new Map<string, QueueItem["timeline"]>();
    for (const t of (transitions ?? []) as Array<Record<string, unknown>>) {
      const list = timelineByItem.get(String(t.item_id)) ?? [];
      list.push({
        at: String(t.created_at),
        from: t.from_state === null ? null : String(t.from_state),
        to: String(t.to_state),
        actorType: String(t.actor_type),
        reason: t.reason === null ? null : String(t.reason),
      });
      timelineByItem.set(String(t.item_id), list);
    }

    // A department whose detector last FAILED is unobserved. Reporting this is what stops an
    // empty queue being read as a healthy business.
    const unobserved = [
      ...new Set(
        ((sources ?? []) as Array<Record<string, unknown>>)
          .filter((s) => s.unobserved === true)
          .map((s) => String(s.department)),
      ),
    ];

    data = {
      items: rows.map((i): QueueItem => {
        const state = String(i.state) as QueueStage;
        return {
          id: String(i.id),
          department: String(i.department),
          summary: String(i.kind).replace(/_/g, " "),
          stage: STAGES.has(state) ? state : "observed",
          priority: (i.priority as QueueItem["priority"]) ?? "normal",
          confidence: Number(i.confidence ?? 0),
          evidence: evidenceByItem.get(String(i.id)) ?? [],
          evidenceQuality: (i.evidence_quality as QueueItem["evidenceQuality"]) ?? "insufficient",
          proposedAction: i.proposed_action_id ? String(i.proposed_action_id) : null,
          requiredAuthority: i.required_authority ? String(i.required_authority) : null,
          accountableOwner: i.accountable_owner_id ? String(i.accountable_owner_id) : null,
          routingReason: i.routing_reason ? String(i.routing_reason) : null,
          businessDeadline: i.business_deadline ? String(i.business_deadline) : null,
          reviewBy: i.review_by ? String(i.review_by) : null,
          reviewPolicyConfigured: i.review_policy_id !== null && i.review_policy_id !== undefined,
          monitoringState: i.monitoring_state ? String(i.monitoring_state) : null,
          timeline: timelineByItem.get(String(i.id)) ?? [],
          execution: executionFor(
            String(i.id),
            i.proposed_action_id ? String(i.proposed_action_id) : null,
          ),
          // The generation this row was built from. A decision carries it back and the server
          // compares it, so a decision taken against a stale screen is refused rather than applied
          // to whatever the item has since become.
          evidenceDigest: evidenceDigest(evidenceByItem.get(String(i.id)) ?? []),
          viewerMayDecide: mayDecideItem(
            String(i.department),
            i.required_authority ? String(i.required_authority) : null,
          ),
          completion: completionFor(String(i.id), String(i.state)),
        };
      }),
      unobservedDepartments: unobserved,
      completeSweep: unobserved.length === 0,
    };
  } catch (e) {
    error = (e as Error).message;
  }

  return <ManagementQueuePanelContent data={data} error={error} focusId={focusId} />;
}

export default ManagementQueuePanel;
export { ManagementQueuePanelContent } from "./ManagementQueuePanelContent";
export type { ManagementQueueData, QueueItem } from "./ManagementQueuePanelContent";
