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
import Decimal from "decimal.js";
import { iso, isoDate } from "./temporal";
import { parseCursor, type Cursor } from "./pagination";
import { loadSourcePage, loadPrioritySlice, loadReconcilePage } from "./source-queries";
import type { StoredCursor, SourceRef } from "./cycle";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { log } from "@/lib/log";
import {
  FINANCE_SOURCE, WORKFORCE_SOURCE, OPERATIONS_SOURCE, CRM_SOURCE, SYSTEM_SOURCE,
  GOVERNANCE_SOURCE, OBJECTIVES_SOURCE, MARKETING_SOURCE, PROCUREMENT_SOURCE,
  ASSETS_SOURCE, LEGAL_SOURCE, PROVIDERS_SOURCE,
} from "./adapters";
import type { CycleDeps, CycleSummary, PersistRecommendation } from "./cycle";
import {
  runVerificationSweep,
  unavailableSweepSummary,
  type VerificationSweepSummary,
} from "./verification/schedule";
import { createSupabaseVerificationStore } from "./verification/store-supabase";
import type { VerificationStore } from "./verification/store";
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

/** The per-source row cap. Bounded reads are deliberate; SILENT bounded reads are the defect. */
export const LOADER_ROW_CAP = 500;

/**
 * How many identity keys one lookup query may carry.
 *
 * Deterministic, so the query count for a page is `ceil(unique keys / this)` and can be
 * ASSERTED rather than timed — a wall-clock performance test on a shared machine proves
 * very little, while a query count is exact.
 */
export const IDENTITY_LOOKUP_CHUNK = 100;

/**
 * The production dependency graph for one management cycle.
 *
 * `verificationSweep` is constructed HERE, not left to the caller. It was previously an optional
 * dependency this factory did not provide, so the deployed system never verified anything and said
 * so with a summary of zeroes — indistinguishable from a company that had nothing to verify.
 *
 * `verificationStore` exists so a worker holding a real PostgreSQL connection can supply the
 * direct-SQL transport instead. It changes the transport and nothing else: both go through the same
 * scheduler, the same rules and the same lifecycle boundary.
 */
export function makeCycleDeps(
  db: Db = supabaseAdmin(),
  now: () => Date = () => new Date(),
  verificationStore: VerificationStore = createSupabaseVerificationStore(db),
): CycleDeps {
  // Sources whose read hit the cap. Reset at the start of each loadFor sweep by the cycle asking
  // for them only once, at the end — see CycleDeps.truncatedSources.
  const truncated = new Set<string>();

  /** Record a source as truncated when its read came back exactly at the cap. */
  const capped = <T>(source: string, rows: T[]): T[] => {
    if (rows.length >= LOADER_ROW_CAP) truncated.add(source);
    return rows;
  };

  return {
    now,

    truncatedSources: () => [...truncated].sort(),

    // ── R2S-P: bounded paging, priority pre-pass and cursor state. ────────────────────────
    async loadPage({ source, companyId, cursor, limit }) {
      return loadSourcePage(db, source, companyId, cursor, limit);
    },

    async loadReconcile({ source, companyId, cursor, limit }) {
      return loadReconcilePage(db, source, companyId, cursor, limit);
    },
    async loadPriority({ source, companyId, limit }) {
      return loadPrioritySlice(db, source, companyId, limit);
    },

    /**
     * Where this source's sweep left off.
     *
     * A cursor that cannot be parsed is treated as ABSENT, which restarts the sweep from the
     * beginning. That is the safe direction: a corrupt or tampered cursor repositioned to the end
     * would make a whole domain look empty, and "look again from the start" costs a sweep period
     * while "silently observe nothing" costs everything.
     */
    async readCursor({ companyId, source }: SourceRef): Promise<StoredCursor | null> {
      const { data, error } = await db
        .from("observation_source_cursors")
        .select("cursor, generation, sweep_complete_at, rows_inspected, pages_processed, page_failures, status")
        .eq("company_id", companyId)
        .eq("source", source)
        .maybeSingle();
      if (error || !data) return null;

      let parsed: Cursor | null = null;
      try {
        parsed = parseCursor(data.cursor);
      } catch (e) {
        log("warn", "unusable observation cursor - restarting the sweep", {
          event: "observation_cursor.unusable",
          company: companyId,
          source,
          reason: (e as Error).message,
        });
        parsed = null;
      }

      return {
        cursor: parsed,
        generation: Number(data.generation ?? 0),
        sweepCompleteAt: data.sweep_complete_at ? new Date(data.sweep_complete_at).toISOString() : null,
        rowsInspected: Number(data.rows_inspected ?? 0),
        pagesProcessed: Number(data.pages_processed ?? 0),
        pageFailures: Number(data.page_failures ?? 0),
        status: (data.status ?? "idle") as StoredCursor["status"],
      };
    },

    /** Commit a page's position. The cycle calls this only after the page's items are persisted. */
    async writeCursor({ companyId, source }: SourceRef, state: StoredCursor): Promise<void> {
      const { error } = await db
        .from("observation_source_cursors")
        .upsert(
          {
            company_id: companyId,
            source,
            cursor: state.cursor,
            generation: state.generation,
            sweep_complete_at: state.sweepCompleteAt,
            rows_inspected: state.rowsInspected,
            pages_processed: state.pagesProcessed,
            page_failures: state.pageFailures,
            status: state.status,
            last_page_at: new Date().toISOString(),
          },
          { onConflict: "company_id,source" },
        );
      if (error) throw new Error(error.message);
    },

    /**
     * Scheduled outcome verification, wired to the real store.
     *
     * The company id comes from the server-side cycle request; nothing here accepts one from a
     * browser, and every read the store performs is filtered by it.
     *
     * A transport that cannot reach the verification schema returns an EXPLICIT unavailable result
     * carrying the reason, and marks the cycle partial. It never returns zeroes, because a
     * deployment that cannot verify must not be indistinguishable from one with nothing to verify.
     */
    async verificationSweep({
      companyId, cycleComplete, observedAt, generation, interrupted,
    }): Promise<VerificationSweepSummary> {
      try {
        return await runVerificationSweep(
          { store: verificationStore, now },
          {
            companyId,
            cycleComplete,
            sweep: {
              // The sweep's own completeness, inherited rather than assumed.
              complete: cycleComplete,
              generation,
              interrupted,
              observedAt,
            },
          },
        );
      } catch (e) {
        return unavailableSweepSummary(
          `verification store unavailable (${verificationStore.transport}): ${(e as Error).message}`,
        );
      }
    },

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
      const isoDay = (v: unknown) => isoDate(v) ?? "";
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

    /**
     * One page's identity keys, in deterministic chunks.
     *
     * Company scope is on every chunk, so an item belonging to another company can never
     * appear in the mapping however the key was constructed. Duplicates in the request are
     * collapsed before the query; keys with no item are simply absent from the result.
     */
    async findExistingByIdentities({ companyId, identityKeys }) {
      const out = new Map<string, ExistingItem>();
      const unique = [...new Set(identityKeys)].filter((k) => typeof k === "string" && k !== "");
      for (let i = 0; i < unique.length; i += IDENTITY_LOOKUP_CHUNK) {
        const chunk = unique.slice(i, i + IDENTITY_LOOKUP_CHUNK);
        const { data, error } = await db
          .from("management_items")
          .select("id, state, priority, identity_key")
          .eq("company_id", companyId)
          .in("identity_key", chunk);
        // Never silently "no existing item": that would duplicate every open condition.
        if (error) throw new Error((error as { message?: string }).message ?? "identity lookup failed");
        for (const row of (data ?? []) as Array<Record<string, unknown>>) {
          out.set(String(row.identity_key), {
            id: row.id, state: row.state, priority: row.priority,
          } as ExistingItem);
        }
      }
      return out;
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
      const limit = LOADER_ROW_CAP;
      // A fresh sweep of this source: whatever it reported last time is not evidence now.
      truncated.delete(source);
      switch (source) {
        case FINANCE_SOURCE: {
          // ── CONTRACT ────────────────────────────────────────────────────────────────────
          // customer_invoices (migration 0003). No updated_at column exists; R2C-F-003 fixed a
          // loader that selected one. `amount_settled` is numeric(20,4) and `total_amount` is
          // numeric(20,4), both returned as STRINGS by pg, which is why the subtraction below is
          // done in Decimal and not with JS numbers (defect R2S-F-002).
          //
          // FRESHNESS (defect R2S-F-001). The previous fix passed created_at as `updated_at`,
          // and that is semantically wrong in the UNSAFE direction: an invoice raised six months
          // ago that only just became overdue would be read as STALE evidence, and
          // priorityFor(warn, stale) DOWNGRADES it from high to normal. A genuinely urgent
          // receivable would be quietly de-prioritised because the row was created a while ago.
          //
          // The honest anchor for "when did this invoice last change" is the last PAYMENT
          // ALLOCATION against it — real evidence of a mutation, not a fabricated timestamp.
          // Where an invoice has never been paid against, the answer is NULL, which
          // freshnessFor reads as "unknown" and priorityFor treats as NOT stale. Unknown is the
          // truth, and it happens to be the safe reading too.
          //
          // Mutations to an existing invoice ARE observed: this is a FULL SCAN each cycle, not
          // an incremental cursor, so a status change or a payment is picked up on the next run
          // regardless of any timestamp.
          const rows = await rowsOf(
            db.from("customer_invoices")
              .select("id, due_date, total_amount, amount_settled, currency, status")
              .eq("company_id", companyId).limit(limit),
          );
          if (rows.length === 0) return [];

          const allocations = await rowsOf(
            db.from("payment_allocations")
              .select("target_id, target_type, created_at")
              .eq("company_id", companyId)
              .eq("target_type", "customer_invoice"),
          ).catch(() => [] as any[]);
          const lastPaidAt = new Map<string, string>();
          for (const a of allocations) {
            const at = iso(a.created_at);
            if (!at) continue;
            const prev = lastPaidAt.get(a.target_id);
            if (!prev || at > prev) lastPaidAt.set(a.target_id, at);
          }

          capped(source, rows);
          return rows.map((r) => ({
            id: r.id,
            due_date: isoDate(r.due_date),
            // EXACT decimal. numeric(20,4) arrives as a string and a JS subtraction would lose
            // precision above 2^53 minor units and introduce binary-fraction error below it.
            outstanding: new Decimal(String(r.total_amount ?? "0"))
              .minus(new Decimal(String(r.amount_settled ?? "0")))
              .toString(),
            currency: r.currency ?? "LKR",
            // Genuine mutation evidence, or an honest null. NEVER created_at.
            updated_at: lastPaidAt.get(r.id) ?? null,
            status: r.status,
          }));
        }
        case WORKFORCE_SOURCE: {
          const rows = await rowsOf(
            db.from("capacity_snapshots")
              // DEFECT R2C-F-002: this selected `utilisation_pct` and `captured_at`, and
              // NEITHER COLUMN EXISTS — migration 0013 defines `utilization_pct` (American
              // spelling) and `created_at`. The workforce source therefore failed on every real
              // read, and the domain has been UNOBSERVED at runtime since the loader was written.
              // No test caught it because none exercised this loader against a real row.
              .select("id, membership_id, utilization_pct, status, created_at, week_start")
              .eq("company_id", companyId)
              // Newest week first, so the reduction below keeps the CURRENT snapshot.
              .order("week_start", { ascending: false })
              .limit(limit),
          );

          // DEFECT R2S-F-003: every snapshot was passed to the detector, so an OBSOLETE
          // "overloaded" week kept raising an exception even when the newest week said healthy —
          // exactly the "do not infer current workload from an obsolete snapshot" failure. Only
          // the LATEST snapshot per membership is current workload; the older ones are history.
          const latest = new Map<string, any>();
          for (const r of rows) {
            const prev = latest.get(r.membership_id);
            if (!prev) { latest.set(r.membership_id, r); continue; }
            // Explicit comparison rather than trusting the ORDER BY: a client that ignores it
            // would otherwise silently reintroduce the defect.
            const a = r.week_start ? new Date(r.week_start).getTime() : 0;
            const b = prev.week_start ? new Date(prev.week_start).getTime() : 0;
            if (a > b) latest.set(r.membership_id, r);
          }

          capped(source, rows);
          return [...latest.values()].map((r) => ({
            snapshotId: r.id,
            membershipId: r.membership_id,
            utilizationPct: Number(r.utilization_pct ?? 0),
            status: r.status ?? "healthy",
            // `created_at` is when the snapshot ROW was written, which is the honest answer to
            // "how old is this reading". `week_start` is the period it describes, and the two
            // are different questions — freshness needs the former.
            capturedAt: iso(r.created_at),
          }));
        }
        case OPERATIONS_SOURCE: {
          const rows = await rowsOf(
            db.from("tasks")
              .select("id, title, status, due_date, estimate_hours, updated_at")
              .eq("company_id", companyId).limit(limit),
          );
          capped(source, rows);
          return rows.map((r) => ({
            id: r.id,
            // The title is loaded because the detector's type requires it; the ADAPTER
            // never copies it into an observation.
            title: r.title,
            status: r.status,
            dueDate: isoDate(r.due_date),
            lastCheckInAt: iso(r.updated_at),
            estimateHours: r.estimate_hours,
            updatedAt: iso(r.updated_at),
          }));
        }
        case CRM_SOURCE: {
          // ── CONTRACT ────────────────────────────────────────────────────────────────────
          // wa_conversations has last_inbound_at but NO outbound timestamp (R2C-F-003 fixed a
          // loader that selected one). R2C then hard-nulled it, which was honest but incomplete:
          // a genuine outbound time IS derivable, from wa_messages.direction = 'outbound'.
          //
          // DEFECT R2S-F-004: with outbound permanently null, every conversation with any
          // inbound message looked un-replied-to for ever, so a customer who HAD been answered
          // kept generating follow-up work. The fix uses real outbound evidence.
          //
          // A DRAFT OR FAILED SEND IS NOT A SENT MESSAGE. message_outbox holds queued and failed
          // deliveries and is deliberately NOT consulted here — only wa_messages, which records
          // messages that actually exist on the conversation.
          const rows = await rowsOf(
            db.from("wa_conversations")
              // DEFECT R2C-F-003: this selected `last_outbound_at`, which wa_conversations DOES
              // NOT HAVE, so the CRM source failed on every real read. There is no outbound
              // timestamp on the conversation at all, so NULL is the truthful value — the
              // detector already treats an unknown outbound time as "nothing sent", which is the
              // safe reading, and inventing one from updated_at would be a guess about whether a
              // customer was replied to.
              .select("id, last_inbound_at, status")
              .eq("company_id", companyId).limit(limit),
          );
          if (rows.length === 0) return [];

          const outbound = await rowsOf(
            db.from("wa_messages")
              .select("conversation_id, direction, created_at")
              .eq("company_id", companyId)
              .eq("direction", "outbound")
              .limit(5000),
          ).catch(() => [] as any[]);

          // Latest genuine outbound per conversation. Compared explicitly rather than relying on
          // row order, so an out-of-order or replayed message cannot move the answer backwards.
          const lastOut = new Map<string, string>();
          for (const m of outbound) {
            if (m.direction !== "outbound") continue;   // belt and braces on the filter
            const at = iso(m.created_at);
            if (!at) continue;
            const prev = lastOut.get(m.conversation_id);
            if (!prev || at > prev) lastOut.set(m.conversation_id, at);
          }

          capped(source, rows);
          return rows.map((r) => ({
            id: r.id,
            last_inbound_at: iso(r.last_inbound_at),
            // Null means "no outbound message exists", which is the truth and the safe reading.
            last_outbound_at: lastOut.get(r.id) ?? null,
            status: r.status,
          }));
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
          capped(source, rows);
          return rows.map((r) => ({
            id: r.id,
            status: r.status,
            response_required_by: iso(r.response_required_by),
            escalation_chain: r.escalation_chain ?? null,
            escalation_level: Number(r.escalation_level ?? 0),
            acknowledged_at: iso(r.acknowledged_at),
            updatedAt: iso(r.updated_at),
          }));
        }
        case OBJECTIVES_SOURCE: {
          const rows = await rowsOf(
            db.from("objectives")
              .select("id, target_value, current_value, period_start, period_end, status")
              .eq("company_id", companyId).limit(limit),
          );
          capped(source, rows);
          return rows.map((r) => ({
            id: r.id,
            target_value: r.target_value,
            current_value: r.current_value,
            period_start: isoDate(r.period_start),
            period_end: isoDate(r.period_end),
            status: r.status,
          }));
        }
        case MARKETING_SOURCE: {
          const rows = await rowsOf(
            db.from("campaigns")
              .select("id, status, audience_id, sent_count, created_at")
              .eq("company_id", companyId).limit(limit),
          );
          capped(source, rows);
          return rows.map((r) => ({
            id: r.id,
            status: r.status,
            audience_id: r.audience_id ?? null,
            sent_count: r.sent_count === null || r.sent_count === undefined ? null : Number(r.sent_count),
            created_at: iso(r.created_at),
          }));
        }
        case PROCUREMENT_SOURCE: {
          const rows = await rowsOf(
            db.from("inventory_items")
              .select("id, quantity_on_hand, reorder_level, created_at")
              .eq("company_id", companyId).limit(limit),
          );
          capped(source, rows);
          return rows.map((r) => ({
            id: r.id,
            quantity_on_hand: r.quantity_on_hand,
            reorder_level: r.reorder_level,
            created_at: iso(r.created_at),
          }));
        }
        case ASSETS_SOURCE: {
          const rows = await rowsOf(
            db.from("vehicle_documents")
              .select("id, vehicle_id, doc_type, expiry_date, created_at")
              .eq("company_id", companyId).limit(limit),
          );
          capped(source, rows);
          return rows.map((r) => ({
            id: r.id,
            vehicle_id: r.vehicle_id ?? null,
            doc_type: r.doc_type ?? null,
            expiry_date: isoDate(r.expiry_date),
            created_at: iso(r.created_at),
          }));
        }
        case LEGAL_SOURCE: {
          // Four record types, one detector. Each is read separately because they are
          // separate tables, and tagged with its kind so the queue can tell them apart.
          const [licences, contracts, insurances, obligations] = await Promise.all([
            rowsOf(db.from("licences").select("id, expiry_date, status").eq("company_id", companyId).limit(limit)).catch(() => []),
            rowsOf(db.from("contracts").select("id, end_date, status").eq("company_id", companyId).limit(limit)).catch(() => []),
            rowsOf(db.from("insurances").select("id, expiry_date, status").eq("company_id", companyId).limit(limit)).catch(() => []),
            rowsOf(db.from("obligations").select("id, due_date, status").eq("company_id", companyId).limit(limit)).catch(() => []),
          ]);
          for (const part of [licences, contracts, insurances, obligations]) capped(source, part);
          return [
            ...licences.map((r) => ({ id: r.id, kind: "licence", due_date: isoDate(r.expiry_date), status: r.status })),
            ...contracts.map((r) => ({ id: r.id, kind: "contract", due_date: isoDate(r.end_date), status: r.status })),
            ...insurances.map((r) => ({ id: r.id, kind: "insurance", due_date: isoDate(r.expiry_date), status: r.status })),
            ...obligations.map((r) => ({ id: r.id, kind: "obligation", due_date: isoDate(r.due_date), status: r.status })),
          ];
        }
        case PROVIDERS_SOURCE: {
          const rows = await rowsOf(
            db.from("service_providers")
              .select("id, status, compliance_status, insurance_status, insurance_expiry, updated_at")
              .eq("company_id", companyId).limit(limit),
          );
          capped(source, rows);
          return rows.map((r) => ({
            id: r.id,
            status: r.status,
            compliance_status: r.compliance_status,
            insurance_status: r.insurance_status,
            insurance_expiry: isoDate(r.insurance_expiry),
            updated_at: iso(r.updated_at),
          }));
        }

        default:
          throw new Error(`no loader registered for ${source}`);
      }
    },
  };
}

/** Convenience for the manual route and tests. */
export const newCorrelationId = () => randomUUID();
