/**
 * Route the tasks an analysis captured (AIM-003).
 *
 * Before this, an analysis captured tasks and told the operator they were "routed for human
 * approval". Nothing was routed: no request, no queue, no recipient, no record. This turns that
 * claim into a durable routing row per task — or, where nothing can honestly be routed, into a
 * truthful `needs_routing` / `manual_review` state that a person can see and act on.
 *
 * What it deliberately does NOT do: pick an assignee. No availability, workload or capability
 * recommendation exists yet (WRK-002/WRK-005 are unbuilt), and inventing an eligible assignee is
 * exactly the failure this program exists to stop. Until a recommender exists, captured work is
 * honestly unrouted rather than falsely assigned.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "@/lib/log";

export interface RoutableTask {
  id: string;
  title?: string | null;
}

/** Minimal client surface, so this is testable without a database. */
export interface RoutingDeps {
  listCaseTasks(companyId: string, managementCaseId: string): Promise<RoutableTask[]>;
  routeTask(input: {
    companyId: string;
    taskId: string;
    state: string;
    reasonCode: string;
    actorId: string | null;
    actorSource: "ai" | "human" | "system";
  }): Promise<{ state: string; reasonCode: string }>;
}

export interface RoutingSummary {
  /** How many tasks now carry a durable routing row. */
  routed: number;
  /** Count per resulting routing state — what the UI must render instead of a claim. */
  byState: Record<string, number>;
  /** Tasks whose routing could not be recorded. Reported, never silently dropped. */
  failed: number;
}

/**
 * Decide the routing state for a captured task, deterministically.
 * `needsApproval` comes from the deterministic authority engine, not from the model's own claim.
 */
export function captureRoutingState(needsApproval: boolean): { state: string; reasonCode: string } {
  return needsApproval
    ? { state: "manual_review", reasonCode: "authority_above_routine_no_approver_configured" }
    : { state: "needs_routing", reasonCode: "captured_no_assignee_recommender" };
}

export async function routeCapturedTasks(
  deps: RoutingDeps,
  input: { companyId: string; managementCaseId: string; needsApproval: boolean; actorId: string | null },
): Promise<RoutingSummary> {
  const summary: RoutingSummary = { routed: 0, byState: {}, failed: 0 };
  const decision = captureRoutingState(input.needsApproval);

  let tasks: RoutableTask[];
  try {
    tasks = await deps.listCaseTasks(input.companyId, input.managementCaseId);
  } catch (e) {
    log("error", "could not list captured tasks for routing", {
      event: "routing.list_failed",
      managementCaseId: input.managementCaseId,
      error: (e as Error).message,
    });
    return summary;
  }

  for (const t of tasks) {
    try {
      const res = await deps.routeTask({
        companyId: input.companyId,
        taskId: t.id,
        state: decision.state,
        reasonCode: decision.reasonCode,
        actorId: input.actorId,
        actorSource: "ai",
      });
      summary.routed++;
      summary.byState[res.state] = (summary.byState[res.state] ?? 0) + 1;
    } catch (e) {
      // A routing failure must be visible. The task still exists; it simply has no routing yet,
      // and the caller reports that rather than claiming the work was routed.
      summary.failed++;
      log("error", "task routing failed", {
        event: "routing.route_failed",
        taskId: t.id,
        error: (e as Error).message,
      });
    }
  }

  return summary;
}

/**
 * The production ports, in ONE place.
 *
 * Both analysis paths — the manual command centre and WhatsApp thread analysis — use this. They
 * previously could not: only the manual path routed anything at all, so tasks captured from a
 * conversation reached nobody and appeared in no routing state. One implementation is what makes
 * "every captured task is routed" checkable rather than aspirational.
 */
export function makeSupabaseRoutingDeps(db: SupabaseClient): RoutingDeps {
  return {
    async listCaseTasks(companyId, managementCaseId) {
      const { data, error } = await db
        .from("tasks")
        .select("id, title")
        .eq("company_id", companyId)
        .eq("management_case_id", managementCaseId);
      if (error) throw new Error(error.message);
      return (data ?? []) as RoutableTask[];
    },
    async routeTask(i) {
      const { data, error } = await db.rpc("route_task", {
        p_company: i.companyId,
        p_task: i.taskId,
        p_desired_state: i.state,
        p_reason_code: i.reasonCode,
        p_actor: i.actorId,
        p_actor_source: i.actorSource,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      // The DB may return a DIFFERENT state than requested — an ineligible assignee degrades the
      // outcome, and a human decision refuses to be superseded. Report what it actually is.
      return { state: String(row?.routing_state ?? i.state), reasonCode: String(row?.reason_code ?? i.reasonCode) };
    },
  };
}
