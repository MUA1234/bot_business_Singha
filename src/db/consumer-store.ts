/**
 * Supabase-backed ports for the consumer pipeline (`src/inngest/processing.ts`).
 *
 * This is the trusted-server side of the pipeline: it uses the service client and
 * therefore MUST scope every write with an explicit company_id (RLS is bypassed by
 * the service role — guide §2, CLAUDE.md company-isolation rule). The pure pipeline
 * decides *what* to write; this module is the only place that talks to Postgres.
 */
import Decimal from "decimal.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { approvalPolicy, type ApprovalPolicy } from "@/schemas/approval-policy";
import { assertTransition, type FinancialEventState } from "@/domain/lifecycle";
import type { AiRunRecord, CostLedger } from "@/ai/gateway";
import type { ModelAttemptTelemetry } from "@/ai/model-policy-router";
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

/** Durable MOD-003 attempt/health telemetry. The unique key makes a replay idempotent. */
export function makeSupabaseModelAttemptTelemetry(db: SupabaseClient): ModelAttemptTelemetry {
  return {
    async recordAttempt(attempt): Promise<void> {
      const { error } = await db.from("ai_model_attempts").upsert({
        company_id: attempt.companyId,
        logical_request_id: attempt.logicalRequestId,
        task: attempt.task,
        provider: attempt.provider,
        model: attempt.model,
        attempt: attempt.attempt,
        outcome: attempt.outcome,
        latency_ms: attempt.latencyMs,
        error_category: attempt.errorCategory ?? null,
      }, { onConflict: "company_id,logical_request_id,attempt", ignoreDuplicates: true });
      if (error) throw new Error(`ai_model_attempts upsert failed: ${error.message}`);
    },
  };
}

/** Returns the explicit company/task ceiling; absent configuration fails closed at the caller. */
export async function loadAiTaskBudget(db: SupabaseClient, companyId: string, task: string): Promise<string | null> {
  const { data: policy, error: policyError } = await db
    .from("ai_model_budget_policies")
    .select("max_cost_usd")
    .eq("company_id", companyId)
    .eq("task", task)
    .eq("is_active", true)
    .maybeSingle();
  if (policyError) throw new Error(`ai_model_budget_policies read failed: ${policyError.message}`);
  if (policy?.max_cost_usd == null) return null;

  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const { data: runs, error: runsError } = await db
    .from("ai_runs")
    .select("cost_usd")
    .eq("company_id", companyId)
    .eq("route", task)
    .gte("created_at", startOfUtcDay.toISOString());
  if (runsError) throw new Error(`ai_runs budget lookup failed: ${runsError.message}`);

  const limit = new Decimal(String(policy.max_cost_usd));
  const spent = (runs ?? []).reduce((total, run) => total.plus(new Decimal(String(run.cost_usd ?? "0"))), new Decimal(0));
  const remaining = limit.minus(spent);
  return remaining.isNegative() ? "0" : remaining.toString();
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

    async recentEventsForDedup(companyId, within, sourceEventId) {
      // TWO exclusions, and BOTH are required. Either one alone leaves the resume path broken.
      //
      //  1. THE EVENT ITSELF. On the first pass the event does not exist yet — `findDuplicates`
      //     runs before `createDraft` — so it cannot appear in its own candidate set. On a RESUME
      //     it does exist, in `draft`, which is not a terminal state and so is not filtered out
      //     below. It would then be scored against itself at 1.0 and `openDuplicateReview` would
      //     try to insert `financial_event_id = matched_event_id`, which 0083's
      //     `duplicate_reviews_distinct_ck` rejects — the pipeline throws on every sweep and the
      //     sweeper DEAD-LETTERS the payment a reviewer just released. Reproduced end to end
      //     before this line existed; see of016-resume-through-real-store.test.ts.
      //
      //  2. COUNTERPARTS A PERSON RULED DISTINCT for this event. Without this the dismissal would
      //     not survive one pass — the same pair would score the same way, raise the same
      //     suspicion, and re-pause the payment. Deliberately narrow: keyed to THIS event, so the
      //     same counterpart is still scored against every other event, and derived from the
      //     authoritative `duplicate_reviews` record rather than a second store of decisions.
      const dismissed = new Set<string>();
      let selfId: string | null = null;
      if (sourceEventId) {
        const { data: fe, error: feErr } = await db
          .from("financial_events")
          .select("id")
          .eq("source_event_id", sourceEventId)
          .maybeSingle();
        if (feErr) throw new Error(`duplicate-dismissal lookup failed: ${feErr.message}`);
        if (fe?.id) {
          selfId = String(fe.id);
          const { data: rows, error: revErr } = await db
            .from("duplicate_reviews")
            .select("matched_event_id")
            .eq("financial_event_id", fe.id)
            .eq("state", "resolved")
            .eq("resolution", "dismissed_distinct");
          // Same rule as the candidate lookup below: a FAILED read is not "nothing was dismissed".
          // Swallowing it would silently re-pause an event a human already released.
          if (revErr) throw new Error(`duplicate-dismissal lookup failed: ${revErr.message}`);
          for (const r of rows ?? []) if (r.matched_event_id) dismissed.add(String(r.matched_event_id));
        }
      }

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
        .filter((r) => r.id && String(r.id) !== selfId && !dismissed.has(String(r.id)))
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
          .select("id, company_id, state")
          .eq("source_event_id", draft.source_event_id)
          .maybeSingle();
        if (exErr) throw new Error(`financial_events lookup failed: ${exErr.message}`);
        if (existing?.id) {
          // FAIL CLOSED on a company mismatch (S-09). Continuing would run policy, approval and
          // duplicate scoring for one company against a financial event owned by another.
          if (existing.company_id !== draft.company_id) {
            throw new Error(
              `source event ${draft.source_event_id} already has a financial event in a different company`,
            );
          }
          // Tell the pipeline WHERE the previous execution stopped, so it resumes rather than
          // replaying the state machine from `detected` against an event that has moved on.
          return {
            financial_event_id: existing.id as string,
            resumedFromState: (existing.state as string | undefined) ?? "draft",
          };
        }
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
        // RESUMABILITY (S-01). The pipeline has two callers and BOTH retry, so a second execution
        // legitimately arrives at a transition whose `from` has already happened. Landing on the
        // TARGET state is success, not failure — treating it as failure burned every retry and
        // dead-lettered a captured payment that was sitting in `awaiting_approval` with no approval
        // request, invisible on every screen. Anything OTHER than the target is still a real error.
        const { data: current, error: readErr } = await db
          .from("financial_events").select("state").eq("id", financialEventId).maybeSingle();
        if (readErr) throw new Error(`transition ${from}→${to} could not verify state: ${readErr.message}`);
        if (current?.state === to) return;      // already there — the previous run did it
        throw new Error(
          `transition ${from}→${to} blocked: event ${financialEventId} is in state ${current?.state ?? "(missing)"} (reason: ${reason})`,
        );
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
      // IDEMPOTENT per financial event (S-01 + migration 0083). A resumed run must find the request
      // the previous one created rather than raising a second one — or dying on the unique index.
      const { data: existing, error: exErr } = await db
        .from("approval_requests").select("id").eq("financial_event_id", input.financial_event_id).maybeSingle();
      if (exErr) throw new Error(`approval_requests lookup failed: ${exErr.message}`);
      if (existing?.id) return { approval_request_id: existing.id as string };

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

    async openDuplicateReview(input) {
      // THE SECOND LAYER, and it lives here because here is where the financial event id exists.
      // `findDuplicates` runs BEFORE `createDraft`, so the pipeline cannot know the id yet — a
      // guard placed there took an argument nothing could supply and was dead code described as
      // live protection. An event scored against ITSELF produces a review whose
      // financial_event_id equals its matched_event_id, which 0083's CHECK rejects outright: the
      // pipeline throws on every sweep and the sweeper dead-letters a payment a reviewer just
      // released. Dropping it here costs nothing and cannot be bypassed by a caller that forgets.
      const selfMatches = input.matches.filter((m) => m.matched_event_id === input.financial_event_id);
      if (selfMatches.length) {
        log("warn", "duplicate review: an event matched ITSELF — dropping the self-reference", {
          event: "duplicate.self_match_dropped",
          financialEventId: input.financial_event_id,
          dropped: selfMatches.length,
        });
      }
      const matches = input.matches.filter((m) => m.matched_event_id !== input.financial_event_id);
      if (!matches.length) return;
      input = { ...input, matches };
      // Idempotent per (event, matched event) — migration 0083's unique constraint — so a resumed
      // pipeline run finds the existing review instead of stacking a second one in front of a person.
      for (const m of input.matches) {
        const { error } = await db.from("duplicate_reviews").insert({
          company_id: input.company_id,
          financial_event_id: input.financial_event_id,
          matched_event_id: m.matched_event_id,
          score: m.score,
          feature_contributions: m.contributions ?? {},
          evidence_present: m.evidence_present ?? [],
          evidence_missing: m.evidence_missing ?? [],
          algorithm_version: input.algorithm_version,
        });
        // 23505 is the pair already being open — the expected outcome of a legitimate retry.
        if (error && !/duplicate key|23505/i.test(error.message)) {
          throw new Error(`duplicate_reviews insert failed: ${error.message}`);
        }
      }
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
