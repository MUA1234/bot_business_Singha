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
  type QueueItem,
  type QueueStage,
} from "./ManagementQueuePanelContent";

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
      db.from("observation_sources").select("department, last_failure_at, consecutive_failures"),
    ]);

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
          .filter((s) => Number(s.consecutive_failures ?? 0) > 0 || s.last_failure_at !== null)
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
