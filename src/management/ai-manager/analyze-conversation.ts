/**
 * Shared Senior-AI-Manager analysis of a WhatsApp conversation (§WP5.1/5.2). Used by
 * BOTH the manual "Analyse with AI" action and the continuous monitoring cron, so the
 * pipeline is identical: fence untrusted text → observe (through the cost ledger) →
 * plan → capture low-risk tasks → persist a durable, correlation-tied management case.
 *
 * Observe/propose only — it never replies to the customer, moves money, or executes.
 * Company scope + source event are trusted inputs, never taken from the model.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { runManagerObservation } from "@/ai/manager-observation";
import { planFromObservation } from "@/management/ai-manager/pipeline";
import { buildManagementCase } from "@/management/ai-manager/case";
import { caseRow } from "@/management/ai-manager/case-store";
import { makeSupabaseCostLedger } from "@/db/consumer-store";
import { taskIdentityPartsForPlan, threadIdentity } from "@/management/ai-manager/task-identity";
import { makeSupabaseRoutingDeps, routeCapturedTasks, type RoutingSummary } from "@/management/routing/route-captured-tasks";
import { log } from "@/lib/log";

export interface AnalyzeResult {
  ok: boolean;
  reason?: string;
  createdTasks?: number;
  /** AIM-002: proposed tasks that already existed under the same identity and were NOT recreated. */
  deduplicatedTasks?: number;
  /** AIM-003: what actually happened to the captured tasks. */
  routing?: RoutingSummary;
  needsApproval?: boolean;
}

/**
 * Analyse one conversation thread. `db` is a service-role client (worker path).
 * Returns a summary; persists the case + captured tasks. Safe to call repeatedly —
 * it only reads + inserts low-risk `captured` tasks and a case record.
 */
export async function analyzeConversationThread(
  db: SupabaseClient,
  opts: { companyId: string; conversationId: string; actorId: string; actorType?: "user" | "ai" },
): Promise<AnalyzeResult> {
  const { data: messages } = await db
    .from("wa_messages")
    .select("direction, body, created_at")
    .eq("conversation_id", opts.conversationId)
    .eq("company_id", opts.companyId)
    .order("created_at", { ascending: true })
    .limit(200);

  const text = (messages ?? [])
    .filter((m: { body?: string }) => m.body)
    .map((m: { direction: string; body: string }) => `${m.direction === "inbound" ? "Customer" : "Us"}: ${m.body}`)
    .join("\n");
  if (!text.trim()) return { ok: false, reason: "empty" };

  const correlationId = `cor_${randomUUID().slice(0, 8)}`;
  const res = await runManagerObservation(
    makeOpenAiTransport(),
    { update: text, companyId: opts.companyId, sourceEventId: `wa:${opts.conversationId}`, correlationId },
    makeSupabaseCostLedger(db),
  );
  if (!res.ok) return { ok: false, reason: res.reason };

  const plan = planFromObservation(res.observation);

  // Completion P1B — atomic + idempotent persistence: the case, its captured tasks and the audit
  // event commit together or not at all. The idempotency identity is the conversation PLUS the
  // analysed transcript content: re-running on an unchanged thread replays the original case (no
  // duplicate tasks); new messages produce a new identity and a new case. A durability failure is
  // a hard failure — never "analysed" without a durable record.
  const mc = buildManagementCase({
    correlationId,
    companyId: opts.companyId,
    sourceEventId: `wa:${opts.conversationId}`,
    observation: res.observation,
    proposals: [],
    aiRun: { ai_run_id: res.run.ai_run_id, model: res.run.model, prompt_version: res.run.prompt_version, cost_usd: res.run.cost_usd, latency_ms: res.run.latency_ms },
  });
  const idemKey = `wa:${opts.conversationId}:${createHash("sha256").update(text).digest("hex")}`;
  const identity = threadIdentity(opts.conversationId);
  const plannedTasks = plan.tasks.slice(0, 20);
  const taskIdentity = taskIdentityPartsForPlan(plannedTasks.map((t) => t.title), identity);
  const { data: persisted, error: persistErr } = await db.rpc("create_management_case_atomic", {
    p_company: opts.companyId,
    p_idempotency_key: idemKey,
    p_case: { ...caseRow(mc, { createdBy: opts.actorId, createdTasks: 0, requiresHuman: plan.needsApproval }) },
    // AIM-002 — identity is scoped to the CONVERSATION, so the same follow-up re-detected on the
    // next inbound message returns the existing task instead of creating another one.
    p_tasks: plannedTasks.map((t, i) => ({
      title: t.title,
      note: t.note,
      requires_evidence: t.requiresEvidence,
      ...(taskIdentity[i] ?? {}),
    })),
    p_actor: opts.actorId,
    p_audit_action: "manager.thread_analyzed",
  });
  if (persistErr || !persisted) {
    log("error", "management case persistence failed", { event: "case.persist_failed", correlationId, companyId: opts.companyId, error: persistErr?.message ?? "no result" });
    return { ok: false, reason: "persist_failed" };
  }
  const created = Number((persisted as { created_tasks?: number }).created_tasks ?? 0);
  const deduplicated = Number((persisted as { deduplicated_tasks?: number }).deduplicated_tasks ?? 0);
  const caseId = String((persisted as { case_id?: string }).case_id ?? "");
  const isReplay = (persisted as { duplicate?: boolean }).duplicate === true;

  // AIM-003 — this path creates tasks too, so it must route them too. It previously did not, which
  // made "every AI-created task terminates in a truthful routing state" false for the WhatsApp
  // path — the very path AIM-002 was raised for.
  //
  // A REPLAY routes nothing: the tasks already carry a routing state, and re-running would supersede
  // a decision a person may have made since. (The database refuses that too, but the caller should
  // not be asking.)
  const routing = isReplay
    ? { routed: 0, byState: {}, failed: 0 }
    : await routeCapturedTasks(makeSupabaseRoutingDeps(db), {
        companyId: opts.companyId,
        managementCaseId: caseId,
        needsApproval: plan.needsApproval,
      });

  return { ok: true, createdTasks: created, deduplicatedTasks: deduplicated, routing, needsApproval: plan.needsApproval };
}
