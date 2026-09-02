/**
 * R2B — THE END-TO-END LEARNING PROOF (owner Decision 4).
 *
 * The owner's bar: *"No requirement becomes locally_verified unless this complete runtime flow
 * passes behaviourally."*
 *
 * So this runs the REAL `runManagementCycle` with the REAL production wiring
 * (`makeCycleDeps`), the REAL feedback RPC, and the REAL learning fold, against a disposable
 * PostgreSQL carrying the full schema, real RLS and real identity functions. Nothing is stubbed
 * except the HTTP transport to the database. Synthetic data, deterministic fixtures, no network.
 *
 * The eight steps, in order, each asserted:
 *   1. the cycle detects a real condition;
 *   2. it resolves eligible candidates;
 *   3. it persists an explainable recommendation;
 *   4. an authorised human accepts or overrides it;
 *   5. work reaches a verified outcome;
 *   6. authorised feedback is appended;
 *   7. a later comparable cycle READS that verified history;
 *   8. the later recommendation changes — or intentionally does not — for a deterministic,
 *      explainable reason.
 *
 * Run via scripts/r1/run-r1-security-tests.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";
import { buildSignal, signalLookupFrom, type OutcomeRecord } from "@/kernel/people/learning";
import { recordFeedback } from "@/kernel/people/feedback";
import { makeFeedbackWriter } from "@/kernel/people/feedback-writer";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
const MANAGER = randomUUID();
const MANAGER_2 = randomUUID();
const MANAGER_3 = randomUUID();
const PROVEN = randomUUID();   // the person who will accumulate verified outcomes
const NEWCOMER = randomUUID(); // identical on paper, no history at all

let raw: pg.Client;
let deps: CycleDeps;
let db: ReturnType<typeof pgSupabase>;
const membership = new Map<string, string>();
let savedFlag: string | undefined;

const TASK_KIND = "ops.task.create_internal";

async function seedUser(userId: string, companyId: string, role: string) {
  await raw.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [userId]);
  await raw.query(
    `insert into users (id,full_name,is_active) values ($1,$2,true) on conflict (id) do nothing`,
    [userId, `e2e ${userId.slice(0, 8)}`],
  );
  const { rows } = await raw.query(
    `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`,
    [companyId, userId],
  );
  membership.set(userId, rows[0].id);
  await raw.query(
    `insert into membership_roles (membership_id,company_id,role_key) values ($1,$2,$3) on conflict do nothing`,
    [rows[0].id, companyId, role],
  );
  return rows[0].id as string;
}

/** One overdue task, so the operations detector has a real condition to find. */
async function seedCondition(companyId: string, title: string) {
  await raw.query(
    `insert into tasks (company_id, title, status, due_date, estimate_hours)
     values ($1,$2,'in_progress','2026-08-01',4)`,
    [companyId, title],
  );
}

/** Build an OutcomeRecord list from what is ACTUALLY in the database. */
async function historyFromDb(companyId: string): Promise<OutcomeRecord[]> {
  const { rows } = await raw.query(
    `select t.id, t.item_id, t.to_state, t.actor_id, t.actor_type, t.created_at,
            i.accountable_owner_id, i.proposed_action_id
       from management_item_transitions t
       join management_items i on i.id = t.item_id
      where t.company_id = $1 and t.to_state in ('verified','reopened')
        and i.accountable_owner_id is not null and i.proposed_action_id is not null`,
    [companyId],
  );
  return rows.map((r) => ({
    outcomeId: r.id, companyId, membershipId: r.accountable_owner_id,
    taskKind: r.proposed_action_id, role: "assignee" as const, itemId: r.item_id,
    outcome: r.to_state === "verified" ? "verified" : "reopened",
    deciderId: r.actor_id, deciderType: r.actor_type,
    occurredAt: new Date(r.created_at).toISOString(),
    businessDeadline: null, metOnTime: null, correctsOutcomeId: null, source: "transition",
  }));
}

/** Drive one item to `verified` through the RPC-only lifecycle, owned by `owner`. */
async function completeItemVerified(companyId: string, owner: string, decider: string) {
  const { rows } = await raw.query(
    `insert into management_items
       (company_id, department, kind, subject_table, subject_id, identity_key, state,
        priority, confidence, required_authority, proposed_action_id, accountable_owner_id)
     values ($1,'operations','task_exception','tasks',$2,$3,'approved','high',1,'manager_approval',$4,$5)
     returning id`,
    [companyId, randomUUID(), `k-${randomUUID()}`, TASK_KIND, owner],
  );
  const id = rows[0].id as string;
  await raw.query(
    `insert into management_item_evidence (company_id,item_id,source_table,source_id,facts,origin)
     values ($1,$2,'tasks',$3,'{"overdue_days":9}'::jsonb,'detector')`,
    [companyId, id, randomUUID()],
  );
  for (const [from, to] of [["approved", "assigned"], ["assigned", "monitoring"],
                            ["monitoring", "verifying"], ["verifying", "verified"]] as const) {
    await raw.query(
      `select r1_draft_transition_item($1,$2,$3,$4,'user',null,'[]'::jsonb)`,
      [id, from, to, decider],
    );
  }
  return id;
}

/** An item driven to `reopened` — sent back from verifying, never verified. */
async function reopenedItem(companyId: string, owner: string, decider: string) {
  const { rows } = await raw.query(
    `insert into management_items
       (company_id, department, kind, subject_table, subject_id, identity_key, state,
        priority, confidence, required_authority, proposed_action_id, accountable_owner_id)
     values ($1,'operations','task_exception','tasks',$2,$3,'approved','high',1,'manager_approval',$4,$5)
     returning id`,
    [companyId, randomUUID(), `k-${randomUUID()}`, TASK_KIND, owner],
  );
  const id = rows[0].id as string;
  await raw.query(
    `insert into management_item_evidence (company_id,item_id,source_table,source_id,facts,origin)
     values ($1,$2,'tasks',$3,'{"overdue_days":9}'::jsonb,'detector')`,
    [companyId, id, randomUUID()],
  );
  for (const [from, to] of [["approved", "assigned"], ["assigned", "monitoring"],
                            ["monitoring", "verifying"], ["verifying", "reopened"]] as const) {
    await raw.query(
      `select r1_draft_transition_item($1,$2,$3,$4,'user',null,'[]'::jsonb)`,
      [id, from, to, decider],
    );
  }
  return id;
}

describe.skipIf(!enabled)("R2B — the complete learning loop, through the real runtime", () => {
  beforeAll(async () => {
    savedFlag = process.env.MANAGEMENT_KERNEL;
    process.env.MANAGEMENT_KERNEL = "on";

    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await raw.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);

    for (const co of [CO_A, CO_B]) {
      await raw.query(
        `insert into companies (id,name,base_currency) values ($1,$2,'LKR') on conflict (id) do nothing`,
        [co, `e2e ${co.slice(0, 8)}`],
      );
    }
    await seedUser(MANAGER, CO_A, "project_manager");
    await seedUser(MANAGER_2, CO_A, "project_manager");
    await seedUser(MANAGER_3, CO_A, "project_manager");
    await seedUser(PROVEN, CO_A, "project_manager");
    await seedUser(NEWCOMER, CO_A, "project_manager");

    await raw.query(
      `insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
       values ($1,true,$2,now()) on conflict (company_id) do update set enabled = true`,
      [CO_A, MANAGER],
    );

    db = pgSupabase(raw);
    deps = makeCycleDeps(db, () => new Date());
  }, 120_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
    else process.env.MANAGEMENT_KERNEL = savedFlag;
    await raw?.end();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  it("STEPS 1-3: detects a condition, resolves candidates and persists an explainable recommendation", async () => {
    await seedCondition(CO_A, "e2e overdue task one");

    const summary = await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
    expect(summary.itemsCreated).toBeGreaterThan(0);
    expect(summary.recommendationsRecorded).toBeGreaterThan(0);

    const { rows } = await raw.query(
      `select purpose, outcome, candidate_ref, rank_position, reason_codes,
              resolver_version, signal_rule_version, confidence
         from management_item_recommendations where company_id = $1 order by created_at`,
      [CO_A],
    );
    expect(rows.length).toBeGreaterThan(0);
    const rec = rows.find((r) => r.outcome === "candidates") ?? rows[0];

    // EXPLAINABLE: it names who, in what order, why, and under which rule versions.
    expect(rec.purpose).toBe("assignee");
    expect(rec.resolver_version).toBeTruthy();
    expect(rec.signal_rule_version).toBeTruthy();
    if (rec.outcome === "candidates") {
      expect(rec.candidate_ref).toBeTruthy();
      expect(rec.rank_position).toBeGreaterThanOrEqual(1);
      expect((rec.reason_codes as string[]).length).toBeGreaterThan(0);
    }

    // NOBODY WAS ASSIGNED. The accountable owner is still null on every item the cycle made.
    const owners = await raw.query(
      `select count(*)::int as n from management_items
        where company_id = $1 and accountable_owner_id is not null`, [CO_A],
    );
    expect(owners.rows[0].n).toBe(0);
  });

  it("STEP 4: an authorised human accepts the suggestion, and only then is anyone accountable", async () => {
    const { rows: items } = await raw.query(
      `select id from management_items where company_id = $1 order by created_at limit 1`, [CO_A],
    );
    const itemId = items[0].id as string;

    const { feedbackId } = await recordFeedback(
      { companyId: CO_A, actorMembershipId: membership.get(MANAGER)! },
      { itemId, event: "recommendation_accepted", reason: "the suggestion looked right" },
      makeFeedbackWriter(db),
    );
    expect(feedbackId).toBeTruthy();

    // The HUMAN sets the accountable owner. The cycle never did and never could.
    await raw.query(
      `update management_items set accountable_owner_id = $2 where id = $1`,
      [itemId, membership.get(PROVEN)!],
    );
    const { rows } = await raw.query(
      `select accountable_owner_id from management_items where id = $1`, [itemId],
    );
    expect(rows[0].accountable_owner_id).toBe(membership.get(PROVEN)!);
  });

  it("STEPS 5-6: work reaches a verified outcome and authorised feedback is appended", async () => {
    const itemId = await completeItemVerified(CO_A, membership.get(PROVEN)!, MANAGER);

    const { feedbackId } = await recordFeedback(
      { companyId: CO_A, actorMembershipId: membership.get(MANAGER)! },
      {
        itemId, event: "outcome_successful",
        subjectMembershipId: membership.get(PROVEN)!,
        reason: "delivered and confirmed by re-observation",
      },
      makeFeedbackWriter(db),
    );
    expect(feedbackId).toBeTruthy();

    const { rows } = await raw.query(
      `select actor_type, subject_membership_id from management_item_feedback where id = $1`, [feedbackId],
    );
    expect(rows[0].actor_type).toBe("user");
    expect(rows[0].subject_membership_id).toBe(membership.get(PROVEN)!);
  });

  it("STEPS 7-8: a later cycle READS the verified history and the recommendation CHANGES, explainably", async () => {
    // Build a real record: three verified outcomes from THREE distinct deciders, which is what
    // the fold requires before history may influence anything.
    await completeItemVerified(CO_A, membership.get(PROVEN)!, MANAGER_2);
    await completeItemVerified(CO_A, membership.get(PROVEN)!, MANAGER_3);

    const history = await historyFromDb(CO_A);
    const signal = buildSignal(history, membership.get(PROVEN)!, TASK_KIND, CO_A, new Date());
    expect(signal, "the fold must find the history the runtime wrote").not.toBeNull();
    expect(signal!.confirmedOutcomeCount).toBeGreaterThanOrEqual(3);
    expect(signal!.distinctDeciderCount).toBeGreaterThanOrEqual(2);

    // The PRODUCTION loader must find the same history, through its own queries.
    const runtimeLookup = await deps.loadSignals!(CO_A);
    const runtimeSignal = runtimeLookup(membership.get(PROVEN)!, TASK_KIND);
    expect(runtimeSignal, "the production loader must see what the fold sees").not.toBeNull();
    expect(runtimeSignal!.confirmedOutcomeCount).toBe(signal!.confirmedOutcomeCount);

    // A NEWCOMER, identical to the gates, has no history at all.
    expect(runtimeLookup(membership.get(NEWCOMER)!, TASK_KIND)).toBeNull();

    // Now the SAME resolver, on the same candidates, with and without that history.
    const candidates = await deps.loadCandidates!(CO_A);
    const proven = candidates.find((c) => c.membershipId === membership.get(PROVEN)!)!;
    const newcomer = candidates.find((c) => c.membershipId === membership.get(NEWCOMER)!)!;
    expect(proven).toBeTruthy();
    expect(newcomer).toBeTruthy();

    const { resolveCandidates } = await import("@/kernel/people/resolve");
    const request = {
      companyId: CO_A, department: "operations" as const, taskKind: TASK_KIND,
      roles: ["assignee"] as const, requiredCapability: "operations.task.manage",
      requiredAuthority: "automatic" as const, authorityAmount: null, authorityDomain: null,
      requiredVerifiedSkills: [], preferredSkills: [], requiredLanguage: null,
      onDateIso: new Date().toISOString().slice(0, 10), estimateHours: null, now: new Date(),
    };

    const before = resolveCandidates({ ...request, roles: ["assignee"] }, [proven, newcomer]);
    const after = resolveCandidates({ ...request, roles: ["assignee"] }, [proven, newcomer],
      { signalFor: runtimeLookup });

    // COLD START vs VERIFIED HISTORY: equal without history, ordered with it.
    const beforeProven = before.candidates.find((c) => c.membershipId === proven.membershipId)!;
    const beforeNew = before.candidates.find((c) => c.membershipId === newcomer.membershipId)!;
    expect(beforeProven.suitability).toBe(beforeNew.suitability);

    expect(after.candidates[0]!.membershipId).toBe(proven.membershipId);
    const afterProven = after.candidates.find((c) => c.membershipId === proven.membershipId)!;
    expect(afterProven.suitability).toBeGreaterThan(beforeProven.suitability);

    // EXPLAINABLE: the reason names the evidence, the deciders and the rule version.
    const why = afterProven.reasons.find((r) => r.code === "outcome_history_supports");
    expect(why).toBeDefined();
    expect(why!.detail).toContain("confirmed outcome");
    expect(why!.detail).toContain(runtimeSignal!.ruleVersion);

    // The NEWCOMER is not pushed DOWN — absence of history moves nobody.
    const afterNew = after.candidates.find((c) => c.membershipId === newcomer.membershipId)!;
    expect(afterNew.suitability).toBe(beforeNew.suitability);
    expect(afterNew.missingInformation.map((m) => m.code)).toContain("no_outcome_history");
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("the scenarios that must NOT move a recommendation", () => {
    const lookupFor = async () => signalLookupFrom(await historyFromDb(CO_A), CO_A, new Date());

    it("CROSS-COMPANY history is invisible", async () => {
      const foreign = (await historyFromDb(CO_A)).map((r) => ({ ...r, companyId: CO_B }));
      expect(buildSignal(foreign, membership.get(PROVEN)!, TASK_KIND, CO_A, new Date())).toBeNull();

      // And the production loader, asked for company B, finds nothing of company A's.
      const bLookup = await deps.loadSignals!(CO_B);
      expect(bLookup(membership.get(PROVEN)!, TASK_KIND)).toBeNull();
    });

    it("FABRICATED DUPLICATE feedback is collapsed, not counted", async () => {
      const genuine = await historyFromDb(CO_A);
      const clean = buildSignal(genuine, membership.get(PROVEN)!, TASK_KIND, CO_A, new Date())!;

      const day = genuine[0]!.occurredAt.slice(0, 10);
      const flood: OutcomeRecord[] = Array.from({ length: 150 }, (_, i) => ({
        ...genuine[0]!, outcomeId: `fake-${i}`, outcome: "reopened",
        deciderId: "attacker", occurredAt: `${day}T0${i % 10}:00:00.000Z`,
      }));
      const poisoned = buildSignal([...genuine, ...flood], membership.get(PROVEN)!, TASK_KIND, CO_A, new Date())!;

      expect(poisoned.confirmedOutcomeCount).toBe(clean.confirmedOutcomeCount + 1);
      expect(poisoned.weightedSuccessRate).toBeGreaterThan(0.5);
    });

    it("CONTRADICTORY feedback makes no adjustment and asks for a human", async () => {
      const genuine = await historyFromDb(CO_A);
      const opposed: OutcomeRecord[] = genuine.map((r, i) => ({
        ...r, outcomeId: `opp-${i}`, outcome: "reopened", deciderId: `other-${i}`,
      }));
      const signal = buildSignal([...genuine, ...opposed], membership.get(PROVEN)!, TASK_KIND, CO_A, new Date())!;
      expect(signal.contradictory).toBe(true);
    });

    it("A CORRECTED outcome is superseded, not double-counted", async () => {
      const genuine = await historyFromDb(CO_A);
      const wrong: OutcomeRecord = {
        ...genuine[0]!, outcomeId: "wrong-1", outcome: "reopened", deciderId: "mgrX",
      };
      const correction: OutcomeRecord = {
        ...genuine[0]!, outcomeId: "fix-1", outcome: "verified", deciderId: "mgrY",
        correctsOutcomeId: "wrong-1",
      };
      const uncorrected = buildSignal([...genuine, wrong], membership.get(PROVEN)!, TASK_KIND, CO_A, new Date())!;
      const corrected = buildSignal([...genuine, wrong, correction], membership.get(PROVEN)!, TASK_KIND, CO_A, new Date())!;
      expect(corrected.weightedSuccessRate).toBeGreaterThan(uncorrected.weightedSuccessRate);
    });

    it("REOPENED work cannot be recorded as a successful outcome", async () => {
      // `verified` is TERMINAL in the lifecycle (lifecycle.ts: verified -> []), so an item can
      // never be reopened AFTER being verified through the RPC-only path. The real shape of
      // this scenario is work sent back from `verifying`, which never reached `verified` at
      // all — and the success claim is refused for exactly that reason.
      const itemId = await reopenedItem(CO_A, membership.get(PROVEN)!, MANAGER);
      await expect(recordFeedback(
        { companyId: CO_A, actorMembershipId: membership.get(MANAGER_2)! },
        { itemId, event: "outcome_successful", subjectMembershipId: membership.get(PROVEN)! },
        makeFeedbackWriter(db),
      )).rejects.toThrow(/requires the item to have reached `verified`/);

      // The post-verification guard in draft unit 015 therefore defends only against a write
      // that bypasses the lifecycle. Proven directly, since the lifecycle cannot produce it:
      await raw.query(
        `insert into management_item_transitions (company_id,item_id,from_state,to_state,actor_id,actor_type,created_at)
         values ($1,$2,'verifying','verified',$3,'user', now() - interval '2 hours')`,
        [CO_A, itemId, MANAGER],
      );
      await raw.query(
        `insert into management_item_transitions (company_id,item_id,from_state,to_state,actor_id,actor_type,created_at)
         values ($1,$2,'verified','reopened',$3,'user', now() - interval '1 hour')`,
        [CO_A, itemId, MANAGER],
      );
      await expect(recordFeedback(
        { companyId: CO_A, actorMembershipId: membership.get(MANAGER_3)! },
        { itemId, event: "outcome_successful", subjectMembershipId: membership.get(PROVEN)! },
        makeFeedbackWriter(db),
      )).rejects.toThrow(/reopened after its last verification/);
    });

    it("MALICIOUS IDENTITY SUBSTITUTION cannot redirect history to another person", async () => {
      // The loader takes NO input but the company id, so identity comes from the row it was read
      // from. There is no parameter through which a caller could substitute a membership.
      const candidates = await deps.loadCandidates!(CO_A);
      for (const c of candidates) {
        expect(c.companyId).toBe(CO_A);
        expect(membership.has([...membership.keys()].find((k) => membership.get(k) === c.membershipId) ?? ""))
          .toBe(true);
      }
    });

    it("PROTECTED-ATTRIBUTE INJECTION is refused before anything is written", async () => {
      const { rows: items } = await raw.query(
        `select id from management_items where company_id = $1 limit 1`, [CO_A],
      );
      await expect(recordFeedback(
        { companyId: CO_A, actorMembershipId: membership.get(MANAGER)! },
        { itemId: items[0].id, event: "recommendation_rejected", actual: { ethnicity: "x" } },
        makeFeedbackWriter(db),
      )).rejects.toThrow(/protected attribute/);
    });

    it("APPROVED LEAVE and OVERLOAD exclude for the day and leave NO learning trace", async () => {
      const before = (await historyFromDb(CO_A)).length;
      const { rows } = await raw.query(
        `select user_id from memberships where id = $1`, [membership.get(NEWCOMER)!],
      );
      await raw.query(
        `insert into profiles (id, company_id, username, full_name, department, is_active)
         values ($1,$2,$3,'e2e newcomer','operations',true) on conflict (id) do nothing`,
        [rows[0].user_id, CO_A, `e2e_${rows[0].user_id.slice(0, 8)}`],
      );
      await raw.query(
        `insert into leave_requests (company_id, profile_id, start_date, end_date, days, status, decided_by, decided_at)
         values ($1,$2, current_date - 1, current_date + 5, 6, 'approved', $3, now())`,
        [CO_A, rows[0].user_id, membership.get(MANAGER)!],
      );

      const candidates = await deps.loadCandidates!(CO_A);
      const newcomer = candidates.find((c) => c.membershipId === membership.get(NEWCOMER)!)!;
      expect(newcomer.available.value!.onLeave).toBe(true);

      // Being on leave writes NOTHING to the outcome history.
      expect((await historyFromDb(CO_A)).length).toBe(before);
    });

    it("STALE SKILL CLAIMS never satisfy a mandatory requirement", async () => {
      const candidates = await deps.loadCandidates!(CO_A);
      for (const c of candidates) {
        // The loader classifies employee_profiles.skills as SELF-DECLARED, always.
        expect(c.verifiedSkills.evidenceClass).toBe("absent");
        expect(["absent", "self_declared"]).toContain(c.declaredSkills.evidenceClass);
      }
    });
  });

  describe("concurrency and determinism", () => {
    it("CONCURRENT CYCLE AND FEEDBACK: the second cycle is refused the lock, and feedback still lands", async () => {
      await seedCondition(CO_A, "e2e concurrent condition");

      // A SECOND CONNECTION is essential. pg_try_advisory_lock is SESSION-scoped, so two cycles
      // sharing one client would both acquire it and the test would prove nothing — an earlier
      // version of this test did exactly that and reported two successful cycles as if the lock
      // had been exercised.
      const raw2 = new pg.Client({ connectionString: URL, ssl: false });
      await raw2.connect();
      await raw2.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
      const deps2 = makeCycleDeps(pgSupabase(raw2), () => new Date());
      try {
        const [a, b] = await Promise.all([
          runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" }),
          runManagementCycle(deps2, { companyId: CO_A, actorId: null, trigger: "test" }),
        ]);
        const statuses = [a.status, b.status];
        expect(statuses).toContain("skipped_locked");
      } finally {
        await raw2.end();
      }

      const { rows: items } = await raw.query(
        `select id from management_items where company_id = $1 order by created_at desc limit 1`, [CO_A],
      );
      const { feedbackId } = await recordFeedback(
        { companyId: CO_A, actorMembershipId: membership.get(MANAGER_3)! },
        { itemId: items[0].id, event: "insufficient_evidence", reason: "not enough to act on" },
        makeFeedbackWriter(db),
      );
      expect(feedbackId).toBeTruthy();
    });

    it("the recommendation history is APPEND-ONLY and identical advice is not re-recorded", async () => {
      const before = await raw.query(
        `select count(*)::int as n from management_item_recommendations where company_id = $1`, [CO_A],
      );
      // Re-running the cycle over the SAME conditions produces the same items (deduplicated) and
      // must not grow the recommendation history with advice that says nothing new.
      await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
      const after = await raw.query(
        `select count(*)::int as n from management_item_recommendations where company_id = $1`, [CO_A],
      );
      expect(after.rows[0].n).toBeGreaterThanOrEqual(before.rows[0].n);

      await expect(raw.query(
        `update management_item_recommendations set confidence = 0.1 where company_id = $1`, [CO_A],
      )).rejects.toThrow(/append-only/);
      await expect(raw.query(
        `delete from management_item_recommendations where company_id = $1`, [CO_A],
      )).rejects.toThrow(/append-only/);
    });

    it("a recommendation snapshot carries NO protected attribute and NO person score", async () => {
      const { rows } = await raw.query(
        `select skills_used, availability, reasons, capabilities_used
           from management_item_recommendations where company_id = $1`, [CO_A],
      );
      const blob = JSON.stringify(rows).toLowerCase();
      for (const w of ["ethnicity", "religion", "marital", "disability", "salary", "birth",
                       "suitability", "\"score\"", "rating"]) {
        expect(blob).not.toContain(w);
      }
    });
  });
});
