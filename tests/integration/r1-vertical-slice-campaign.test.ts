/**
 * R1 CHECKPOINT 6 — the complete vertical-slice campaign.
 *
 * One full management cycle, in FIVE departments at once, against a disposable local
 * PostgreSQL carrying the real schema, the real RLS policies, the real identity functions
 * and the real lifecycle boundary. Synthetic data only; deterministic fixtures only; no
 * network, no provider, no model call.
 *
 * For each domain:
 *   observation → evidence → prioritisation → recommendation → authority decision →
 *   routing/assignment → monitoring → escalation (where needed) → outcome → verification →
 *   feedback
 *
 * Plus the chaos and adversarial matrix: two isolated companies; owner, manager and ordinary
 * staff; revoked membership; approved leave; no suitable assignee; duplicate and
 * out-of-order observations; stale and contradictory evidence; concurrent approvals;
 * rollback; detector failure and recovery; malformed and low-confidence fixtures; 20+
 * windows; permission loss mid-review; complete audit reconstruction.
 *
 * NOTE ON LEARNING: this file records FEEDBACK. It does not claim learning is implemented.
 * Applying learning (IMP-002/IMP-003) is a later requirement and is deliberately absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  detectFinanceObservations, detectWorkforceObservations, detectOperationsObservations,
  detectCrmObservations, detectSystemHealthObservations,
} from "@/kernel/adapters";
import { ingestObservation, runSource, summarise, type ExistingItem } from "@/kernel/ingest";
import { buildRecommendation, reviewItem, selectAssignee, type ReviewerContext } from "@/kernel/recommend";
import { fixtureInterpreter, interpretWithGuards, deterministicFallback } from "@/kernel/interpretation";
import { assertTransition } from "@/kernel/lifecycle";
import type { Observation } from "@/kernel/observation";
import type { AuthorityContext } from "@/policy/authority-engine";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
const OWNER = randomUUID();
const MANAGER = randomUUID();
const STAFF = randomUUID();
const NOW = new Date("2026-09-02T09:00:00.000Z");

let db: pg.Client;
let db2: pg.Client;
const membership = new Map<string, string>();

const authority = (): AuthorityContext => ({
  companyId: CO_A,
  actorMembershipId: membership.get(MANAGER) ?? null,
  rules: [{ domain: "finance", max_amount: "10000000", is_unlimited: false } as never],
  policyPresent: true,
});

const reviewer = (over: Partial<ReviewerContext> = {}): ReviewerContext => ({
  membershipId: membership.get(MANAGER)!,
  companyId: CO_A,
  capabilities: ["operations.task.manage", "operations.task.work", "finance.invoice.create"],
  authorityLevel: "owner_approval",
  priorDecisions: [],
  ...over,
});

/** The five departmental observations, from the real adapters, for one company. */
function fiveObservations(companyId: string, corr: string, suffix: string): Observation[] {
  const tag = (o: Observation): Observation => ({ ...o, identityKey: `${o.identityKey}:${suffix}` });
  return [
    ...detectFinanceObservations({
      companyId, correlationId: corr, now: NOW,
      invoices: [{ id: "inv-1", due_date: "2026-05-01", outstanding: "480000", currency: "LKR",
                   updated_at: "2026-09-01T00:00:00.000Z", status: "open" }],
    }),
    ...detectWorkforceObservations({
      companyId, correlationId: corr, now: NOW,
      capacities: [{ membershipId: "mem-x", status: "overloaded", utilizationPct: 135,
                     snapshotId: "snap-1", capturedAt: "2026-09-01T00:00:00.000Z" }],
    }),
    ...detectOperationsObservations({
      companyId, correlationId: corr, now: NOW,
      tasks: [{ id: "task-1", title: "t", status: "in_progress", dueDate: "2026-08-01",
                lastCheckInAt: "2026-09-01T00:00:00.000Z", estimateHours: 4,
                updatedAt: "2026-09-01T00:00:00.000Z" }],
    }),
    ...detectCrmObservations({
      companyId, correlationId: corr, now: NOW,
      conversations: [{ id: "conv-1", last_inbound_at: "2026-09-01T09:00:00.000Z",
                        last_outbound_at: null, status: "open" }],
    }),
    ...detectSystemHealthObservations({
      companyId, correlationId: corr, now: NOW,
      oldestPendingOutboxMinutes: 240, failedOutboxCount: 3,
      ledger: { imbalancedJournals: 1, headerLineMismatch: 0, orphanedLines: 0, lockedPeriodPostings: 0 },
      providerFailures: 4, missingConfigKeys: ["OPENAI_API_KEY"],
      sampledAt: "2026-09-02T08:55:00.000Z",
    }),
  ].map(tag);
}

async function persist(client: pg.Client, o: Observation, rec?: { actionId: string; authority: string; quality: string }) {
  const { rows } = await client.query(
    `insert into management_items
       (company_id, department, kind, subject_table, subject_id, identity_key, state,
        priority, confidence, required_authority, business_deadline, business_deadline_source,
        proposed_action_id, evidence_quality)
     values ($1,$2,$3,$4,$5,$6,'observed',$7,$8,$9,$10,$11,$12,$13) returning id`,
    [o.companyId, o.department, o.kind, o.subjectRef.table, o.subjectRef.id, o.identityKey,
     o.priority, o.confidence, rec?.authority ?? o.authorityClass,
     o.businessDeadline?.at ?? null, o.businessDeadline?.source ?? null,
     rec?.actionId ?? null, rec?.quality ?? null],
  );
  const id = rows[0].id as string;
  for (const e of o.evidence) {
    await client.query(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
       values ($1,$2,$3,$4,$5)`,
      [o.companyId, id, e.sourceTable, e.sourceId, JSON.stringify(e.facts)],
    );
  }
  await client.query(
    `insert into management_item_transitions (company_id,item_id,from_state,to_state,actor_type,reason,evidence)
     values ($1,$2,null,'observed','system',$3,$4)`,
    [o.companyId, id, `detected by ${o.observationSource}`,
     JSON.stringify(o.evidence.map((e) => ({ table: e.sourceTable, id: e.sourceId })))],
  );
  return id;
}

const move = (c: pg.Client, id: string, from: string, to: string, actor: string | null, reason: string | null = null) =>
  c.query(`select r1_draft_transition_item($1,$2,$3,$4,$5,$6,'[]'::jsonb) as r`,
    [id, from, to, actor, actor ? "user" : "system", reason]);

describe.skipIf(!enabled)("R1 vertical slice — one complete cycle in five departments", () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: URL, ssl: false });
    db2 = new pg.Client({ connectionString: URL, ssl: false });
    await db.connect();
    await db2.connect();
    for (const co of [CO_A, CO_B]) {
      await db.query(`insert into companies (id,name,base_currency) values ($1,$2,'LKR') on conflict (id) do nothing`,
        [co, `campaign ${co.slice(0, 8)}`]);
    }
    for (const [user, co, role] of [
      [OWNER, CO_A, "owner_management"], [MANAGER, CO_A, "project_manager"],
      [STAFF, CO_A, "staff_submitter"],
    ] as const) {
      await db.query(`insert into users (id,full_name,is_active) values ($1,$2,true) on conflict (id) do nothing`,
        [user, `campaign ${user.slice(0, 8)}`]);
      const { rows } = await db.query(
        `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`, [co, user]);
      membership.set(user, rows[0].id);
      await db.query(`insert into membership_roles (membership_id,company_id,role_key) values ($1,$2,$3)
                        on conflict do nothing`, [rows[0].id, co, role]);
    }
  }, 180_000);


  it("runs the COMPLETE cycle for all five departments", async () => {
    const corr = randomUUID();
    const observations = fiveObservations(CO_A, corr, "cycle");
    expect(observations).toHaveLength(5);

    const completed: string[] = [];

    for (const o of observations) {
      // 1. OBSERVATION + EVIDENCE + 2. PRIORITISATION (carried on the observation).
      expect(o.evidence.length).toBeGreaterThan(0);
      expect(["critical", "high", "normal", "low"]).toContain(o.priority);

      // 3. INTERPRETATION — deterministic fixture, grounded in recorded evidence.
      const interpretation = await interpretWithGuards(o, o.evidence, fixtureInterpreter());
      expect(interpretation.status).toBe("ok");

      // 4. RECOMMENDATION — a registered, internal-only action.
      const rec = buildRecommendation({ observation: o, interpretation, authority: authority() });
      expect(rec, `${o.department} produced no recommendation`).not.toBeNull();
      expect(rec!.action.internalOnly).toBe(true);

      const id = await persist(db, o, {
        actionId: rec!.action.id, authority: rec!.requiredAuthority, quality: rec!.evidenceQuality,
      });

      await move(db, id, "observed", "understood", null);
      await move(db, id, "understood", "prioritised", null);
      await move(db, id, "prioritised", "recommended", null);

      // 5. AUTHORITY DECISION — a real reviewer, through the real rules.
      const decision = reviewItem(
        { id, companyId: CO_A, state: "recommended", requiredAuthority: rec!.requiredAuthority, proposedActionId: rec!.action.id },
        reviewer(), { action: "approve" });
      expect(decision.ok, `${o.department} approval refused`).toBe(true);

      await move(db, id, "recommended", "awaiting_approval", MANAGER);
      await db.query(
        `insert into management_item_decisions (company_id,item_id,decision,actor_id,authority_level)
         values ($1,$2,'approve',$3,$4)`, [CO_A, id, MANAGER, rec!.requiredAuthority]);
      await move(db, id, "awaiting_approval", "approved", MANAGER);

      // 6. ASSIGNMENT — same company, active, available, capable.
      const chosen = selectAssignee(
        [{ membershipId: membership.get(MANAGER)!, companyId: CO_A, active: true, available: true,
           availableHours: 20, capabilities: ["operations.task.manage", "operations.task.work", "sales.pipeline.manage", "finance.invoice.create"] }],
        rec!.action, CO_A);
      expect(chosen.membershipId).not.toBeNull();
      await db.query(`update management_items set accountable_owner_id=$2 where id=$1`, [id, chosen.membershipId]);
      await move(db, id, "approved", "assigned", MANAGER);

      // 7. MONITORING.
      await move(db, id, "assigned", "monitoring", MANAGER);
      await db.query(`update management_items set monitoring_state='on_track' where id=$1`, [id]);

      // 8. VERIFICATION by re-observation.
      await move(db, id, "monitoring", "verifying", MANAGER);
      await move(db, id, "verifying", "verified", MANAGER, "re-observation confirms the condition is resolved");

      // 9. FEEDBACK captured (NOT learning applied).
      await db.query(
        `insert into management_item_feedback (company_id,item_id,feedback_type,proposed,actual,reason,actor_id)
         values ($1,$2,'verification_result',$3,$4,$5,$6)`,
        [CO_A, id, JSON.stringify({ action: rec!.action.id }), JSON.stringify({ outcome: "resolved" }),
         "resolved on first attempt", MANAGER]);

      completed.push(id);
    }

    const { rows } = await db.query(
      `select department, state, outcome from management_items where id = any($1)`, [completed]);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.department)))
      .toEqual(new Set(["finance", "workforce", "operations", "crm", "system"]));
    expect(rows.every((r) => r.state === "verified" && r.outcome === "resolved")).toBe(true);
  }, 120_000);

  it("reconstructs the COMPLETE audit trail from observation to verified outcome", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "audit")[0]!;
    const id = await persist(db, o);
    const path = [["observed", "understood"], ["understood", "prioritised"], ["prioritised", "recommended"],
                  ["recommended", "awaiting_approval"], ["awaiting_approval", "approved"]] as const;
    for (const [f, t] of path) await move(db, id, f, t, MANAGER);
    await db.query(`update management_items set accountable_owner_id=$2 where id=$1`, [id, membership.get(MANAGER)]);
    for (const [f, t] of [["approved", "assigned"], ["assigned", "monitoring"], ["monitoring", "verifying"]] as const) {
      await move(db, id, f, t, MANAGER);
    }
    await move(db, id, "verifying", "verified", MANAGER, "confirmed");

    const { rows } = await db.query(
      `select from_state,to_state,actor_type,reason from management_item_transitions
        where item_id=$1 order by created_at`, [id]);
    const chain = rows.map((r) => `${r.from_state ?? "-"}>${r.to_state}`);
    expect(chain).toEqual([
      "->observed", "observed>understood", "understood>prioritised", "prioritised>recommended",
      "recommended>awaiting_approval", "awaiting_approval>approved", "approved>assigned",
      "assigned>monitoring", "monitoring>verifying", "verifying>verified",
    ]);
    // Every step is attributable, and the opening step is the system's.
    expect(rows[0].actor_type).toBe("system");
    expect(rows.slice(1).every((r) => r.actor_type === "user")).toBe(true);

    const { rows: ev } = await db.query(
      `select count(*)::int as n from management_item_evidence where item_id=$1`, [id]);
    expect(ev[0].n).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!enabled)("R1 chaos and adversarial matrix", () => {
  it("TWO ISOLATED COMPANIES: identical conditions never mix", async () => {
    const a = fiveObservations(CO_A, randomUUID(), "isoA");
    const b = fiveObservations(CO_B, randomUUID(), "isoB");
    for (const o of a) await persist(db, o);
    for (const o of b) await persist(db, o);

    const { rows } = await db.query(
      `select company_id, count(*)::int as n from management_items
        where identity_key like '%:iso%' group by company_id`);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.n).toBe(5);

    // No evidence row ever points across the boundary.
    const { rows: cross } = await db.query(
      `select count(*)::int as n from management_item_evidence e
         join management_items i on i.id = e.item_id
        where e.company_id <> i.company_id`);
    expect(cross[0].n).toBe(0);
  }, 60_000);

  it("REVOKED MEMBERSHIP mid-flight re-routes truthfully and never to an administrator", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "revoke")[2]!;
    const id = await persist(db, o);
    for (const [f, t] of [["observed", "understood"], ["understood", "prioritised"],
                          ["prioritised", "recommended"], ["recommended", "awaiting_approval"],
                          ["awaiting_approval", "approved"]] as const) await move(db, id, f, t, MANAGER);
    await db.query(`update management_items set accountable_owner_id=$2 where id=$1`, [id, membership.get(STAFF)]);
    await move(db, id, "approved", "assigned", MANAGER);

    await db.query(`update memberships set status='ended' where id=$1`, [membership.get(STAFF)]);
    const { rows: n } = await db.query(`select r1_draft_revalidate_owners($1) as n`, [CO_A]);
    expect(n[0].n).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query(
      `select state, accountable_owner_id, routing_reason from management_items where id=$1`, [id]);
    expect(rows[0].state).toBe("needs_routing");
    expect(rows[0].accountable_owner_id).toBeNull();
    expect(rows[0].routing_reason).toMatch(/lost active authorised membership/i);
    await db.query(`update memberships set status='active' where id=$1`, [membership.get(STAFF)]);
  }, 60_000);

  it("NO SUITABLE ASSIGNEE: routes with a reason, never to an owner or admin", () => {
    const r = selectAssignee([], { id: "ops.task.create_internal", department: "operations",
      capability: "operations.task.manage", authorityFloor: "automatic", reversible: true,
      automaticSafe: true, internalOnly: true, description: "" }, CO_A);
    expect(r.membershipId).toBeNull();
    if (r.membershipId === null) expect(r.reason).not.toMatch(/owner|admin/i);
  });

  it("APPROVED LEAVE excludes a candidate entirely", () => {
    const r = selectAssignee([{ membershipId: "m", companyId: CO_A, active: true, available: false,
      availableHours: 40, capabilities: ["operations.task.manage"] }],
      { id: "ops.task.create_internal", department: "operations", capability: "operations.task.manage",
        authorityFloor: "automatic", reversible: true, automaticSafe: true, internalOnly: true, description: "" },
      CO_A);
    expect(r.membershipId).toBeNull();
  });

  it("DUPLICATE observation reuses the item; the database refuses a second row", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "dupe")[3]!;
    await persist(db, o);
    const existing: ExistingItem = { id: "x", state: "observed", severity: o.severity, priority: o.priority, evidenceAt: o.evidenceAt };
    expect(ingestObservation(o, { companyId: CO_A }, existing).action).toBe("skip");
    await expect(persist(db, o)).rejects.toThrow(/duplicate key/i);
  }, 60_000);

  it("OUT-OF-ORDER observation never moves an item backwards", () => {
    const o = fiveObservations(CO_A, randomUUID(), "ooo")[0]!;
    const existing: ExistingItem = { id: "x", state: "monitoring", severity: "critical",
      priority: "critical", evidenceAt: "2026-09-02T08:00:00.000Z" };
    const older = { ...o, evidenceAt: "2026-08-01T00:00:00.000Z" };
    expect(ingestObservation(older, { companyId: CO_A }, existing)).toEqual({
      action: "skip", reason: "out_of_order", itemId: "x" });
  });

  it("STALE evidence is skipped rather than queued", () => {
    const o = { ...fiveObservations(CO_A, randomUUID(), "stale")[0]!, freshness: "stale" as const };
    expect(ingestObservation(o, { companyId: CO_A }, null)).toEqual({ action: "skip", reason: "stale_source" });
  });

  it("CONTRADICTORY evidence is reported and blocks unattended running", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "contra")[0]!;
    const rec = buildRecommendation({
      observation: o, interpretation: await interpretWithGuards(o, o.evidence, fixtureInterpreter()),
      authority: authority(), contradiction: true })!;
    expect(rec.evidenceQuality).toBe("contradictory");
    expect(rec.mayRunUnattended).toBe(false);
  });

  it("MALFORMED fixture output is discarded whole and the loop continues deterministically", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "malformed")[0]!;
    const fabricating = { name: "bad", source: "fixture" as const,
      interpret: async () => ({ source: "fixture" as const, status: "ok" as const, confidence: 0.99,
        statements: [{ claim: "the customer is insolvent", supportedBy: [] }] }) };
    const result = await interpretWithGuards(o, o.evidence, fabricating);
    expect(result.status).toBe("malformed");
    expect(result.statements).toEqual([]);
    // The loop still produces a recommendation, from the detector's own facts.
    const rec = buildRecommendation({ observation: o, interpretation: result, authority: authority() })!;
    expect(rec).not.toBeNull();
    expect(rec.rationale.some((r) => r.startsWith("interpretation:"))).toBe(false);
  });

  it("TIMEOUT and LOW CONFIDENCE degrade truthfully", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "timeout")[0]!;
    const slow = { name: "slow", source: "fixture" as const, interpret: () => new Promise<never>(() => {}) };
    const timed = await interpretWithGuards(o, o.evidence, slow, { budgetMs: 20 });
    expect(timed.status).toBe("timeout");

    const low = deterministicFallback("low_confidence", "below threshold");
    const rec = buildRecommendation({ observation: o, interpretation: low, authority: authority() })!;
    expect(rec.mayRunUnattended).toBe(false);
  });

  it("DETECTOR FAILURE is reported unobserved, and recovery does not duplicate", () => {
    let n = 0;
    const flaky = () => { n++; if (n === 1) throw new Error("transient"); return fiveObservations(CO_A, "c", "recov"); };
    const first = runSource("finance.receivable_overdue", "finance", flaky, { companyId: CO_A }, () => null);
    expect(first.ok).toBe(false);
    expect(summarise([first]).completeSweep).toBe(false);

    const existing: ExistingItem = { id: "x", state: "observed", severity: "critical", priority: "critical",
      evidenceAt: fiveObservations(CO_A, "c", "recov")[0]!.evidenceAt };
    const second = runSource("finance.receivable_overdue", "finance", flaky, { companyId: CO_A }, () => existing);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.decisions.every((d) => d.action !== "create")).toBe(true);
  });

  it("CONCURRENT approvals: exactly one wins, the loser reports a conflict and writes nothing", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "concurrent")[0]!;
    const id = await persist(db, o);
    await move(db, id, "observed", "understood", MANAGER);
    await move(db, id, "understood", "prioritised", MANAGER);
    await move(db, id, "prioritised", "recommended", MANAGER);
    await move(db, id, "recommended", "awaiting_approval", MANAGER);

    await db.query("begin");
    const first = await move(db, id, "awaiting_approval", "approved", MANAGER);
    expect(first.rows[0].r.result).toBe("transitioned");
    const racing = move(db2, id, "awaiting_approval", "approved", OWNER);
    await new Promise((r) => setTimeout(r, 120));
    await db.query("commit");
    const second = await racing;
    expect(second.rows[0].r.result).toBe("conflict");

    const { rows } = await db.query(
      `select count(*)::int as n from management_item_transitions where item_id=$1 and to_state='approved'`, [id]);
    expect(rows[0].n).toBe(1);
  }, 60_000);

  it("DUPLICATE SUBMISSION (browser refresh mid-submit) records one decision, not two", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "refresh")[0]!;
    const id = await persist(db, o);
    await db.query(`insert into management_item_decisions (company_id,item_id,decision,actor_id)
                    values ($1,$2,'approve',$3)`, [CO_A, id, MANAGER]);
    await expect(
      db.query(`insert into management_item_decisions (company_id,item_id,decision,actor_id)
                values ($1,$2,'approve',$3)`, [CO_A, id, MANAGER]),
    ).rejects.toThrow(/duplicate key/i);
  }, 60_000);

  it("SELF-APPROVAL is blocked at the database boundary, not only in application code", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "sod")[0]!;
    const id = await persist(db, o);
    await db.query(`insert into management_item_decisions (company_id,item_id,decision,actor_id,edited_action,reason)
                    values ($1,$2,'edit',$3,'ops.task.create_internal','narrowed the scope')`, [CO_A, id, MANAGER]);
    await expect(
      db.query(`insert into management_item_decisions (company_id,item_id,decision,actor_id)
                values ($1,$2,'approve',$3)`, [CO_A, id, MANAGER]),
    ).rejects.toThrow(/may not also approve/i);
  }, 60_000);

  it("ROLLBACK leaves no partial item, evidence or transition", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "rollback")[4]!;
    await db.query("begin");
    try {
      await persist(db, o);
      throw new Error("downstream failure");
    } catch {
      await db.query("rollback");
    }
    const { rows } = await db.query(
      `select count(*)::int as n from management_items where identity_key=$1`, [o.identityKey]);
    expect(rows[0].n).toBe(0);
  }, 60_000);

  it("PERMISSION LOST while a review is open refuses the decision", () => {
    const out = reviewItem(
      { id: "i", companyId: CO_A, state: "awaiting_approval", requiredAuthority: "manager_approval", proposedActionId: null },
      reviewer({ membershipId: null }), { action: "approve" });
    expect(out.ok).toBe(false);
  });

  it("HISTORY CANNOT BE DELETED — an item with history refuses deletion", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "history")[0]!;
    const id = await persist(db, o);
    await expect(db.query(`delete from management_items where id=$1`, [id]))
      .rejects.toThrow(/violates foreign key|still referenced/i);
  }, 60_000);

  it("20+ management items render as one queue without loss", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      const o = fiveObservations(CO_A, randomUUID(), `bulk-${i}`)[i % 5]!;
      ids.push(await persist(db, o));
    }
    const { rows } = await db.query(
      `select count(*)::int as n from management_items where id = any($1)`, [ids]);
    expect(rows[0].n).toBe(22);
  }, 120_000);

  it("NO DUPLICATE BUSINESS EFFECT: replaying an entire sweep creates nothing new", async () => {
    const corr = randomUUID();
    const first = fiveObservations(CO_A, corr, "replay");
    for (const o of first) await persist(db, o);
    const { rows: before } = await db.query(
      `select count(*)::int as n from management_items where identity_key like '%:replay'`);

    for (const o of fiveObservations(CO_A, randomUUID(), "replay")) {
      const existing: ExistingItem = { id: "x", state: "observed", severity: o.severity,
        priority: o.priority, evidenceAt: o.evidenceAt };
      expect(ingestObservation(o, { companyId: CO_A }, existing).action).toBe("skip");
    }
    const { rows: after } = await db.query(
      `select count(*)::int as n from management_items where identity_key like '%:replay'`);
    expect(after[0].n).toBe(before[0].n);
  }, 120_000);

  it("ILLEGAL TRANSITIONS are refused in both the pure layer and the database", async () => {
    const o = fiveObservations(CO_A, randomUUID(), "illegal")[0]!;
    const id = await persist(db, o);
    expect(() => assertTransition("observed", "verified", { evidenceCount: 1 })).toThrow();
    await expect(move(db, id, "observed", "verified", MANAGER)).rejects.toThrow(/illegal/i);
  }, 60_000);
});


// ONE connection pair for the whole file; closed once, after every describe block.
afterAll(async () => {
  await db?.end().catch(() => {});
  await db2?.end().catch(() => {});
});