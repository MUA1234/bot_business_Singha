/**
 * Supabase-backed ports for the consumer pipeline (`src/inngest/processing.ts`).
 *
 * This is the trusted-server side of the pipeline: it uses the service client and
 * therefore MUST scope every write with an explicit company_id (RLS is bypassed by
 * the service role — guide §2, CLAUDE.md company-isolation rule). The pure pipeline
 * decides *what* to write; this module is the only place that talks to Postgres.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { approvalPolicy, type ApprovalPolicy } from "@/schemas/approval-policy";
import { assertTransition, type FinancialEventState } from "@/domain/lifecycle";
import type { AiRunRecord, CostLedger } from "@/ai/gateway";
import type { ConsumerDeps, LoadedSourceEvent } from "@/inngest/processing";
import { log } from "@/lib/log";

/** The DB-backed subset of ConsumerDeps (everything except the injected `gateway`). */
export type ConsumerStore = Omit<ConsumerDeps, "gateway">;

/**
 * Pure map from an AiRunRecord to the ai_runs row. Includes company_id, latency_ms and
 * source_event_id (the full §WP5.3 trail); company_id is nullable so a run is never
 * dropped. Exported for testing. latency_ms/source_event_id need migration 0027.
 */
export function aiRunRow(run: AiRunRecord): Record<string, unknown> {
  return {
    id: run.ai_run_id,
    company_id: run.company_id ?? null,
    route: run.route,
    model: run.model,
    prompt_version: run.prompt_version,
    input_tokens: run.input_tokens,
    output_tokens: run.output_tokens,
    cost_usd: run.cost_usd,
    validation_ok: run.validation_ok,
    validation_issues: run.validation_issues ?? null,
    confidence_overall: run.confidence_overall,
    correlation_id: run.correlation_id,
    latency_ms: run.latency_ms ?? null,
    source_event_id: run.source_event_id ?? null,
  };
}

/** Cost ledger that persists every AI run (guide §13; §WP5.2/5.3). */
export function makeSupabaseCostLedger(db: SupabaseClient): CostLedger {
  return {
    async record(run: AiRunRecord): Promise<void> {
      const { error } = await db.from("ai_runs").insert(aiRunRow(run));
      // Never throw the pipeline down over a ledger write; surface via console for ops.
      if (error) log("error", "ai_runs insert failed", { event: "ai_runs.insert_failed", aiRunId: run.ai_run_id, error: error.message });
    },
  };
}

export function makeSupabaseConsumerStore(db: SupabaseClient): ConsumerStore {
  return {
    async loadSourceEvent(sourceEventId): Promise<LoadedSourceEvent> {
      const { data, error } = await db
        .from("source_events")
        .select("id, company_id, correlation_id, raw_payload")
        .eq("id", sourceEventId)
        .single();
      if (error || !data) throw new Error(`source_event ${sourceEventId} not found: ${error?.message}`);
      return {
        id: data.id,
        company_id: data.company_id ?? null,
        correlation_id: data.correlation_id,
        content: extractText(data.raw_payload),
      };
    },

    async loadCompanyContext(companyId) {
      let policy: ApprovalPolicy | null = null;
      if (companyId) {
        const { data } = await db
          .from("approval_policies")
          .select("policy")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .maybeSingle();
        if (data?.policy) {
          const parsed = approvalPolicy.safeParse(data.policy);
          policy = parsed.success ? parsed.data : null; // invalid policy → fail-safe (human approval)
        }
      }
      return {
        policy,
        known: { companyKnown: !!companyId, employeeKnown: false, projectKnown: false },
        // Nobody submitted this: the consumer pipeline did. `null` says so, and migration 0081
        // records `submitted_by_source = 'system'` beside it. The previous value here was the
        // literal string "system", which is not a uuid — every approval request the pipeline
        // tried to create failed and the captured payment reached no approver (OF-013).
        submitterUserId: null,
      };
    },

    async recentEventsForDedup(companyId, within) {
      const { data, error } = await db
        .from("financial_events")
        .select("id, amount, currency, transaction_date, counterparty_name")
        .eq("company_id", companyId)
        .not("state", "in", "(rejected,cancelled,duplicate,reversed,superseded)")
        .order("created_at", { ascending: false })
        .limit(50);
      // A FAILED lookup is not "no duplicates". Discarding the error let a broken query read as a
      // clean bill of health, which is the worst possible failure mode for duplicate detection:
      // silent, and it makes every payment look like the first time it was seen.
      if (error) throw new Error(`duplicate-candidate lookup failed: ${error.message}`);
      return (data ?? [])
        .filter((r) => r.id) // scored against the incoming candidate in the pipeline
        .map((r) => ({
          id: r.id as string,
          candidate: {
            company_id: companyId,
            amount: r.amount != null ? String(r.amount) : null,
            currency: (r.currency as string) ?? within.currency,
            transaction_date: r.transaction_date ?? null,
            counterparty_name: r.counterparty_name ?? null,
          },
        }));
    },

    async createDraft(draft) {
      const x = draft.extraction;
      // IDEMPOTENT PER SOURCE EVENT. `processSourceEvent` documents that idempotency is guaranteed
      // upstream by the Inngest function key — true for that caller, and NOT true for the sweeper
      // R1 §4 added, which retries the same event up to five times. Any failure after this insert
      // used to duplicate the drafted payment. Migration 0082 makes a second draft impossible; this
      // returns the existing one so a legitimate retry continues rather than dying on the index.
      if (draft.source_event_id) {
        const { data: existing, error: exErr } = await db
          .from("financial_events")
          .select("id")
          .eq("source_event_id", draft.source_event_id)
          .maybeSingle();
        if (exErr) throw new Error(`financial_events lookup failed: ${exErr.message}`);
        if (existing?.id) return { financial_event_id: existing.id as string };
      }
      const { data, error } = await db
        .from("financial_events")
        .insert({
          company_id: draft.company_id,
          source_event_id: draft.source_event_id,
          event_type: x?.event_type ?? "unknown",
          state: "detected",
          amount: x?.amount ?? null,
          currency: x?.currency ?? null,
          transaction_date: x?.transaction_date ?? null,
          counterparty_name: x?.counterparty_name ?? null,
          purpose: x?.purpose ?? null,
          payment_method: x?.payment_method ?? null,
          paid_by_employee_id: x?.paid_by_employee_id ?? null,
          confidence_overall: x?.confidence.overall ?? null,
          risk_flags: x?.risk_flags ?? [],
          missing_fields: draft.missing_fields,
          recommended_action: draft.recommended_action,
          current_version: 1,
          correlation_id: draft.correlation_id,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`financial_events insert failed: ${error?.message}`);

      // Immutable v1 snapshot (guide §5 financial_event_versions).
      await db.from("financial_event_versions").insert({
        financial_event_id: data.id,
        company_id: draft.company_id,
        version: 1,
        snapshot: (x ?? { extraction: null }) as Record<string, unknown>,
        change_reason: "initial extraction",
      });
      return { financial_event_id: data.id };
    },

    async transitionState(financialEventId, from, to, reason) {
      // Validate the transition the same way the pure pipeline would, then apply it
      // guarded on the current state so a concurrent writer can't corrupt the FSM.
      const check = assertTransition(from as FinancialEventState, to as FinancialEventState);
      if (!check.ok) throw new Error(`${check.error.code}: ${check.error.message}`);
      const { data, error } = await db
        .from("financial_events")
        .update({ state: to, updated_at: new Date().toISOString() })
        .eq("id", financialEventId)
        .eq("state", from)
        .select("id");
      if (error) throw new Error(`transition ${from}→${to} failed: ${error.message}`);
      if (!data || data.length === 0) {
        throw new Error(`transition ${from}→${to} blocked: event ${financialEventId} not in state ${from} (reason: ${reason})`);
      }
    },

    async recordPolicyEvaluation(financialEventId, companyId, decision) {
      await db.from("policy_evaluations").insert({
        company_id: companyId,
        financial_event_id: financialEventId,
        outcome: decision.outcome,
        matched_rule_id: decision.matched_rule_id,
        required_approver_roles: decision.required_approver_roles,
        approvals_required: decision.approvals_required,
        reasons: decision.reasons,
      });
    },

    async createApprovalRequest(input) {
      const { data, error } = await db
        .from("approval_requests")
        .insert({
          company_id: input.company_id,
          financial_event_id: input.financial_event_id,
          status: "pending",
          approvals_required: Math.max(1, input.approvals_required),
          submitted_by: input.submitted_by,
          // Provenance is derived from WHETHER there is a person, never asserted by a caller.
          submitted_by_source: input.submitted_by === null ? "system" : "human",
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`approval_requests insert failed: ${error?.message}`);
      return { approval_request_id: data.id };
    },

    async createClarification(input) {
      await db.from("clarification_requests").insert({
        financial_event_id: input.financial_event_id,
        company_id: input.company_id,
        missing_fields: input.missing_fields,
        message: input.message,
        status: "open",
      });
    },

    async createDuplicateCandidates(input) {
      if (input.matches.length === 0) return;
      await db.from("duplicate_candidates").insert(
        input.matches.map((m) => ({
          company_id: input.company_id,
          financial_event_id: input.financial_event_id,
          matched_event_id: m.matched_event_id,
          score: m.score,
          reasons: m.reasons,
          resolution: "open",
        })),
      );
    },

    async appendAudit(input) {
      await db.from("audit_events").insert({
        company_id: input.company_id,
        actor_type: "system",
        actor_id: "consumer-pipeline",
        action: input.action,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        correlation_id: input.correlation_id,
        source_event_id: input.source_event_id,
        payload: input.payload ?? null,
      });
    },
  };
}

/**
 * Pull the untrusted text out of a stored raw payload. Handles the WhatsApp Cloud API
 * message shape (`text.body`) and falls back to JSON so nothing is silently dropped.
 * The result is treated as UNTRUSTED by the gateway (fenced) — this is just extraction.
 */
export function extractText(rawPayload: unknown): string {
  const p = rawPayload as {
    text?: { body?: string };
    caption?: string;
    button?: { text?: string };
    interactive?: { list_reply?: { title?: string }; button_reply?: { title?: string } };
  } | null;
  if (p?.text?.body) return p.text.body;
  if (p?.caption) return p.caption;
  if (p?.button?.text) return p.button.text;
  const interactive = p?.interactive?.list_reply?.title ?? p?.interactive?.button_reply?.title;
  if (interactive) return interactive;
  try {
    return JSON.stringify(rawPayload);
  } catch {
    return "";
  }
}
