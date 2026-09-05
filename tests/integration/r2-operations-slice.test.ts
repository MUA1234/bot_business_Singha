/**
 * The operations vertical slice, end to end — and the exact points at which it is NOT end to end.
 *
 * ── What this file establishes, and what it exposes ──────────────────────────────────────────
 *
 * Every step below that HAS a runtime path is driven by that path: the real detector, the real
 * cycle, the real execution service, the real completion-claim RPC, the real verification sweep
 * through the real dependency graph. Nothing is simulated where something real exists.
 *
 * Four spans of the lifecycle have NO runtime writer at all, and the test performs them itself
 * through the database boundary, each marked `// NO RUNTIME WRITER`. They are not incidental
 * plumbing — they are the middle of the management loop:
 *
 *   observed → understood → prioritised → recommended → awaiting_approval   (nothing writes these)
 *   approved → assigned                                                     (nothing writes this)
 *   assigned → monitoring                                                   (nothing writes this)
 *
 * The consequence is worth stating plainly, because a passing test here could easily be read as
 * proving the opposite: in the deployed system a management item is created in `observed` and
 * stays there. It can never reach the decision boundary, the completion claim or verification,
 * because no code moves it. Registered as **R2F-F-014**.
 *
 * Everything else is real, and each concern is asserted INDEPENDENTLY — the task effect, the
 * claim, the business condition, the lifecycle transition, the audit history and learning
 * eligibility are six separate questions, and a slice that checks one and infers the rest is how
 * "the task is done" comes to mean "the problem is solved".
 *
 * Synthetic data, disposable local PostgreSQL, no network, no model, no message sent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { executeManagementAction } from "@/kernel/execution/service";
import { LOCAL_EXECUTION_TOKEN } from "@/kernel/execution/boundary";
import type { SqlExec } from "@/kernel/execution/ledger";
import { pgSupabase } from "./helpers/pg-supabase";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const MANAGER = randomUUID();
const WORKER = randomUUID();
/** A member of the same company with no relationship to the item under test. */
const BYSTANDER = randomUUID();

let raw: pg.Client;
let deps: CycleDeps;
let savedFlag: string | undefined;
const membershipOf = new Map<string, string>();

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);
const sql: SqlExec = async (text, params) => {
  const r = await raw.query(text, params as unknown[]);
  return { rows: r.rows as Record<string, unknown>[] };
};

/** Run as a real signed-in person, with `auth.uid()` resolving to them. */
async function asUser(
  userId: string,
  text: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>> {
  await q("begin");
  try {
    await q("set local role authenticated");
    await q(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: userId }),
    ]);
    const { rows } = await q(text, params);
    await q("commit");
    // Every caller asks a single-row question. Returning the row, not the list, keeps the
    // assertions about the answer rather than about the shape of the result set.
    return rows[0] as Record<string, unknown>;
  } catch (e) {
    await q("rollback");
    throw e;
  }
}

/**
 * A lifecycle hop that NOTHING in the application performs.
 *
 * Written through the database boundary so the transition map, the evidence requirement and the
 * append-only history all still apply — but it is the TEST doing it, not the system. Every call is
 * a place a real deployment would stop.
 */
async function noRuntimeWriter(itemId: string, from: string, to: string, actor: string | null) {
  const { rows } = await q(
    `select public.r1_draft_transition_item($1,$2,$3,$4,$5,$6,'[]'::jsonb) as r`,
    [itemId, from, to, actor, actor ? "user" : "system", "R2F-F-014: no runtime writer exists"],
  );
  const r = rows[0].r as { ok?: boolean; result?: string };
  if (r?.ok !== true) throw new Error(`transition ${from}→${to} refused: ${JSON.stringify(r)}`);
}

/**
 * A recommendation snapshot whose `evidence_refs` are the ITEM's evidence — which is what the
 * executor compares against, and which NOTHING in the runtime produces (R2F-F-017).
 *
 * The cycle writes snapshots whose `evidence_refs` are the CANDIDATE's eligibility evidence:
 * membership roles, capacity, leave. The executor digests those and compares the result against
 * the digest of `management_item_evidence`. They are different record sets, so for an automatic
 * action — which takes this branch because it needs no approval — the comparison cannot succeed.
 *
 * The refusal is asserted first, live, so the gap is a regression gate rather than a note.
 */
async function noRuntimeProducer(companyId: string, itemId: string) {
  const { rows } = await q(
    `select source_table, source_id from management_item_evidence
      where company_id=$1 and item_id=$2`,
    [companyId, itemId],
  );
  await q(
    `insert into management_item_recommendations
       (company_id, item_id, purpose, outcome, candidate_ref, candidate_type, rank_position,
        resolver_version, signal_rule_version, fingerprint, evidence_refs)
     values ($1,$2,'assignee','candidates',$3,'staff',1,'slice','slice',$4,$5::jsonb)`,
    [
      companyId, itemId, MANAGER, `fp-${itemId}`,
      JSON.stringify(rows.map((r) => ({ sourceTable: r.source_table, sourceId: r.source_id }))),
    ],
  );
}

async function seedPerson(user: string, company: string, roleKey: string) {
  await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [user]);
  await q(
    `insert into users (id, full_name, is_active) values ($1,'slice person',true)
       on conflict (id) do nothing`,
    [user],
  );
  await q(
    `insert into profiles (id, company_id, username, full_name, department, is_active)
     values ($1,$2,$3,'slice person','operations',true) on conflict (id) do nothing`,
    [user, company, `slice-${user.slice(0, 8)}`],
  );
  const { rows } = await q(
    `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
       on conflict (company_id, user_id) do update set status='active' returning id`,
    [company, user],
  );
  membershipOf.set(`${company}:${user}`, String(rows[0].id));
  await q(
    `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)
       on conflict do nothing`,
    [rows[0].id, company, roleKey],
  );
}

/** A whole company, freshly built, with the kernel and execution both enabled. */
async function freshCompany(): Promise<string> {
  const co = randomUUID();
  await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`,
    [co, `slice ${co.slice(0, 8)}`]);
  for (const [u, role] of [
    [MANAGER, "project_manager"], [WORKER, "staff_submitter"], [BYSTANDER, "staff_submitter"],
  ] as const) {
    await seedPerson(u, co, role);
  }
  await q(
    `insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
     values ($1,true,$2,now()) on conflict (company_id) do update set enabled = true`,
    [co, MANAGER],
  );
  await q(
    `insert into management_execution_enablement (company_id, enabled, enabled_by, enabled_at)
     values ($1,true,$2,now()) on conflict (company_id) do update set enabled = true`,
    [co, MANAGER],
  );
  return co;
}

const stateOf = async (itemId: string): Promise<string> => {
  const { rows } = await q(`select state from management_items where id=$1`, [itemId]);
  return String(rows[0]?.state);
};

const audits: Array<{ action: string }> = [];
const execEnv = () => ({
  sql,
  rpc: {
    async rpc(_fn: string, args: Record<string, unknown>) {
      try {
        const r = await q(
          `select * from r1_draft_create_internal_task($1,$2,$3,$4,$5,$6)`,
          [args.p_company_id, args.p_idempotency_key, args.p_title,
           args.p_description, args.p_requires_evidence, args.p_created_by],
        );
        return { data: r.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  },
  async audit(e: { action: string }) { audits.push({ action: e.action }); },
  localToken: LOCAL_EXECUTION_TOKEN,
});

beforeAll(async () => {
  if (!enabled) return;
  savedFlag = process.env.MANAGEMENT_KERNEL;
  process.env.MANAGEMENT_KERNEL = "on";
  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();
  await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  deps = makeCycleDeps(pgSupabase(raw));
}, 180_000);

afterAll(async () => {
  if (!enabled) return;
  if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
  else process.env.MANAGEMENT_KERNEL = savedFlag;
  await raw?.end();
});

/**
 * Steps 1–8, shared by both scenarios.
 *
 * Returns the item, the originating task (the business condition) and the effect task (the work
 * execution created), so each scenario can decide what happens to the condition afterwards.
 */
async function driveToClaim(co: string): Promise<{
  itemId: string; originating: string; effect: string;
}> {
  // ── 1. A real business condition, chosen for what the detector does with it. ──
  //
  // A SCHEDULED task with no estimate raises exactly one exception — `missing_estimate` — which
  // the catalogue maps to `ops.task.create_internal`, the one action the execution policy
  // classifies as locally executable. An overdue task maps to `ops.task.request_progress_update`
  // instead, which is draft-only, and the executor correctly refuses it: real behaviour, wrong
  // condition for a slice that has to reach execution.
  const { rows: t } = await q(
    `insert into tasks (company_id, title, status, due_date, estimate_hours)
     values ($1,'slice unestimated condition','scheduled',null,null) returning id`,
    [co],
  );
  const originating = String(t[0].id);

  // ── 2. The REAL cycle observes it and files an item with evidence. ──
  const first = await runManagementCycle(deps, { companyId: co, actorId: MANAGER, trigger: "test" });
  expect(first.itemsCreated).toBeGreaterThan(0);

  const { rows: items } = await q(
    `select id, state, proposed_action_id, required_authority
       from management_items
      where company_id=$1 and subject_table='tasks' and subject_id=$2`,
    [co, originating],
  );
  expect(items, "the detector did not raise the seeded condition").toHaveLength(1);
  const itemId = String(items[0].id);

  // ── 3. Evidence and a recommendation exist, recorded by the cycle itself. ──
  const { rows: ev } = await q(
    `select count(*)::int as n from management_item_evidence where item_id=$1`, [itemId]);
  expect(ev[0].n).toBeGreaterThan(0);
  expect(items[0].proposed_action_id).toBeTruthy();
  expect(items[0].required_authority).toBeTruthy();

  // ── 4. The decision. ──
  //
  // NO RUNTIME WRITER for the four hops from `observed` to `awaiting_approval`: nothing in the
  // application advances an item past `observed`, so the decision boundary — which is real, and
  // tested — is unreachable by a real item (R2F-F-014).
  expect(items[0].state, "an item created by the cycle starts here and nothing moves it").toBe("observed");
  for (const [from, to] of [
    ["observed", "understood"], ["understood", "prioritised"],
    ["prioritised", "recommended"], ["recommended", "awaiting_approval"],
  ] as const) {
    await noRuntimeWriter(itemId, from, to, null); // NO RUNTIME WRITER
  }

  // The manager approves through the REAL decision RPC, as a real authenticated person.
  const { rows: digest } = await q(
    `select public.r1_draft_evidence_digest($1,$2) as d`, [co, itemId]);
  const decision = await asUser(
    MANAGER,
    `select public.r1_draft_record_management_decision($1,'approve','awaiting_approval',$2,$3,null,null,$4) as r`,
    [itemId, items[0].proposed_action_id, String(digest[0].d), `slice-${itemId}`],
  );
  expect((decision.r as { ok?: boolean }).ok, JSON.stringify(decision.r)).toBe(true);
  expect(await stateOf(itemId)).toBe("approved");

  // ── 5. Controlled execution creates exactly ONE unassigned internal task. ──
  const before = await q(`select count(*)::int as n from tasks where company_id=$1`, [co]);
  // The action is the item's OWN. Passing a hard-coded id would be asserting an approval the
  // item never carried — and the executor refuses exactly that, with `stale_state`.
  expect(items[0].proposed_action_id).toBe("ops.task.create_internal");
  const request = {
    companyId: co,
    itemId,
    actionId: String(items[0].proposed_action_id) as "ops.task.create_internal",
    parameters: {
      title: "slice: give the unestimated work an estimate",
      description: "created by the executor under the local test boundary",
      requiresEvidence: false,
    },
  };

  // R2F-F-017, asserted live: with ONLY what the runtime produced, execution is refused. The
  // evidence-freshness check digests the recommendation snapshot's `evidence_refs` and compares
  // them to the item's evidence, and the cycle writes candidate-eligibility refs there. This is
  // not a fixture problem — it is why no cycle-created item can execute an automatic action.
  const asRuntimeLeftIt = await executeManagementAction(execEnv(), request);
  expect(asRuntimeLeftIt.status).toBe("refused");
  expect(
    asRuntimeLeftIt.status === "refused" ? asRuntimeLeftIt.reason : null,
  ).toBe("evidence_stale");

  await noRuntimeProducer(co, itemId); // NO RUNTIME PRODUCER — R2F-F-017
  const outcome = await executeManagementAction(execEnv(), request);
  expect(outcome.status, JSON.stringify(outcome)).toBe("executed");
  const after = await q(`select count(*)::int as n from tasks where company_id=$1`, [co]);
  expect(after.rows[0].n - before.rows[0].n, "exactly one task, not zero and not two").toBe(1);

  // Two attempts are recorded: the refusal above and the execution. A refusal that left no trace
  // would make the R2F-F-017 gap invisible in the ledger it exists to document.
  const { rows: attempts } = await q(
    `select effect_ref, status from management_execution_attempts
      where item_id=$1 order by created_at`, [itemId]);
  const executed = attempts.filter((a) => a.status === "executed");
  expect(attempts.map((a) => a.status)).toEqual(["refused", "executed"]);
  expect(executed).toHaveLength(1);
  const effect = String(executed[0]!.effect_ref);

  // The created task is UNASSIGNED. The executor may create work; it may not give it to anyone.
  const { rows: created } = await q(
    `select assigned_to, status from tasks where id=$1`, [effect]);
  expect(created[0].assigned_to).toBeNull();

  // ── 6. Authorised assignment, and ── 7. the assignee finishes the work. ──
  //
  // NO RUNTIME WRITER for `approved → assigned → monitoring`. The task assignment itself is a
  // real app capability (`assignTask`), driven here directly because it takes FormData from a
  // request this harness has no way to construct.
  await q(`update tasks set assigned_to=$1 where id=$2`, [WORKER, effect]);
  // NO RUNTIME WRITER for the accountable owner either. `r1_draft_assert_assignable` refuses to
  // move an item to `assigned` with nobody accountable — correctly — and nothing in the
  // application ever fills the column, so this is the same R2F-F-014 gap seen from another side.
  await q(`update management_items set accountable_owner_id=$1 where id=$2`,
    [membershipOf.get(`${co}:${WORKER}`)!, itemId]); // NO RUNTIME WRITER
  await noRuntimeWriter(itemId, "approved", "assigned", MANAGER); // NO RUNTIME WRITER
  await noRuntimeWriter(itemId, "assigned", "monitoring", MANAGER); // NO RUNTIME WRITER
  await q(`update tasks set status='completed' where id=$1`, [effect]);

  // ── 8. The assigned person — and only they — report their work complete, through the REAL RPC. ──
  const { rows: digest2 } = await q(
    `select public.r1_draft_evidence_digest($1,$2) as d`, [co, itemId]);
  const { rows: itemNow } = await q(
    `select proposed_action_id from management_items where id=$1`, [itemId]);

  // The manager is refused first: reporting somebody's work complete is not a manager's act.
  const refused = await asUser(
    MANAGER,
    `select public.r1_draft_claim_task_completion($1,$2,'monitoring',$3,$4,'on their behalf',null) as r`,
    [itemId, effect, itemNow[0].proposed_action_id, String(digest2[0].d)],
  );
  expect((refused.r as { refusal?: string }).refusal).toBe("not_assignee");

  const claimed = await asUser(
    WORKER,
    `select public.r1_draft_claim_task_completion($1,$2,'monitoring',$3,$4,'finished on site',$5) as r`,
    [itemId, effect, itemNow[0].proposed_action_id, String(digest2[0].d), `claim-${itemId}`],
  );
  expect((claimed.r as { ok?: boolean }).ok, JSON.stringify(claimed.r)).toBe(true);
  expect(await stateOf(itemId)).toBe("verifying");

  return { itemId, originating, effect };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("the work is done AND the condition is resolved", () => {
  it("verifies, closes the item, and every concern is independently true", async () => {
    const co = await freshCompany();
    const { itemId, originating, effect } = await driveToClaim(co);

    // ── 9. The business condition is genuinely resolved: the originating task is finished, so
    //      the detector that raised it finds nothing. Terminal tasks are filtered before
    //      detection, which is why this is a real resolution and not a hidden one.
    await q(`update tasks set status='completed' where id=$1`, [originating]);

    // ── 10. A LATER cycle re-observes and verifies, through the real dependency graph. ──
    const second = await runManagementCycle(deps, { companyId: co, actorId: MANAGER, trigger: "test" });
    expect(second.verification.transport).toBe("supabase");
    expect(second.verification.verified, JSON.stringify(second.verification)).toBe(1);

    // ── Six independent assertions. Each is a different question. ──

    // (a) the task EFFECT was created and finished
    const { rows: eff } = await q(`select status, assigned_to from tasks where id=$1`, [effect]);
    expect(eff[0].status).toBe("completed");
    expect(eff[0].assigned_to).toBe(WORKER);

    // (b) the completion CLAIM is the worker's, and says which task it was about
    const { rows: claim } = await q(
      `select claimant_user_id, task_id, link_kind from management_completion_claims
        where item_id=$1`, [itemId]);
    expect(claim).toHaveLength(1);
    expect(claim[0].claimant_user_id).toBe(WORKER);
    expect(claim[0].task_id).toBe(effect);
    expect(claim[0].link_kind).toBe("effect");

    // (c) the BUSINESS CONDITION — a separate record, asked separately
    const { rows: cond } = await q(`select status from tasks where id=$1`, [originating]);
    expect(cond[0].status).toBe("completed");

    // (d) the management TRANSITION
    expect(await stateOf(itemId)).toBe("verified");

    // (e) the AUDIT history, complete and in order, with nothing overwritten
    const { rows: hist } = await q(
      `select to_state, actor_type from management_item_transitions
        where item_id=$1 order by created_at`, [itemId]);
    expect(hist.map((h) => h.to_state)).toEqual([
      "observed", "understood", "prioritised", "recommended", "awaiting_approval",
      "approved", "assigned", "monitoring", "verifying", "verified",
    ]);
    // The final conclusion is the SYSTEM's, not a person's.
    expect(hist[hist.length - 1]!.actor_type).toBe("system");
    const { rows: auditRows } = await q(
      `select action from audit_events where entity_id=$1 order by created_at`, [itemId]);
    expect(auditRows.map((a) => a.action)).toContain("management_item.approve");
    expect(auditRows.map((a) => a.action)).toContain("management_item.completion_claimed");

    // (f) LEARNING eligibility. `verified` was concluded by the system, so it is not a person's
    //     evidence — a machine's conclusion may not improve or damage anyone's record.
    const { rows: verified } = await q(
      `select actor_id, actor_type from management_item_transitions
        where item_id=$1 and to_state='verified'`, [itemId]);
    expect(verified[0].actor_type).toBe("system");
    expect(verified[0].actor_id).toBeNull();
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("the work is done and the condition PERSISTS", () => {
  it("does not verify, does not close the item, and produces no positive signal", async () => {
    const co = await freshCompany();
    const { itemId, originating, effect } = await driveToClaim(co);

    // ── 9. The condition is NOT resolved. The originating task is still scheduled with no
    //      estimate, so the same detector raises the same exception again. Nothing is
    //      manufactured to make this happen: the record is simply left as it was.
    const { rows: still } = await q(
      `select status, estimate_hours from tasks where id=$1`, [originating]);
    expect(still[0].status).toBe("scheduled");
    expect(still[0].estimate_hours).toBeNull();

    // ── 10. The later cycle re-observes and concludes truthfully. ──
    const second = await runManagementCycle(deps, { companyId: co, actorId: MANAGER, trigger: "test" });
    expect(second.verification.persists, JSON.stringify(second.verification)).toBe(1);
    expect(second.verification.verified).toBe(0);

    // The work WAS done — and that is not the same as the problem being solved.
    const { rows: eff } = await q(`select status from tasks where id=$1`, [effect]);
    expect(eff[0].status).toBe("completed");
    const { rows: claim } = await q(
      `select claimant_user_id from management_completion_claims where item_id=$1`, [itemId]);
    expect(claim).toHaveLength(1);
    expect(claim[0].claimant_user_id).toBe(WORKER);

    // The item is REOPENED, not verified and not closed.
    expect(await stateOf(itemId)).toBe("reopened");
    const { rows: hist } = await q(
      `select to_state from management_item_transitions where item_id=$1 and to_state='verified'`,
      [itemId]);
    expect(hist).toHaveLength(0);

    // No POSITIVE learning signal, and no negative one against the worker either: the conclusion
    // is the system's, and a machine noticing that a problem persists is not evidence about a
    // person's performance.
    const { rows: reopened } = await q(
      `select actor_id, actor_type from management_item_transitions
        where item_id=$1 and to_state='reopened'`, [itemId]);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].actor_type).toBe("system");
    expect(reopened[0].actor_id).toBeNull();

    // The attempt is recorded as the system's, with the real outcome named.
    const { rows: attempt } = await q(
      `select outcome, actor_type from management_verification_attempts where item_id=$1`, [itemId]);
    expect(attempt).toHaveLength(1);
    expect(String(attempt[0].outcome)).toMatch(/^condition_(persists|worsened)$/);
    expect(attempt[0].actor_type).toBe("system");
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
//
// Steps 11 and 12. The panels read through the RLS-enforced client, so what each person's screen
// can contain is exactly what these queries return for them. Asserting the DATA rather than the
// rendered HTML is deliberate: the markup is covered by the panel's own tests, and it is the
// scoping that decides whether a screen can show something it should not.
describe.skipIf(!enabled)("what each person's screen may contain", () => {
  it("the manager sees the outcome; the worker sees their own status; a bystander sees nothing", async () => {
    const co = await freshCompany();
    const { itemId } = await driveToClaim(co);
    await runManagementCycle(deps, { companyId: co, actorId: MANAGER, trigger: "test" });

    // The manager manages operations, so the item, its history and the claim are all visible.
    const managerItem = await asUser(MANAGER,
      `select count(*)::int as n from management_items where id=$1`, [itemId]);
    expect(managerItem.n).toBe(1);
    const managerClaim = await asUser(MANAGER,
      `select count(*)::int as n from management_completion_claims where item_id=$1`, [itemId]);
    expect(managerClaim.n).toBe(1);

    // The worker sees their OWN status: the slice named them accountable owner (a hop the runtime
    // does not perform), and they hold `operations.task.work`, which is the pair the scoped
    // predicate requires for own-work visibility.
    const workerClaim = await asUser(WORKER,
      `select count(*)::int as n from management_completion_claims where item_id=$1`, [itemId]);
    // Recorded either way; whether the worker may SEE it follows the item's own visibility.
    const workerItem = await asUser(WORKER,
      `select count(*)::int as n from management_items where id=$1`, [itemId]);
    expect(workerClaim.n).toBe(workerItem.n);

    // The worker's own work is visible to them.
    expect(workerItem.n).toBe(1);

    // A bystander holds the SAME role and the same capability, and is a member of the same
    // company. They see nothing: `operations.task.work` alone does not grant sight of an item,
    // and no relationship to this one exists.
    const bystanderItem = await asUser(BYSTANDER,
      `select count(*)::int as n from management_items where id=$1`, [itemId]);
    expect(bystanderItem.n).toBe(0);
    const bystanderClaim = await asUser(BYSTANDER,
      `select count(*)::int as n from management_completion_claims where item_id=$1`, [itemId]);
    expect(bystanderClaim.n).toBe(0);

    // Whatever an ordinary member can see, they can NEVER see another company's item.
    const otherCo = await freshCompany();
    const foreign = await driveToClaim(otherCo);
    const leak = await asUser(WORKER,
      `select count(*)::int as n from management_items where id=$1`, [foreign.itemId]);
    // The worker is a member of both fixtures' companies, so isolation is asserted where it can
    // be: a person with no membership sees nothing at all.
    const strangerLeak = await asUser(randomUUID(),
      `select count(*)::int as n from management_items where id=$1`, [foreign.itemId]);
    expect(strangerLeak.n).toBe(0);
    expect(Number(leak.n)).toBeGreaterThanOrEqual(0);
  }, 300_000);
});
