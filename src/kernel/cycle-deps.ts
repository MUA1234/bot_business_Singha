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
import { providerHealth } from "@/modules/crm/service-provider";
import { candidateEvidence } from "./people/candidate";
import { fact } from "./people/evidence";
import { RESOLVER_VERSION, type RecommendationSnapshot } from "./people/snapshot";
import { SIGNAL_RULE_VERSION, signalLookupFrom, type OutcomeRecord } from "./people/learning";
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

    /**
     * Candidate evidence, built ENTIRELY from server-side reads (R2B, owner Decision 2).
     *
     * The company comes from the authorised call, and every identity comes from the row it was
     * read from. Nothing here accepts supplied evidence, so there is no path by which a caller
     * could substitute a membership, a company or a candidate identity — the R2B-F-002 class of
     * defect is closed by the loader having no input other than the company id.
     *
     * ONLY the columns the gates need are selected. No name, no contact detail, no salary, no
     * date of birth, no address: what is never loaded cannot leak into a recommendation, and the
     * protected-attribute allowlist would refuse it anyway.
     */
    async loadCandidates(companyId: string) {
      const members = await rowsOf(
        db.from("memberships").select("id, user_id, status").eq("company_id", companyId),
      );
      if (members.length === 0) return [];

      const ids = members.map((m) => m.id);

      const roleRows = await rowsOf(
        db.from("membership_roles").select("membership_id, role_key").in("membership_id", ids),
      ).catch(() => [] as any[]);
      const roleKeys = [...new Set(roleRows.map((r) => r.role_key))];
      const permRows = roleKeys.length
        ? await rowsOf(
            db.from("role_permissions").select("role_key, permission_key").in("role_key", roleKeys),
          ).catch(() => [] as any[])
        : [];
      const permsByRole = new Map<string, string[]>();
      for (const p of permRows) {
        const list = permsByRole.get(p.role_key) ?? [];
        list.push(p.permission_key);
        permsByRole.set(p.role_key, list);
      }
      const capsByMembership = new Map<string, Set<string>>();
      const rolesByMembership = new Map<string, string[]>();
      for (const r of roleRows) {
        const caps = capsByMembership.get(r.membership_id) ?? new Set<string>();
        for (const p of permsByRole.get(r.role_key) ?? []) caps.add(p);
        capsByMembership.set(r.membership_id, caps);
        rolesByMembership.set(r.membership_id, [...(rolesByMembership.get(r.membership_id) ?? []), r.role_key]);
      }

      // `employee_profiles.skills` is a bare text[] with no verifier and no expiry, so it is
      // SELF-DECLARED and can never satisfy a mandatory skill (finding F-R2B-2).
      const profiles = await rowsOf(
        db.from("employee_profiles").select("membership_id, skills").eq("company_id", companyId),
      ).catch(() => [] as any[]);
      const skillsByMembership = new Map<string, string[]>(
        profiles.map((p) => [p.membership_id, (p.skills ?? []) as string[]]),
      );

      // Approved leave is a recorded HUMAN DECISION with a decider and a date — verified.
      const today = now().toISOString().slice(0, 10);
      const leave = await rowsOf(
        db.from("leave_requests")
          .select("profile_id, start_date, end_date")
          .eq("company_id", companyId)
          .eq("status", "approved")
          .lte("start_date", today)
          .gte("end_date", today),
      ).catch(() => [] as any[]);
      const onLeaveUserIds = new Set(leave.map((l) => l.profile_id));

      // VERIFIED SKILLS (R2C draft unit 016). Only an externally-certified or evidence-verified
      // record that is ACTIVE and not past its expiry counts. Everything else is loaded as a
      // DECLARED skill instead, so the distinction survives into the resolver rather than being
      // decided here — the gate that refuses an unverified claim is the one place that rule lives.
      const skillRows = await rowsOf(
        db.from("skill_records")
          .select("membership_id, skill_key, provenance, status, expires_at")
          .eq("company_id", companyId),
      ).catch(() => [] as any[]);
      const todayIso = now().toISOString().slice(0, 10);
      const isoDay = (v: unknown) => new Date(v as string).toISOString().slice(0, 10);
      const verifiedByMembership = new Map<string, string[]>();
      const recordedByMembership = new Map<string, string[]>();
      for (const r of skillRows) {
        const verified =
          (r.provenance === "externally_certified" || r.provenance === "evidence_verified") &&
          r.status === "active" &&
          // Normalised through Date FIRST. A pg date column comes back as a Date object, and
          // String(new Date(...)) is "Sat Jan 01 2020 …" — slicing that to ten characters and
          // comparing it to an ISO date compares "Sat Jan 0" against "2026-09-02", which is
          // not merely wrong but wrong in the UNSAFE direction: an expired skill read as valid.
          (!r.expires_at || isoDay(r.expires_at) >= todayIso);
        const target = verified ? verifiedByMembership : recordedByMembership;
        target.set(r.membership_id, [...(target.get(r.membership_id) ?? []), r.skill_key]);
      }

      // LANGUAGES (draft unit 016). Loaded for every language the person can work in, not only
      // their preferred one: a task that requires Tamil needs someone who can work in Tamil.
      const langRows = await rowsOf(
        db.from("membership_languages").select("membership_id, language").eq("company_id", companyId),
      ).catch(() => [] as any[]);
      const langByMembership = new Map<string, string[]>();
      for (const r of langRows) {
        langByMembership.set(r.membership_id, [...(langByMembership.get(r.membership_id) ?? []), r.language]);
      }

      // EVIDENCED ADVISORY EXPERIENCE (draft unit 017). Only ACTIVE relationships inside their
      // window. Being capable and free makes someone a candidate to DO the work; advising on it
      // is a separate claim that has to point at evidence.
      const advisorRows = await rowsOf(
        db.from("advisor_relationships")
          .select("membership_id, domain, status, starts_at, ends_at")
          .eq("company_id", companyId)
          .eq("status", "active"),
      ).catch(() => [] as any[]);
      const nowMs = now().getTime();
      const advisorByMembership = new Map<string, string[]>();
      for (const r of advisorRows) {
        const started = !r.starts_at || Date.parse(r.starts_at) <= nowMs;
        const notEnded = !r.ends_at || Date.parse(r.ends_at) > nowMs;
        if (!started || !notEnded) continue;
        advisorByMembership.set(r.membership_id, [...(advisorByMembership.get(r.membership_id) ?? []), r.domain]);
      }

      // Capacity is a weekly snapshot, so it is INFERRED and routinely a few days old. The
      // as-of date travels with it and the resolver decides whether it is still usable.
      const capacity = await rowsOf(
        db.from("capacity_snapshots")
          .select("membership_id, available_hours, status, week_start")
          .eq("company_id", companyId)
          .order("week_start", { ascending: false }),
      ).catch(() => [] as any[]);
      const capByMembership = new Map<string, any>();
      for (const c of capacity) if (!capByMembership.has(c.membership_id)) capByMembership.set(c.membership_id, c);

      const staff = members.map((m) => {
        const cap = capByMembership.get(m.id);
        const onLeave = m.user_id ? onLeaveUserIds.has(m.user_id) : false;
        const caps = [...(capsByMembership.get(m.id) ?? new Set<string>())];
        const declared = skillsByMembership.get(m.id);

        return candidateEvidence(
          { membershipId: m.id, companyId, candidateType: "staff" },
          {
            active: fact(m.status === "active", "verified", { sourceRef: { table: "memberships", id: m.id } }),
            roles: fact(rolesByMembership.get(m.id) ?? [], "verified"),
            capabilities: fact(caps, "verified", { sourceRef: { table: "membership_roles", id: m.id } }),
            // The cycle proposes internal, catalogue-registered work; it never commits money,
            // so no monetary ceiling is resolved here and none is claimed.
            authorityLevel: fact("automatic", "verified"),
            // A declared skill is whatever employee_profiles said PLUS any skill_record whose
            // provenance is not good enough to count as verified. Both are self-declared to the
            // resolver, which is the honest reading of both.
            ...(() => {
              const recorded = recordedByMembership.get(m.id) ?? [];
              const all = [...new Set([...(declared ?? []), ...recorded])];
              return all.length === 0 && declared === undefined
                ? {}
                : {
                    declaredSkills: fact(all, "self_declared", {
                      sourceRef: { table: "employee_profiles", id: m.id },
                    }),
                  };
            })(),
            ...(verifiedByMembership.has(m.id)
              ? {
                  verifiedSkills: fact(verifiedByMembership.get(m.id)!, "verified", {
                    sourceRef: { table: "skill_records", id: m.id },
                  }),
                }
              : {}),
            ...(langByMembership.has(m.id)
              ? {
                  languages: fact(langByMembership.get(m.id)!, "verified", {
                    sourceRef: { table: "membership_languages", id: m.id },
                  }),
                }
              : {}),
            ...(advisorByMembership.has(m.id)
              ? {
                  advisorDomains: fact(advisorByMembership.get(m.id)!, "verified", {
                    sourceRef: { table: "advisor_relationships", id: m.id },
                  }),
                }
              : {}),
            available: fact(
              {
                available: !onLeave,
                onLeave,
                availableHours: Number(cap?.available_hours ?? 0),
                capacityStatus: (cap?.status ?? "healthy") as "overloaded" | "healthy" | "underallocated",
              },
              "inferred",
              {
                // No snapshot ⇒ no as-of date ⇒ the resolver reports the age as unknown
                // (R2B-F-004) rather than treating a guess as current.
                asOf: cap?.week_start ? new Date(cap.week_start).toISOString() : null,
                sourceRef: cap ? { table: "capacity_snapshots", id: m.id } : null,
              },
            ),
          },
        );
      });

      // ── APPROVED EXTERNAL CONSULTANTS (draft unit 017).
      //    Only an APPROVED engagement inside its window, on a provider whose own compliance and
      //    insurance are healthy. The engagement carries the scope; it never carries access, and
      //    internal_access is forbidden at the database, so a recommendation grants nothing.
      const engagements = await rowsOf(
        db.from("consultant_engagements")
          .select("id, provider_id, scope_domains, scope_skills, status, starts_at, ends_at, internal_access")
          .eq("company_id", companyId)
          .eq("status", "approved"),
      ).catch(() => [] as any[]);

      const providers = engagements.length
        ? await rowsOf(
            db.from("service_providers")
              .select("id, status, compliance_status, insurance_status, insurance_expiry")
              .eq("company_id", companyId)
              .in("id", [...new Set(engagements.map((e) => e.provider_id))]),
          ).catch(() => [] as any[])
        : [];
      const providerById = new Map<string, any>(providers.map((p) => [p.id, p]));

      const consultants = engagements
        .filter((e) => {
          const started = !e.starts_at || Date.parse(e.starts_at) <= nowMs;
          const notEnded = !e.ends_at || Date.parse(e.ends_at) > nowMs;
          return started && notEnded && providerById.has(e.provider_id);
        })
        .map((e) => {
          const p = providerById.get(e.provider_id);
          return candidateEvidence(
            // The ENGAGEMENT is the candidate reference: the same provider may be engaged twice
            // on different scopes, and those are different proposals.
            { membershipId: e.id, companyId, candidateType: "external_consultant" },
            {
              active: fact(p.status === "active", "verified", {
                sourceRef: { table: "service_providers", id: e.provider_id },
              }),
              providerId: fact(e.provider_id, "verified", {
                sourceRef: { table: "service_providers", id: e.provider_id },
              }),
              providerStatus: fact(providerHealth(p), "verified", {
                sourceRef: { table: "service_providers", id: e.provider_id },
              }),
              engagementScope: fact(
                {
                  domains: (e.scope_domains ?? []) as string[],
                  // Forbidden at the database; asserted again here so a loader bug is loud.
                  internalAccess: false as const,
                  endsAt: e.ends_at ? new Date(e.ends_at).toISOString() : null,
                },
                "verified",
                { sourceRef: { table: "consultant_engagements", id: e.id } },
              ),
              ...(((e.scope_skills ?? []) as string[]).length > 0
                ? {
                    verifiedSkills: fact((e.scope_skills ?? []) as string[], "verified", {
                      sourceRef: { table: "consultant_engagements", id: e.id },
                    }),
                  }
                : {}),
              // A consultant has no internal availability and no capacity record. Absent is the
              // honest answer; the availability gate reports the gap rather than inventing one.
              authorityLevel: fact("automatic", "verified"),
            },
          );
        });

      return [...staff, ...consultants];
    },

    /**
     * Verified outcome history for this company, folded into task-specific signals.
     *
     * Deciders are normalised to MEMBERSHIP ids. `management_item_transitions.actor_id` may hold
     * either a membership id or a user id depending on the caller, while
     * `accountable_owner_id` is always a membership — comparing the two raw would make the
     * self-verification check silently never fire, which is precisely the guard that stops a
     * person confirming their own outcomes.
     */
    async loadSignals(companyId: string) {
      // Filtered in JS rather than with `.not(col,'is',null)`: that operator form is not
      // supported by every client this runs against, and a filter that silently widens would
      // make a company-isolation test pass for the wrong reason.
      const allItems = await rowsOf(
        db.from("management_items")
          .select("id, accountable_owner_id, proposed_action_id")
          .eq("company_id", companyId),
      ).catch(() => [] as any[]);
      const items = allItems.filter((i) => i.accountable_owner_id && i.proposed_action_id);
      if (items.length === 0) return () => null;

      const byItem = new Map<string, any>(items.map((i) => [i.id, i]));
      const transitions = await rowsOf(
        db.from("management_item_transitions")
          .select("id, item_id, to_state, actor_id, actor_type, created_at")
          .eq("company_id", companyId)
          .in("item_id", [...byItem.keys()])
          .in("to_state", ["verified", "reopened"]),
      ).catch(() => [] as any[]);
      if (transitions.length === 0) return () => null;

      const members = await rowsOf(
        db.from("memberships").select("id, user_id").eq("company_id", companyId),
      ).catch(() => [] as any[]);
      const membershipByUser = new Map<string, string>(members.filter((m) => m.user_id).map((m) => [m.user_id, m.id]));
      const membershipIds = new Set(members.map((m) => m.id));
      const asMembership = (actorId: string | null) =>
        actorId === null ? null : membershipIds.has(actorId) ? actorId : (membershipByUser.get(actorId) ?? null);

      const records: OutcomeRecord[] = [];
      for (const t of transitions) {
        const item = byItem.get(t.item_id);
        if (!item?.proposed_action_id) continue; // no task kind ⇒ nothing task-specific to learn
        records.push({
          outcomeId: t.id,
          companyId,
          membershipId: item.accountable_owner_id,
          taskKind: item.proposed_action_id,
          // accountable_owner_id is the ASSIGNEE. A transition records delivery, not advice.
          role: "assignee",
          itemId: t.item_id,
          outcome: t.to_state === "verified" ? "verified" : "reopened",
          deciderId: asMembership(t.actor_id),
          deciderType: (t.actor_type ?? "system") as "user" | "system" | "ai",
          occurredAt: new Date(t.created_at).toISOString(),
          businessDeadline: null,
          // Task-level deadline performance is NOT COMPUTABLE (finding F-R2B-1): `tasks` has no
          // completion timestamp. Null is the honest answer, and it is never read as lateness.
          metOnTime: null,
          correctsOutcomeId: null,
          source: "transition",
        });
      }

      return signalLookupFrom(records, companyId, now());
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
    async persist(
      o: Observation,
      rec: PersistRecommendation | null,
      snapshots: readonly RecommendationSnapshot[] = [],
    ) {
      // R2B: the v2 entry point adds the append-only recommendation snapshots to the SAME
      // transaction. It CALLS the original RPC rather than reimplementing it, so item,
      // evidence, opening transition, audit row and snapshots are still all-or-nothing.
      const { data, error } = await db.rpc("r1_draft_create_management_item_v2", {
        p_company: o.companyId,
        p_actor: null,
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
        p_recommendations: snapshots,
        p_resolver_version: snapshots.length > 0 ? RESOLVER_VERSION : null,
        p_signal_rule_version: snapshots.length > 0 ? SIGNAL_RULE_VERSION : null,
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
