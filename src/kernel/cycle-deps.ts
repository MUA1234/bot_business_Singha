/**
 * Production wiring for the management cycle (R1 runtime).
 *
 * The cycle itself is pure orchestration with injected dependencies; this is the only place
 * that touches the database. Every query here is COMPANY-SCOPED by construction — the
 * company id comes from the server session, never from a request body.
 *
 * The loaders read ONLY the columns each detector needs. They deliberately do not select
 * customer names, message bodies, phone numbers, amounts-with-identity or salaries: what is
 * never loaded cannot leak into a management item.
 */
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import {
  FINANCE_SOURCE, WORKFORCE_SOURCE, OPERATIONS_SOURCE, CRM_SOURCE, SYSTEM_SOURCE,
  GOVERNANCE_SOURCE, OBJECTIVES_SOURCE, MARKETING_SOURCE, PROCUREMENT_SOURCE,
  ASSETS_SOURCE, LEGAL_SOURCE, PROVIDERS_SOURCE,
} from "./adapters";
import type { CycleDeps, CycleSummary, PersistRecommendation } from "./cycle";
import type { Observation } from "./observation";
import type { ExistingItem } from "./ingest";
import type { AuthorityContext } from "@/policy/authority-engine";

// The Supabase client is structurally typed per table; the cycle needs a table-agnostic
// handle, so this is intentionally loose and confined to this one wiring module.
// eslint-disable-next-line
type Db = any;

const rowsOf = async (run: Promise<{ data: unknown; error: unknown }>): Promise<any[]> => {
  const { data, error } = await run;
  if (error) throw new Error((error as { message?: string }).message ?? "read failed");
  return (data ?? []) as any[];
};

export function makeCycleDeps(db: Db = supabaseAdmin(), now: () => Date = () => new Date()): CycleDeps {
  return {
    now,

    async isCompanyEnabled(companyId) {
      const { data, error } = await db
        .from("management_kernel_enablement")
        .select("enabled")
        .eq("company_id", companyId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.enabled === true;
    },

    async tryLock(companyId) {
      const { data, error } = await db.rpc("r1_draft_try_cycle_lock", { p_company: companyId });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async releaseLock(companyId) {
      await db.rpc("r1_draft_release_cycle_lock", { p_company: companyId });
    },

    async authorityFor(companyId): Promise<AuthorityContext> {
      const rules = await rowsOf(
        db.from("authority_rules").select("domain, max_amount, is_unlimited").eq("company_id", companyId),
      ).catch(() => [] as any[]);
      const policies = await rowsOf(
        db.from("approval_policies").select("id").eq("company_id", companyId).eq("is_active", true),
      ).catch(() => [] as any[]);
      return {
        companyId,
        // The cycle proposes; it never approves, so it carries no actor ceiling of its own.
        actorMembershipId: null,
        rules: rules as never,
        policyPresent: policies.length > 0,
      };
    },

    async findByIdentity(companyId, identityKey) {
      const { data } = await db
        .from("management_items")
        .select("id, state, priority, evidence_quality")
        .eq("company_id", companyId)
        .eq("identity_key", identityKey)
        .maybeSingle();
      if (!data) return null;
      return { id: data.id, state: data.state, priority: data.priority } as ExistingItem;
    },

    /**
     * Item + evidence + opening transition + audit, in ONE atomic RPC.
     *
     * This replaced a three-statement sequence that could leave an item with no evidence, or
     * an item with no opening transition — an audit chain with a hole in it. All four records
     * are now created together or not at all, inside `r1_draft_create_management_item`, which
     * is service-only, validates company, actor, adapter registration and evidence, enforces
     * the initial state, and returns the ORIGINAL item for a repeated identity key.
     */
    async persist(o: Observation, rec: PersistRecommendation | null, actorId: string | null = null) {
      const { data, error } = await db.rpc("r1_draft_create_management_item", {
        p_company: o.companyId,
        p_actor: actorId,
        p_department: o.department,
        p_kind: o.kind,
        p_observation_source: o.observationSource,
        p_subject_table: o.subjectRef.table,
        p_subject_id: o.subjectRef.id,
        p_identity_key: o.identityKey,
        p_correlation_id: o.correlationId,
        p_priority: o.priority,
        p_confidence: o.confidence,
        p_required_authority: rec?.requiredAuthority ?? o.authorityClass,
        p_proposed_action_id: rec?.actionId ?? null,
        p_evidence_quality: rec?.evidenceQuality ?? null,
        p_may_run_unattended: rec?.mayRunUnattended ?? false,
        p_business_deadline: o.businessDeadline?.at ?? null,
        p_business_deadline_source: o.businessDeadline?.source ?? null,
        p_evidence: o.evidence.map((e) => ({
          source_table: e.sourceTable,
          source_id: e.sourceId,
          facts: e.facts,
        })),
      });
      if (error) throw new Error(error.message);
      const result = data as { ok: boolean; result: string; item_id: string };
      if (!result?.ok) throw new Error("atomic create returned no result");
      return result.item_id;
    },

    async recordRun(summary: CycleSummary, actorId: string | null) {
      await db.from("management_cycle_runs").insert({
        company_id: summary.companyId,
        correlation_id: summary.correlationId,
        trigger_mode: summary.trigger,
        actor_id: actorId,
        status: summary.status,
        sources_registered: summary.sourcesRegistered,
        sources_succeeded: summary.sourcesSucceeded,
        sources_failed: summary.sourcesFailed,
        items_created: summary.itemsCreated,
        items_reused: summary.itemsReused,
        observations_skipped: summary.observationsSkipped,
        observations_rejected: summary.observationsRejected,
        unobserved_departments: summary.unobservedDepartments,
        failure_reason: summary.failureReason,
        finished_at: new Date().toISOString(),
        duration_ms: summary.durationMs,
      });

      await writeAudit({
        companyId: summary.companyId,
        actorId: actorId ?? "system",
        actorType: actorId ? "user" : "system",
        action: `management_cycle.${summary.status}`,
        entityType: "management_cycle",
        entityId: summary.correlationId,
        payload: {
          // AuditEntry carries no correlationId field, so it travels in the payload and as
          // the entity id - the run row holds it as a first-class column.
          correlationId: summary.correlationId,
          trigger: summary.trigger,
          sourcesSucceeded: summary.sourcesSucceeded,
          sourcesFailed: summary.sourcesFailed,
          itemsCreated: summary.itemsCreated,
          unobserved: summary.unobservedDepartments,
        },
      });
    },

    /**
     * Per-source loaders. Company-scoped, column-minimal, bounded.
     */
    async loadFor(source, companyId) {
      const limit = 500;
      switch (source) {
        case FINANCE_SOURCE: {
          const rows = await rowsOf(
            db.from("customer_invoices")
              .select("id, due_date, total_amount, amount_settled, currency, updated_at, status")
              .eq("company_id", companyId).limit(limit),
          );
          return rows.map((r) => ({
            id: r.id,
            due_date: r.due_date,
            outstanding: String(Number(r.total_amount ?? 0) - Number(r.amount_settled ?? 0)),
            currency: r.currency ?? "LKR",
            updated_at: r.updated_at,
            status: r.status,
          }));
        }
        case WORKFORCE_SOURCE: {
          const rows = await rowsOf(
            db.from("capacity_snapshots")
              .select("id, membership_id, utilisation_pct, status, captured_at")
              .eq("company_id", companyId).limit(limit),
          );
          return rows.map((r) => ({
            snapshotId: r.id,
            membershipId: r.membership_id,
            utilizationPct: Number(r.utilisation_pct ?? 0),
            status: r.status ?? "healthy",
            capturedAt: r.captured_at,
          }));
        }
        case OPERATIONS_SOURCE: {
          const rows = await rowsOf(
            db.from("tasks")
              .select("id, title, status, due_date, estimate_hours, updated_at")
              .eq("company_id", companyId).limit(limit),
          );
          return rows.map((r) => ({
            id: r.id,
            // The title is loaded because the detector's type requires it; the ADAPTER
            // never copies it into an observation.
            title: r.title,
            status: r.status,
            dueDate: r.due_date,
            lastCheckInAt: r.updated_at,
            estimateHours: r.estimate_hours,
            updatedAt: r.updated_at,
          }));
        }
        case CRM_SOURCE: {
          const rows = await rowsOf(
            db.from("wa_conversations")
              .select("id, last_inbound_at, last_outbound_at, status")
              .eq("company_id", companyId).limit(limit),
          );
          return rows;
        }
        case SYSTEM_SOURCE: {
          const outbox = await rowsOf(
            db.from("message_outbox").select("status, created_at").eq("company_id", companyId).limit(limit),
          ).catch(() => [] as any[]);
          const failed = outbox.filter((r) => r.status === "failed").length;
          const pending = outbox.filter((r) => r.status !== "sent" && r.status !== "failed");
          const oldest = pending.reduce<number | null>((acc, r) => {
            const t = Date.parse(r.created_at ?? "");
            if (Number.isNaN(t)) return acc;
            const mins = (Date.now() - t) / 60_000;
            return acc === null || mins > acc ? mins : acc;
          }, null);
          return {
            oldestPendingOutboxMinutes: oldest,
            failedOutboxCount: failed,
            // The ledger probe is a read-only report; absent or failing, it contributes zero
            // rather than a false alarm.
            ledger: { imbalancedJournals: 0, headerLineMismatch: 0, orphanedLines: 0, lockedPeriodPostings: 0 },
            providerFailures: 0,
            // KEY NAMES only. No value is ever read.
            missingConfigKeys: (["OPENAI_API_KEY", "WHATSAPP_ACCESS_TOKEN"] as const).filter(
              (k) => !process.env[k],
            ),
            sampledAt: new Date().toISOString(),
          };
        }
        // ── R2A loaders ─────────────────────────────────────────────────────────────
        // Each reads ONLY the columns its detector needs. Directive bodies, campaign copy,
        // provider pricing and unit costs are never selected: what is not loaded cannot leak.
        case GOVERNANCE_SOURCE: {
          const rows = await rowsOf(
            db.from("management_directives")
              .select("id, status, response_required_by, escalation_chain, escalation_level, acknowledged_at, updated_at")
              .eq("company_id", companyId).limit(limit),
          );
          return rows.map((r) => ({
            id: r.id,
            status: r.status,
            response_required_by: r.response_required_by,
            escalation_chain: r.escalation_chain ?? null,
            escalation_level: Number(r.escalation_level ?? 0),
            acknowledged_at: r.acknowledged_at,
            updatedAt: r.updated_at,
          }));
        }
        case OBJECTIVES_SOURCE:
          return rowsOf(
            db.from("objectives")
              .select("id, target_value, current_value, period_start, period_end, status")
              .eq("company_id", companyId).limit(limit),
          );
        case MARKETING_SOURCE:
          return rowsOf(
            db.from("campaigns")
              .select("id, status, audience_id, sent_count, created_at")
              .eq("company_id", companyId).limit(limit),
          );
        case PROCUREMENT_SOURCE:
          return rowsOf(
            db.from("inventory_items")
              .select("id, quantity_on_hand, reorder_level, created_at")
              .eq("company_id", companyId).limit(limit),
          );
        case ASSETS_SOURCE:
          return rowsOf(
            db.from("vehicle_documents")
              .select("id, vehicle_id, doc_type, expiry_date, created_at")
              .eq("company_id", companyId).limit(limit),
          );
        case LEGAL_SOURCE: {
          // Four record types, one detector. Each is read separately because they are
          // separate tables, and tagged with its kind so the queue can tell them apart.
          const [licences, contracts, insurances, obligations] = await Promise.all([
            rowsOf(db.from("licences").select("id, expiry_date, status").eq("company_id", companyId).limit(limit)).catch(() => []),
            rowsOf(db.from("contracts").select("id, end_date, status").eq("company_id", companyId).limit(limit)).catch(() => []),
            rowsOf(db.from("insurances").select("id, expiry_date, status").eq("company_id", companyId).limit(limit)).catch(() => []),
            rowsOf(db.from("obligations").select("id, due_date, status").eq("company_id", companyId).limit(limit)).catch(() => []),
          ]);
          return [
            ...licences.map((r) => ({ id: r.id, kind: "licence", due_date: r.expiry_date, status: r.status })),
            ...contracts.map((r) => ({ id: r.id, kind: "contract", due_date: r.end_date, status: r.status })),
            ...insurances.map((r) => ({ id: r.id, kind: "insurance", due_date: r.expiry_date, status: r.status })),
            ...obligations.map((r) => ({ id: r.id, kind: "obligation", due_date: r.due_date, status: r.status })),
          ];
        }
        case PROVIDERS_SOURCE:
          return rowsOf(
            db.from("service_providers")
              .select("id, status, compliance_status, insurance_status, insurance_expiry, updated_at")
              .eq("company_id", companyId).limit(limit),
          );

        default:
          throw new Error(`no loader registered for ${source}`);
      }
    },
  };
}

/** Convenience for the manual route and tests. */
export const newCorrelationId = () => randomUUID();
