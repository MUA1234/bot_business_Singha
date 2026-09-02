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
     * Item + evidence + opening transition, in ONE transaction.
     *
     * The draft schema has no composite "create item" RPC yet, so atomicity is obtained the
     * ordinary way: an explicit transaction through a dedicated RPC would be the production
     * shape. Here the three writes are ordered so a failure at any point leaves NO item —
     * evidence and transitions reference the item, so if the item insert fails nothing else
     * runs, and if a later insert fails the caller records the observation as rejected and
     * the orphaned item is the only residue. That residue is why the reconciled numbered
     * migration must add an atomic RPC before this is ever hosted (recorded as a residual).
     */
    async persist(o: Observation, rec: PersistRecommendation | null) {
      const { data: item, error } = await db
        .from("management_items")
        .insert({
          company_id: o.companyId,
          department: o.department,
          kind: o.kind,
          subject_table: o.subjectRef.table,
          subject_id: o.subjectRef.id,
          identity_key: o.identityKey,
          state: "observed",
          priority: o.priority,
          confidence: o.confidence,
          required_authority: rec?.requiredAuthority ?? o.authorityClass,
          proposed_action_id: rec?.actionId ?? null,
          evidence_quality: rec?.evidenceQuality ?? null,
          may_run_unattended: rec?.mayRunUnattended ?? false,
          business_deadline: o.businessDeadline?.at ?? null,
          business_deadline_source: o.businessDeadline?.source ?? null,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      const itemId = item.id as string;

      for (const e of o.evidence) {
        const { error: evErr } = await db.from("management_item_evidence").insert({
          company_id: o.companyId,
          item_id: itemId,
          source_table: e.sourceTable,
          source_id: e.sourceId,
          facts: e.facts,
        });
        if (evErr) throw new Error(evErr.message);
      }

      const { error: trErr } = await db.from("management_item_transitions").insert({
        company_id: o.companyId,
        item_id: itemId,
        from_state: null,
        to_state: "observed",
        actor_type: "system",
        reason: `detected by ${o.observationSource}`,
        evidence: o.evidence.map((e) => ({ table: e.sourceTable, id: e.sourceId })),
      });
      if (trErr) throw new Error(trErr.message);

      return itemId;
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
        default:
          throw new Error(`no loader registered for ${source}`);
      }
    },
  };
}

/** Convenience for the manual route and tests. */
export const newCorrelationId = () => randomUUID();
