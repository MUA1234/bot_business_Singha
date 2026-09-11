/**
 * The lifecycle, driven by the graph the runtime actually builds (R2F-F-014).
 *
 * ── What was wrong ───────────────────────────────────────────────────────────────────────────
 *
 * Four spans of the management lifecycle had no writer. The cycle filed an item in `observed` and
 * nothing ever moved it, so the decision boundary, the completion claim and outcome verification
 * were three correct mechanisms with nothing to operate on. Every one of them was tested, and none
 * of them was reachable.
 *
 * Every test below constructs the dependency graph the SAME way the request path does —
 * `makeCycleDeps(client)`, with the real defaults — and drives `runManagementCycle`. Nothing
 * supplies its own orchestrator: a test that did could not detect the defect, because it would
 * construct the dependency the runtime was missing.
 *
 * TWO substitutions, both stated rather than glossed. The HTTP transport is `pgSupabase`, this
 * repository's established way of running production modules against a real database. The
 * execution SQL transport is injected — and that injection is now a CHOICE rather than a
 * necessity, which is the one thing about this header that has changed.
 *
 * It used to be a necessity, and that was R2F-F-019: the execution service read its ledger and its
 * loaders through direct SQL, the request path speaks PostgREST, and no server path had a
 * transport at all. This suite injected one so the lifecycle could be proven end to end, and said
 * so, because a proof that quietly supplies the missing dependency proves nothing about the
 * deployed system.
 *
 * That gap is closed. `makeCycleDeps` with no SQL transport now reaches the executor over named
 * RPCs, and `r2f-postgrest-execution.test.ts` drives this same loop through that composition with
 * nothing injected. What this suite keeps injecting is the SQL transport specifically, because
 * these tests are about the LIFECYCLE and the SQL path is the one they were written against;
 * changing them to the other transport would re-prove the transport and stop re-proving the
 * lifecycle.
 *
 * ── The authority separation, asserted rather than described ─────────────────────────────────
 *
 * The system advances, recommends, requests approval, executes the one authorised automatic action
 * and monitors. It never approves on a person's behalf, never assigns, and never claims a
 * completion. Those transitions are unreachable from the orchestrator, and the tests prove they
 * stay unreachable by driving many cycles and reading what did NOT happen.
 *
 * Synthetic data, disposable local PostgreSQL, no network, no model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps, type CycleSummary } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";
import type { SqlExec } from "@/kernel/execution/ledger";
import { LOCAL_EXECUTION_TOKEN } from "@/kernel/execution/boundary";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const MANAGER = randomUUID();
const WORKER = randomUUID();

let raw: pg.Client;
let deps: CycleDeps;
let executingDeps: CycleDeps;
let savedFlag: string | undefined;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

async function seedPerson(user: string, company: string, roleKey: string): Promise<string> {
  await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [user]);
  await q(
    `insert into users (id, full_name, is_active) values ($1,'orch person',true)
       on conflict (id) do nothing`, [user]);
  await q(
    `insert into profiles (id, company_id, username, full_name, department, is_active)
     values ($1,$2,$3,'orch person','operations',true) on conflict (id) do nothing`,
    [user, company, `orch-${user.slice(0, 8)}`]);
  const { rows } = await q(
    `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
       on conflict (company_id, user_id) do update set status='active' returning id`,
    [company, user]);
  await q(
    `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)
       on conflict do nothing`, [rows[0].id, company, roleKey]);
  return String(rows[0].id);
}

interface Fixture { co: string; taskId: string; managerMembership: string; workerMembership: string }

/** A company with the kernel and execution enabled, and one unestimated task to be observed. */
async function fixture(opts: { execution?: boolean } = {}): Promise<Fixture> {
  const co = randomUUID();
  await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`,
    [co, `orch ${co.slice(0, 8)}`]);
  const managerMembership = await seedPerson(MANAGER, co, "project_manager");
  const workerMembership = await seedPerson(WORKER, co, "staff_submitter");
  await q(
    `insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
     values ($1,true,$2,now()) on conflict (company_id) do update set enabled = true`, [co, MANAGER]);
  await q(
    `insert into management_execution_enablement (company_id, enabled, enabled_by, enabled_at)
     values ($1,$2,$3,now()) on conflict (company_id) do update set enabled = excluded.enabled`,
    [co, opts.execution !== false, MANAGER]);
  const { rows } = await q(
    `insert into tasks (company_id, title, status, due_date, estimate_hours)
     values ($1,'orchestrator condition','scheduled',null,null) returning id`, [co]);
  return { co, taskId: String(rows[0].id), managerMembership, workerMembership };
}

const cycle = (co: string, graph: CycleDeps = deps): Promise<CycleSummary> =>
  runManagementCycle(graph, { companyId: co, actorId: MANAGER, trigger: "test" });

const stateOf = async (itemId: string): Promise<string> => {
  const { rows } = await q(`select state from management_items where id=$1`, [itemId]);
  return String(rows[0]?.state);
};

const itemFor = async (co: string, taskId: string): Promise<string> => {
  const { rows } = await q(
    `select id from management_items
      where company_id=$1 and subject_table='tasks' and subject_id=$2`, [co, taskId]);
  expect(rows, "the detector raised no item for the seeded condition").toHaveLength(1);
  return String(rows[0].id);
};

/**
 * Approve an item as the manager would, through the REAL decision RPC, as a real signed-in person.
 *
 * R2F-F-020: no item the cycle files can resolve to `automatic` authority, because
 * `authorityFor` supplies a null actor membership — correctly, since the cycle proposes and never
 * approves — and the authority engine escalates a null actor to `manager_approval` and fails
 * closed. So every cycle-created item waits for a person here. That is the real path, and it is
 * the one these tests drive.
 */
async function approveAsManager(co: string, itemId: string) {
  const { rows: item } = await q(
    `select proposed_action_id from management_items where id=$1`, [itemId]);
  const { rows: dg } = await q(
    `select public.r1_draft_evidence_digest($1,$2) as d`, [co, itemId]);
  await q("begin");
  try {
    await q("set local role authenticated");
    await q(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: MANAGER }),
    ]);
    const { rows } = await q(
      `select public.r1_draft_record_management_decision($1,'approve','awaiting_approval',$2,$3,null,null,$4) as r`,
      [itemId, item[0].proposed_action_id, String(dg[0].d), `orch-${itemId}`],
    );
    await q("commit");
    const r = rows[0].r as { ok?: boolean };
    if (r?.ok !== true) throw new Error(`approval refused: ${JSON.stringify(r)}`);
  } catch (e) {
    await q("rollback");
    throw e;
  }
}

/**
 * Assign the item's effect task to `membershipId`, through the REAL assignment RPC as the manager.
 *
 * The orchestrator cannot do this and must not: binding assignment is a human act with its own
 * boundary. It is here so the suite can reach `assigned` and exercise what the orchestrator does
 * once a person has acted.
 */
async function assignAsManager(co: string, itemId: string, membershipId: string) {
  const { rows: dg } = await q(
    `select public.r1_draft_evidence_digest($1,$2) as d`, [co, itemId]);
  const { rows: elig } = await q(
    `select eligibility_evidence_digest from management_item_recommendations
      where item_id=$1 and purpose='assignee' and candidate_ref=$2
      order by created_at desc, id desc limit 1`, [itemId, membershipId]);
  await q("begin");
  try {
    await q("set local role authenticated");
    await q(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: MANAGER }),
    ]);
    const { rows } = await q(
      `select public.r1_draft_assign_management_item($1,$2,'needs_routing',$3,$4,$5,$6) as r`,
      [itemId, membershipId, String(dg[0].d),
       elig.length ? String(elig[0].eligibility_evidence_digest) : null,
       "assigned for the mismatch test", `orch-asg-${itemId}`],
    );
    await q("commit");
    const r = rows[0].r as { ok?: boolean };
    if (r?.ok !== true) throw new Error(`assignment refused: ${JSON.stringify(r)}`);
  } catch (e) {
    await q("rollback");
    throw e;
  }
}

/** Run cycles until the item stops moving, or `max` is reached. Returns every state it passed. */
async function settle(
  co: string, itemId: string, max = 10, graph: CycleDeps = deps,
): Promise<string[]> {
  const seen: string[] = [await stateOf(itemId)];
  // TWO quiet cycles before giving up, not one. A cycle that executes changes the world without
  // changing the state, and stopping at the first no-change would miss the step that follows it.
  let quiet = 0;
  for (let i = 0; i < max; i++) {
    await cycle(co, graph);
    const s = await stateOf(itemId);
    if (s === seen[seen.length - 1]) {
      if (++quiet >= 2) break;
      continue;
    }
    quiet = 0;
    seen.push(s);
  }
  return seen;
}

beforeAll(async () => {
  if (!enabled) return;
  savedFlag = process.env.MANAGEMENT_KERNEL;
  process.env.MANAGEMENT_KERNEL = "on";
  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();
  await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  // The real factory, with the real defaults — plus the execution SQL transport. Injecting it is
  // a choice, not a necessity: the factory reaches the executor over PostgREST without it (see the
  // header). These tests are about the LIFECYCLE, and the SQL path is the one they were written
  // against, so they keep driving it.
  const execSql: SqlExec = async (text, params) => {
    const r = await raw.query(text, params as unknown[]);
    return { rows: r.rows as Record<string, unknown>[] };
  };
  // THE DEPLOYED SHAPE. Execution is switched off at the global boundary — `EXECUTION_ENABLED` is
  // unset in this process and the default is off — so this graph reaches `approved` and records
  // the refusal.
  deps = makeCycleDeps(pgSupabase(raw), () => new Date(), undefined, execSql);
  // The same graph, plus the deterministic-local-test token. The only thing that differs is the
  // one value `boundary.ts` says a caller must type into a test file.
  executingDeps = makeCycleDeps(
    pgSupabase(raw), () => new Date(), undefined, execSql, LOCAL_EXECUTION_TOKEN,
  );
}, 180_000);

afterAll(async () => {
  if (!enabled) return;
  if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
  else process.env.MANAGEMENT_KERNEL = savedFlag;
  await raw?.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("the deployed-shaped cycle advances an item", () => {
  it("supplies the lifecycle sweep from the real factory", () => {
    // Not a style check. An optional dependency this factory did not provide is exactly how the
    // middle of the lifecycle came to have no writer at all.
    expect(typeof deps.lifecycleSweep).toBe("function");
  });

  it("carries a new item from observed to needs_routing, one auditable step at a time", async () => {
    const f = await fixture();
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);
    // The orchestrator runs in the SAME cycle that files the item — after observation, so a new
    // item moves in the pass that found it rather than waiting a full period.
    expect(await stateOf(itemId)).toBe("understood");

    // The system takes it as far as it may, and stops where a person is required.
    expect(await settle(f.co, itemId)).toEqual(["understood", "prioritised", "recommended", "awaiting_approval"]);

    // A real manager approves, through the real decision RPC.
    await approveAsManager(f.co, itemId);
    expect(await stateOf(itemId)).toBe("approved");

    // In the DEPLOYED shape the system asks the executor and is refused at the global boundary.
    // The item stays approved, and the refusal is recorded against it by name.
    const deployed = await cycle(f.co);
    expect(await stateOf(itemId)).toBe("approved");
    expect(deployed.lifecycle.notes.find((n) => n.itemId === itemId)?.reason)
      .toBe("global_boundary_disabled");
    expect(deployed.status).toBe("partial");

    // With the deterministic local token — and nothing else different — it carries out the one
    // action it is registered to carry out, and stops again.
    expect(await settle(f.co, itemId, 10, executingDeps)).toEqual(["approved", "needs_routing"]);

    const { rows: history } = await q(
      `select from_state, to_state, actor_type, actor_id, reason
         from management_item_transitions where item_id=$1 order by created_at`, [itemId]);
    // Each state was actually occupied. Driving an item through six decisions inside one opaque
    // transaction would reach the same end and destroy the record of how it got there.
    expect(history.map((h) => h.to_state)).toEqual([
      "observed", "understood", "prioritised", "recommended",
      "awaiting_approval", "approved", "needs_routing",
    ]);

    // Every SYSTEM advance is recorded as the service's act, with a reason and no person named.
    // The approval is the one transition attributed to a human, and it is the human's.
    for (const h of history.slice(1)) {
      if (h.to_state === "approved") {
        expect(h.actor_type).toBe("user");
        expect(h.actor_id).toBe(MANAGER);
        // An approval needs no reason — only a rejection does, which is the existing rule.
      } else {
        expect(h.actor_type).toBe("system");
        expect(h.actor_id).toBeNull();
        // Every SYSTEM advance says why. A state change with no reason is a change nobody can
        // account for later.
        expect(String(h.reason ?? "")).not.toBe("");
      }
    }
  }, 240_000);

  it("creates exactly ONE unassigned task, and does not name an accountable owner", async () => {
    const f = await fixture();
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);
    await settle(f.co, itemId, 10, executingDeps);
    await approveAsManager(f.co, itemId);
    await settle(f.co, itemId, 10, executingDeps);

    const { rows: attempts } = await q(
      `select status, effect_ref from management_execution_attempts where item_id=$1`, [itemId]);
    expect(attempts.map((a) => a.status)).toEqual(["executed"]);

    const { rows: task } = await q(
      `select assigned_to, status from tasks where id=$1`, [attempts[0].effect_ref]);
    // The executor may create work. It may not give it to anyone — that is a human's act.
    expect(task[0].assigned_to).toBeNull();

    const { rows: item } = await q(
      `select accountable_owner_id, routing_reason from management_items where id=$1`, [itemId]);
    expect(item[0].accountable_owner_id).toBeNull();
    // And it SAYS why it is waiting, rather than sitting silently.
    expect(String(item[0].routing_reason ?? "")).toMatch(/route/i);
  }, 240_000);

  it("runs the automatic action once however many cycles pass", async () => {
    const f = await fixture();
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);
    await settle(f.co, itemId, 10, executingDeps);
    await approveAsManager(f.co, itemId);
    await settle(f.co, itemId, 10, executingDeps);
    for (let i = 0; i < 3; i++) await cycle(f.co, executingDeps);

    const { rows } = await q(
      `select count(*)::int as n from management_execution_attempts
        where item_id=$1 and status='executed'`, [itemId]);
    expect(rows[0].n).toBe(1);
    const { rows: tasks } = await q(
      `select count(*)::int as n from tasks where company_id=$1`, [f.co]);
    // The condition task, plus exactly one effect.
    expect(tasks[0].n).toBe(2);
  }, 240_000);

  it("stops at needs_routing and stays there — the system never assigns", async () => {
    const f = await fixture();
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);
    await settle(f.co, itemId, 10, executingDeps);
    await approveAsManager(f.co, itemId);
    await settle(f.co, itemId, 10, executingDeps);
    for (let i = 0; i < 4; i++) await cycle(f.co, executingDeps);

    expect(await stateOf(itemId)).toBe("needs_routing");
    const { rows } = await q(
      `select count(*)::int as n from management_item_transitions
        where item_id=$1 and to_state in ('assigned','monitoring','verifying','verified')`, [itemId]);
    expect(rows[0].n).toBe(0);
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("what the system will not do", () => {
  it("an action needing approval waits at awaiting_approval and is never approved", async () => {
    const f = await fixture();
    // An OVERDUE task maps to `ops.task.request_progress_update` — a draft-only action requiring
    // a person. Nothing about it is automatic.
    await q(
      `insert into tasks (company_id, title, status, due_date, estimate_hours)
       values ($1,'overdue condition','in_progress','2020-01-01'::date,4)`, [f.co]);
    await cycle(f.co);

    const { rows: items } = await q(
      `select id, proposed_action_id from management_items
        where company_id=$1 and kind='overdue'`, [f.co]);
    expect(items.length).toBeGreaterThan(0);
    const itemId = String(items[0].id);
    expect(items[0].proposed_action_id).not.toBe("ops.task.create_internal");

    const states = await settle(f.co, itemId, 10, executingDeps);
    expect(states[states.length - 1]).toBe("awaiting_approval");

    // Many more cycles. It does not approve itself.
    for (let i = 0; i < 4; i++) await cycle(f.co, executingDeps);
    expect(await stateOf(itemId)).toBe("awaiting_approval");
    const { rows: decisions } = await q(
      `select count(*)::int as n from management_item_decisions where item_id=$1`, [itemId]);
    expect(decisions[0].n).toBe(0);
    // And nothing was executed for a draft-only action.
    const { rows: attempts } = await q(
      `select count(*)::int as n from management_execution_attempts
        where item_id=$1 and status='executed'`, [itemId]);
    expect(attempts[0].n).toBe(0);
  }, 240_000);

  /**
   * Found by mutation, not by design.
   *
   * Opening the orchestrator's execute branch to EVERY catalogue action — dropping the
   * `actionId === AUTOMATIC_ACTION_ID` test — survived the whole suite. Nothing here had ever
   * approved a draft-only action, so nothing ever reached the branch with an action the system
   * must not carry out. The executor would still have refused it, but a second guard that is
   * never exercised is a guard nobody knows the state of.
   *
   * So: approve a DRAFT-ONLY action, and require that the system does not even try.
   */
  /**
   * Also found by mutation.
   *
   * Removing the assignee / accountable-owner agreement check survived the whole suite, because
   * draft 028 writes both in one act and nothing here had ever made them disagree. A guard that
   * defends against a state the tests never construct is a guard nobody knows the state of.
   *
   * So: make them disagree, and require an explicit HOLD rather than a silent repair. The
   * disagreement is created by writing the task directly — which is the only way to produce it,
   * and precisely why the check has to exist for the day something else does.
   */
  it("a disagreement between the accountable owner and the task assignee HOLDS the item", async () => {
    const f = await fixture();
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);
    await settle(f.co, itemId);
    await approveAsManager(f.co, itemId);
    await settle(f.co, itemId, 10, executingDeps);
    expect(await stateOf(itemId)).toBe("needs_routing");

    await assignAsManager(f.co, itemId, f.workerMembership);
    expect(await stateOf(itemId)).toBe("assigned");

    // The item says WORKER is accountable. Make the task say somebody else.
    const { rows: effect } = await q(
      `select effect_ref from management_execution_attempts
        where item_id=$1 and status='executed'`, [itemId]);
    await q(`update tasks set assigned_to=$1 where id=$2`, [MANAGER, effect[0].effect_ref]);

    const summary = await cycle(f.co, executingDeps);
    const note = summary.lifecycle.notes.find((n) => n.itemId === itemId);
    expect(note?.outcome).toBe("held");
    expect(note?.reason).toMatch(/different people/);

    // Not advanced, and not quietly corrected. Guessing which record is right would make the
    // history worse than leaving the disagreement visible.
    for (let i = 0; i < 3; i++) await cycle(f.co, executingDeps);
    expect(await stateOf(itemId)).toBe("assigned");
  }, 300_000);

  it("an APPROVED draft-only action is left for a person; the system does not attempt it", async () => {
    const f = await fixture();
    await q(
      `insert into tasks (company_id, title, status, due_date, estimate_hours)
       values ($1,'overdue draft-only condition','in_progress','2020-01-01'::date,4)`, [f.co]);
    await cycle(f.co);

    const { rows: items } = await q(
      `select id, proposed_action_id from management_items
        where company_id=$1 and kind='overdue'`, [f.co]);
    expect(items.length).toBeGreaterThan(0);
    const itemId = String(items[0].id);
    // `ops.task.request_progress_update` — registered, and classified draft-only: a person
    // carries it out, and there is no handler for the system to call.
    expect(items[0].proposed_action_id).not.toBe("ops.task.create_internal");

    await settle(f.co, itemId);
    expect(await stateOf(itemId)).toBe("awaiting_approval");
    await approveAsManager(f.co, itemId);
    expect(await stateOf(itemId)).toBe("approved");

    // The executing graph, with the local token — so nothing but the action's own classification
    // stands between this item and an effect.
    const summary = await cycle(f.co, executingDeps);
    const note = summary.lifecycle.notes.find((n) => n.itemId === itemId);
    expect(note?.outcome).toBe("awaiting_human");
    expect(note?.reason).toMatch(/not one the system performs/);

    for (let i = 0; i < 3; i++) await cycle(f.co, executingDeps);
    const { rows: attempts } = await q(
      `select count(*)::int as n from management_execution_attempts where item_id=$1`, [itemId]);
    // Not "refused" — NOT ATTEMPTED. A refusal recorded against this item would mean the system
    // tried to carry out an action a person is supposed to perform.
    expect(attempts[0].n).toBe(0);
    expect(await stateOf(itemId)).toBe("approved");
  }, 300_000);

  it("with execution disabled it reaches approved and stops, creating nothing", async () => {
    const f = await fixture({ execution: false });
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);
    await settle(f.co, itemId, 10, executingDeps);
    await approveAsManager(f.co, itemId);
    await settle(f.co, itemId, 10, executingDeps);
    for (let i = 0; i < 3; i++) await cycle(f.co, executingDeps);

    // Authorised, and not carried out. Those are different facts and the item shows both.
    expect(await stateOf(itemId)).toBe("approved");
    const { rows } = await q(
      `select count(*)::int as n from management_execution_attempts
        where item_id=$1 and status='executed'`, [itemId]);
    expect(rows[0].n).toBe(0);
    const { rows: tasks } = await q(
      `select count(*)::int as n from tasks where company_id=$1`, [f.co]);
    expect(tasks[0].n).toBe(1);
  }, 240_000);

  it("a DISABLED company is not advanced at all", async () => {
    const f = await fixture();
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);
    await q(`update management_kernel_enablement set enabled=false where company_id=$1`, [f.co]);

    // Wherever the first cycle left it, disabling freezes it there.
    const before = await stateOf(itemId);
    const summary = await cycle(f.co);
    expect(summary.status).toBe("skipped_disabled");
    expect(summary.lifecycle.considered).toBe(0);
    for (let i = 0; i < 3; i++) await cycle(f.co);
    expect(await stateOf(itemId)).toBe(before);
  }, 240_000);

  it("never advances another company's items", async () => {
    const a = await fixture();
    const b = await fixture();
    await cycle(b.co);
    const foreign = await itemFor(b.co, b.taskId);
    const foreignBefore = await stateOf(foreign);

    for (let i = 0; i < 4; i++) await cycle(a.co);
    expect(await stateOf(foreign)).toBe(foreignBefore);
  }, 240_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("bounded, idempotent, and honest about what it could not do", () => {
  it("reports each item's outcome with a reason, and holds what it cannot move", async () => {
    const f = await fixture();
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);

    const summary = await cycle(f.co);
    expect(summary.lifecycle.considered).toBeGreaterThan(0);
    expect(summary.lifecycle.advanced).toBeGreaterThan(0);
    // Every note names an item and says what happened to it. A summary of counts alone cannot be
    // acted on by whoever reads it.
    for (const n of summary.lifecycle.notes) {
      expect(n.itemId).toBeTruthy();
      expect(n.reason).toBeTruthy();
    }
    expect(await stateOf(itemId)).not.toBe("observed");
  }, 240_000);

  it("an item with no usable action is HELD, visibly, and never advanced past prioritised", async () => {
    const f = await fixture();
    await cycle(f.co);
    const itemId = await itemFor(f.co, f.taskId);
    // Strip the action. The item is now something the system cannot act on, and saying so is the
    // only honest thing it can do.
    await q(`update management_items set proposed_action_id=null where id=$1`, [itemId]);

    for (let i = 0; i < 4; i++) await cycle(f.co, executingDeps);
    expect(await stateOf(itemId)).toBe("prioritised");

    const summary = await cycle(f.co);
    const note = summary.lifecycle.notes.find((n) => n.itemId === itemId);
    expect(note?.outcome).toBe("held");
    expect(note?.reason).toMatch(/no action has been proposed/);
  }, 240_000);

  it("one item's failure does not advance another", async () => {
    const f = await fixture();
    const { rows: second } = await q(
      `insert into tasks (company_id, title, status, due_date, estimate_hours)
       values ($1,'second condition','scheduled',null,null) returning id`, [f.co]);
    const secondTaskId = String(second[0].id);
    await cycle(f.co);

    // The two seeded conditions, named by subject. Other detectors may legitimately raise items
    // of their own for this company, and counting everything would make this test about them.
    const { rows: items } = await q(
      `select id from management_items
        where company_id=$1 and subject_table='tasks' and subject_id = any($2::text[])
        order by created_at`,
      [f.co, [f.taskId, secondTaskId]]);
    expect(items.length).toBe(2);
    // Break the first: strip its evidence. It has already been advanced once by the cycle that
    // filed it, so what this proves is that it goes NO FURTHER — the database refuses to let an
    // item with no evidence be recommended, and the orchestrator records that instead of forcing
    // it through.
    await q(`delete from management_item_evidence where item_id=$1`, [items[0].id]);

    for (let i = 0; i < 6; i++) await cycle(f.co, executingDeps);
    const brokenState = await stateOf(String(items[0].id));
    expect(["observed", "understood", "prioritised"]).toContain(brokenState);
    expect(await stateOf(String(items[1].id))).toBe("awaiting_approval");

    await approveAsManager(f.co, String(items[1].id));
    for (let i = 0; i < 4; i++) await cycle(f.co, executingDeps);
    // The healthy item completed its journey; the broken one did not move at all.
    expect(await stateOf(String(items[0].id))).toBe(brokenState);
    expect(await stateOf(String(items[1].id))).toBe("needs_routing");
  }, 300_000);
});
