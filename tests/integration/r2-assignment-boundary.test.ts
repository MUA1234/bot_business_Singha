/**
 * Binding assignment: a human act, with the item and the task made to agree.
 *
 * ── The owner's decisions this encodes ───────────────────────────────────────────────────────
 *
 * AI assignment is RECOMMENDATION-ONLY for this phase. The system may rank and propose using the
 * existing resolver; it may not make a binding assignment. That requires an authenticated human
 * holding `operations.task.manage` in the relevant company.
 *
 * And `management_items.accountable_owner_id` may be set ONLY when a real binding assignment
 * occurs. The item naming one person while the task names another is the failure this boundary
 * exists to make impossible: both are written in one act, from one resolved membership, or neither
 * is written at all.
 *
 * Every item here is created by the REAL cycle, advanced by the REAL orchestrator, approved
 * through the REAL decision RPC and executed through the REAL execution service. Nothing below
 * seeds an item into a state it could not have reached.
 *
 * Synthetic data, disposable local PostgreSQL, no network, no model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { LOCAL_EXECUTION_TOKEN } from "@/kernel/execution/boundary";
import type { SqlExec } from "@/kernel/execution/ledger";
import { pgSupabase } from "./helpers/pg-supabase";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const MANAGER = randomUUID();
/** A second manager, for the concurrent-assignment case. */
const MANAGER_2 = randomUUID();
const WORKER = randomUUID();
const WORKER_2 = randomUUID();
/** Holds no operations capability at all. */
const FINANCE = randomUUID();

let raw: pg.Client;
let deps: CycleDeps;
let savedFlag: string | undefined;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

/** Read with RLS out of the way: "is it there", never "may I see it". */
async function physical<T = Record<string, unknown>>(
  sql: string, params: unknown[] = [],
): Promise<T[]> {
  await q("begin");
  try {
    await q("set local role postgres");
    const { rows } = await q(sql, params);
    return rows as T[];
  } finally {
    await q("commit");
  }
}

/** Run `sql` as a real signed-in person, with `auth.uid()` resolving to them. */
async function asUser(
  userId: string, sql: string, params: unknown[] = [], client: pg.Client = raw,
): Promise<Record<string, unknown>> {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: userId }),
    ]);
    const { rows } = await client.query(sql, params);
    await client.query("commit");
    return rows[0] as Record<string, unknown>;
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

async function seedPerson(user: string, company: string, roleKey: string): Promise<string> {
  await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [user]);
  await q(
    `insert into users (id, full_name, is_active) values ($1,'assign person',true)
       on conflict (id) do nothing`, [user]);
  await q(
    `insert into profiles (id, company_id, username, full_name, department, is_active)
     values ($1,$2,$3,'assign person','operations',true) on conflict (id) do nothing`,
    [user, company, `asg-${user.slice(0, 8)}`]);
  const { rows } = await q(
    `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
       on conflict (company_id, user_id) do update set status='active' returning id`,
    [company, user]);
  await q(
    `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)
       on conflict do nothing`, [rows[0].id, company, roleKey]);
  return String(rows[0].id);
}

interface Ready {
  co: string;
  itemId: string;
  taskId: string;
  memberships: Record<string, string>;
  conditionDigest: string;
}

/**
 * A company whose item has travelled the REAL path all the way to `needs_routing`: observed by the
 * detector, advanced by the orchestrator, approved by a manager through the decision RPC, and
 * executed into one unassigned task.
 */
async function readyForAssignment(): Promise<Ready> {
  const co = randomUUID();
  await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`,
    [co, `asg ${co.slice(0, 8)}`]);
  const memberships: Record<string, string> = {
    [MANAGER]: await seedPerson(MANAGER, co, "project_manager"),
    [MANAGER_2]: await seedPerson(MANAGER_2, co, "project_manager"),
    [WORKER]: await seedPerson(WORKER, co, "staff_submitter"),
    [WORKER_2]: await seedPerson(WORKER_2, co, "staff_submitter"),
    [FINANCE]: await seedPerson(FINANCE, co, "finance_reviewer"),
  };
  for (const t of ["management_kernel_enablement", "management_execution_enablement"]) {
    await q(
      `insert into ${t} (company_id, enabled, enabled_by, enabled_at) values ($1,true,$2,now())
         on conflict (company_id) do update set enabled = true`, [co, MANAGER]);
  }
  const { rows: task } = await q(
    `insert into tasks (company_id, title, status, due_date, estimate_hours)
     values ($1,'assignment condition','scheduled',null,null) returning id`, [co]);

  const cycle = () => runManagementCycle(deps, { companyId: co, actorId: MANAGER, trigger: "test" });
  await cycle();
  const { rows: items } = await q(
    `select id from management_items
      where company_id=$1 and subject_table='tasks' and subject_id=$2`, [co, task[0].id]);
  const itemId = String(items[0].id);

  // Advance to the person who must decide.
  for (let i = 0; i < 5; i++) {
    await cycle();
    const { rows } = await q(`select state from management_items where id=$1`, [itemId]);
    if (rows[0].state === "awaiting_approval") break;
  }

  // A real manager approves, through the real RPC.
  const { rows: item } = await q(
    `select proposed_action_id from management_items where id=$1`, [itemId]);
  const { rows: dg } = await q(`select public.r1_draft_evidence_digest($1,$2) as d`, [co, itemId]);
  const approval = await asUser(
    MANAGER,
    `select public.r1_draft_record_management_decision($1,'approve','awaiting_approval',$2,$3,null,null,$4) as r`,
    [itemId, item[0].proposed_action_id, String(dg[0].d), `asg-${itemId}`],
  );
  expect((approval.r as { ok?: boolean }).ok, JSON.stringify(approval.r)).toBe(true);

  // Execute, and route.
  for (let i = 0; i < 4; i++) {
    await runManagementCycle(executingDeps, { companyId: co, actorId: MANAGER, trigger: "test" });
    const { rows } = await q(`select state from management_items where id=$1`, [itemId]);
    if (rows[0].state === "needs_routing") break;
  }
  const { rows: state } = await q(`select state from management_items where id=$1`, [itemId]);
  expect(state[0].state, "the real path did not reach needs_routing").toBe("needs_routing");

  const { rows: effect } = await q(
    `select effect_ref from management_execution_attempts
      where item_id=$1 and status='executed'`, [itemId]);
  const { rows: digests } = await q(
    `select public.r1_draft_evidence_digest($1,$2) as condition`, [co, itemId]);

  return {
    co, itemId, taskId: String(effect[0].effect_ref), memberships,
    conditionDigest: String(digests[0].condition),
  };
}

/**
 * The eligibility digest recorded FOR ONE CANDIDATE, or null when nobody recommended them.
 *
 * The resolver writes one snapshot per ranked candidate, all in the same statement and so all
 * sharing a `created_at`. "The latest snapshot" is therefore not a thing: what a manager is acting
 * on is the evidence about the person they are assigning, and that is what both the caller and the
 * boundary have to look up.
 */
async function eligibilityFor(itemId: string, membershipId: string): Promise<string | null> {
  const { rows } = await q(
    `select eligibility_evidence_digest from management_item_recommendations
      where item_id=$1 and purpose='assignee' and candidate_ref=$2
      order by created_at desc, id desc limit 1`,
    [itemId, membershipId]);
  return rows.length === 0 ? null : String(rows[0].eligibility_evidence_digest);
}

let executingDeps: CycleDeps;

/**
 * Ensure a recommendation snapshot NAMING this candidate exists, and return its eligibility digest.
 *
 * The resolver only ranks candidates it can evidence — verified skills, recorded capacity — and
 * this fixture's people have none, so it records a `needs_routing` snapshot naming nobody. That is
 * correct behaviour and it makes the "a recommended candidate went stale" path unreachable by
 * observation alone.
 *
 * The snapshot written here is the shape the resolver itself produces when it CAN rank someone:
 * `outcome='candidates'`, a `candidate_ref`, and an eligibility digest computed by the REAL SQL
 * function over real eligibility refs. Nothing about it is a shape production cannot reach.
 */
async function ensureRecommended(r: Ready, membershipId: string): Promise<string> {
  const existing = await eligibilityFor(r.itemId, membershipId);
  if (existing !== null) return existing;

  const refs = [
    { sourceTable: "membership_roles", sourceId: `mr-${membershipId}` },
    { sourceTable: "capacity", sourceId: `cap-${membershipId}` },
  ];
  const { rows } = await q(
    `select public.r1_draft_eligibility_digest($1::jsonb) as d,
            public.r1_draft_evidence_digest($2,$3) as cond`,
    [JSON.stringify(refs), r.co, r.itemId]);
  await q(
    `insert into management_item_recommendations
       (company_id, item_id, purpose, outcome, candidate_ref, candidate_type, rank_position,
        resolver_version, signal_rule_version, fingerprint, evidence_refs,
        condition_evidence_digest, eligibility_evidence_digest, action_id, policy_version)
     values ($1,$2,'assignee','candidates',$3,'staff',1,'asg','asg',$4,$5::jsonb,$6,$7,
             'ops.task.create_internal','r2e.policy.1')`,
    [r.co, r.itemId, membershipId, `fp-${membershipId}-${randomUUID()}`,
     JSON.stringify(refs), rows[0].cond, rows[0].d]);
  return String(rows[0].d);
}

/** The assignment RPC, invoked as `userId`. */
function assign(
  userId: string,
  a: {
    itemId: string; membershipId: string; state?: string;
    condition: string; eligibility: string | null;
    overrideReason?: string | null; key?: string | null;
  },
  client: pg.Client = raw,
) {
  return asUser(
    userId,
    `select public.r1_draft_assign_management_item($1,$2,$3,$4,$5,$6,$7) as r`,
    [a.itemId, a.membershipId, a.state ?? "needs_routing", a.condition, a.eligibility,
     a.overrideReason ?? null, a.key ?? null],
    client,
  ).then((row) => row.r as Record<string, unknown>);
}

beforeAll(async () => {
  if (!enabled) return;
  savedFlag = process.env.MANAGEMENT_KERNEL;
  process.env.MANAGEMENT_KERNEL = "on";
  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();
  await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  const execSql: SqlExec = async (text, params) => {
    const r = await raw.query(text, params as unknown[]);
    return { rows: r.rows as Record<string, unknown>[] };
  };
  deps = makeCycleDeps(pgSupabase(raw), () => new Date(), undefined, execSql);
  executingDeps = makeCycleDeps(
    pgSupabase(raw), () => new Date(), undefined, execSql, LOCAL_EXECUTION_TOKEN);
}, 180_000);

afterAll(async () => {
  if (!enabled) return;
  if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
  else process.env.MANAGEMENT_KERNEL = savedFlag;
  await raw?.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("a manager assigns, and both identities are written as one", () => {
  it("writes the task assignee and the accountable owner together, with history", async () => {
    const r = await readyForAssignment();
    // The recommended candidate, assigned as recommended — so this is NOT an override, and the
    // record says so.
    const eligibility = await ensureRecommended(r, r.memberships[WORKER]!);
    const out = await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility,
      key: `k-${r.itemId}`,
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.result).toBe("assigned");

    // THE invariant: the item and the task name the same person.
    const rows = await physical<{ assigned_to: string; owner: string; user_id: string }>(
      `select t.assigned_to, i.accountable_owner_id as owner, m.user_id
         from management_items i
         join tasks t on t.id = $2
         join memberships m on m.id = i.accountable_owner_id
        where i.id = $1`,
      [r.itemId, r.taskId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBe(r.memberships[WORKER]);
    expect(rows[0]!.assigned_to).toBe(WORKER);
    expect(rows[0]!.user_id).toBe(rows[0]!.assigned_to);

    // The history says who assigned, who was recommended, and why the manager differed.
    const history = await physical(
      `select assigned_by_user_id, membership_id, is_override, override_reason,
              previous_membership_id
         from management_item_assignments where item_id=$1`, [r.itemId]);
    expect(history).toHaveLength(1);
    expect(history[0]!.assigned_by_user_id).toBe(MANAGER);
    expect(history[0]!.previous_membership_id).toBeNull();
    // Assigned exactly who was recommended: not an override, and no reason was required.
    expect(history[0]!.is_override).toBe(false);
    expect(history[0]!.override_reason).toBeNull();

    const items = await physical(`select state from management_items where id=$1`, [r.itemId]);
    expect(items[0]!.state).toBe("assigned");

    const audits = await physical(
      `select action from audit_events where entity_id=$1`, [r.itemId]);
    expect(audits.map((a) => a.action)).toContain("management_item.assigned");
  }, 300_000);

  it("reassignment appends history and PRESERVES the previous owner", async () => {
    const r = await readyForAssignment();
    await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
      overrideReason: "first choice", key: `first-${r.itemId}`,
    });
    const out = await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER_2]!, state: "assigned",
      condition: r.conditionDigest,
      eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER_2]!),
      overrideReason: "the first person went on leave", key: `second-${r.itemId}`,
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);

    const history = await physical<{ membership_id: string; previous_membership_id: string }>(
      `select membership_id, previous_membership_id from management_item_assignments
        where item_id=$1 order by assigned_at`, [r.itemId]);
    expect(history).toHaveLength(2);
    // "Who is accountable now" and "who was accountable then" are different questions, and both
    // are still answerable.
    expect(history[1]!.previous_membership_id).toBe(r.memberships[WORKER]);
    expect(history[1]!.membership_id).toBe(r.memberships[WORKER_2]);

    const rows = await physical(
      `select t.assigned_to, i.accountable_owner_id from management_items i, tasks t
        where i.id=$1 and t.id=$2`, [r.itemId, r.taskId]);
    expect(rows[0]!.assigned_to).toBe(WORKER_2);
    expect(rows[0]!.accountable_owner_id).toBe(r.memberships[WORKER_2]);
  }, 300_000);

  it("after assignment the cycle advances the item to monitoring", async () => {
    const r = await readyForAssignment();
    await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
      overrideReason: "assigned for the monitoring test", key: `mon-${r.itemId}`,
    });

    for (let i = 0; i < 3; i++) {
      await runManagementCycle(executingDeps, { companyId: r.co, actorId: MANAGER, trigger: "test" });
    }
    const rows = await physical(`select state from management_items where id=$1`, [r.itemId]);
    expect(rows[0]!.state).toBe("monitoring");
  }, 300_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("who may not assign, and to whom", () => {
  it("refuses a member with no operations.task.manage", async () => {
    const r = await readyForAssignment();
    const out = await assign(FINANCE, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
      overrideReason: "not mine to give", key: `f-${r.itemId}`,
    });
    expect(out.refusal).toBe("insufficient_capability");
    const rows = await physical(
      `select accountable_owner_id from management_items where id=$1`, [r.itemId]);
    expect(rows[0]!.accountable_owner_id).toBeNull();
  }, 300_000);

  it("refuses a worker assigning work to themselves", async () => {
    const r = await readyForAssignment();
    const out = await assign(WORKER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
      overrideReason: "I will do it", key: `self-${r.itemId}`,
    });
    // Staff cannot self-assign. The refusal is about the capability, which they do not hold.
    expect(out.refusal).toBe("insufficient_capability");
  }, 300_000);

  it("refuses a target from another company", async () => {
    const r = await readyForAssignment();
    const other = await readyForAssignment();
    const out = await assign(MANAGER, {
      itemId: r.itemId, membershipId: other.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: null,
      overrideReason: "cross-company", key: `x-${r.itemId}`,
    });
    expect(out.refusal).toBe("target_not_in_company");
  }, 600_000);

  it("refuses a target whose membership has ended", async () => {
    const r = await readyForAssignment();
    await q(`update memberships set status='ended' where id=$1`, [r.memberships[WORKER]]);
    const out = await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
      overrideReason: "gone", key: `end-${r.itemId}`,
    });
    expect(out.refusal).toBe("target_not_active");
    await q(`update memberships set status='active' where id=$1`, [r.memberships[WORKER]]);
  }, 300_000);

  it("refuses a target who cannot do the work", async () => {
    const r = await readyForAssignment();
    const out = await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[FINANCE]!,
      condition: r.conditionDigest,
      eligibility: await eligibilityFor(r.itemId, r.memberships[FINANCE]!),
      overrideReason: "wrong person", key: `cap-${r.itemId}`,
    });
    // The capability checked is the TARGET's. A manager may not hand work to somebody who is not
    // permitted to do it.
    expect(out.refusal).toBe("target_lacks_capability");
  }, 300_000);

  it("refuses a target on approved leave", async () => {
    const r = await readyForAssignment();
    await q(
      `insert into leave_requests (company_id, profile_id, start_date, end_date, days, status)
       values ($1,$2, current_date - 1, current_date + 1, 3, 'approved')`,
      [r.co, WORKER]);
    const out = await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
      overrideReason: "on leave", key: `lv-${r.itemId}`,
    });
    expect(out.refusal).toBe("target_unavailable");
  }, 300_000);

  it("refuses a service principal outright — it may not even call the function", async () => {
    const rows = await physical<{ grantee: string }>(
      `select r.rolname as grantee from pg_proc p, pg_roles r
        where p.proname = 'r1_draft_assign_management_item'
          and r.rolname in ('anon','service_role','authenticated')
          and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`);
    // Automatic binding assignment is exactly what the owner's decision forbids for this phase.
    expect(rows.map((x) => x.grantee).sort()).toEqual(["authenticated"]);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("staleness, overrides, retries and races", () => {
  it("refuses when the CONDITION evidence moved under the manager", async () => {
    const r = await readyForAssignment();
    await q(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id)
       values ($1,$2,'tasks',$3)`, [r.co, r.itemId, `later-${randomUUID()}`]);
    const out = await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
      overrideReason: "stale", key: `sc-${r.itemId}`,
    });
    expect(out.refusal).toBe("condition_changed");
  }, 300_000);

  it("refuses when the CANDIDATE recommendation moved — the R2F-F-017 assignment half", async () => {
    const r = await readyForAssignment();
    // A genuinely recommended candidate, so the eligibility evidence is a thing that can go stale.
    const fresh = await ensureRecommended(r, r.memberships[WORKER]!);
    expect(fresh).toMatch(/^[0-9a-f]{32}$|^empty$/);

    const out = await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: "a-different-eligibility",
      overrideReason: "stale candidate", key: `se-${r.itemId}`,
    });
    expect(out.refusal).toBe("recommendation_stale");
    // The unassigned task still exists: a stale candidate blocks the ASSIGNMENT, never the work.
    const rows = await physical(`select assigned_to from tasks where id=$1`, [r.taskId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assigned_to).toBeNull();
  }, 300_000);

  it("requires a reason when assigning somebody nobody recommended", async () => {
    const r = await readyForAssignment();
    // WORKER_2 may or may not have been ranked. Find a member the resolver did NOT put forward,
    // so the override is real rather than assumed.
    let unrecommended: string | null = null;
    for (const m of [r.memberships[WORKER_2]!, r.memberships[WORKER]!]) {
      if ((await eligibilityFor(r.itemId, m)) === null) { unrecommended = m; break; }
    }
    expect(unrecommended, "the resolver recommended everyone; nothing to override").not.toBeNull();

    const out = await assign(MANAGER, {
      itemId: r.itemId, membershipId: unrecommended!,
      condition: r.conditionDigest, eligibility: null,
      overrideReason: null, key: `nr-${r.itemId}`,
    });
    expect(out.refusal).toBe("override_reason_required");

    // With a reason, the same assignment is accepted and recorded AS an override.
    const withReason = await assign(MANAGER, {
      itemId: r.itemId, membershipId: unrecommended!,
      condition: r.conditionDigest, eligibility: null,
      overrideReason: "closer to the site than anyone the resolver ranked",
      key: `nr2-${r.itemId}`,
    });
    expect(withReason.ok, JSON.stringify(withReason)).toBe(true);
    expect(withReason.is_override).toBe(true);
    const history = await physical<{ is_override: boolean; override_reason: string }>(
      `select is_override, override_reason from management_item_assignments where item_id=$1`,
      [r.itemId]);
    expect(history[0]!.is_override).toBe(true);
    expect(history[0]!.override_reason).toMatch(/closer to the site/);
  }, 300_000);

  it("is idempotent for an exact retry, and refuses a conflicting one", async () => {
    const r = await readyForAssignment();
    const key = `retry-${r.itemId}`;
    const first = await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
      overrideReason: "first", key,
    });
    expect(first.result).toBe("assigned");

    const again = await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!, state: "assigned",
      condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
      overrideReason: "first", key,
    });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.result).toBe("duplicate");
    expect(again.assignment_id).toBe(first.assignment_id);

    const conflicting = await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER_2]!, state: "assigned",
      condition: r.conditionDigest,
      eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER_2]!),
      overrideReason: "different person, same submission", key,
    });
    expect(conflicting.refusal).toBe("conflicting_retry");

    const history = await physical(
      `select id from management_item_assignments where item_id=$1`, [r.itemId]);
    expect(history).toHaveLength(1);
  }, 300_000);

  it("serialises two managers assigning different people at the same moment", async () => {
    const r = await readyForAssignment();
    const other = new pg.Client({ connectionString: URL, ssl: false });
    await other.connect();
    try {
      const [a, b] = await Promise.allSettled([
        assign(MANAGER, {
          itemId: r.itemId, membershipId: r.memberships[WORKER]!,
          condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
          overrideReason: "manager one", key: `race-a-${r.itemId}`,
        }),
        assign(MANAGER_2, {
          itemId: r.itemId, membershipId: r.memberships[WORKER_2]!,
          condition: r.conditionDigest,
          eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER_2]!),
          overrideReason: "manager two", key: `race-b-${r.itemId}`,
        }, other),
      ]);
      const outcomes = [a, b].map((x) =>
        x.status === "fulfilled" ? (x.value.result ?? x.value.refusal) : "threw");
      // One assigns. The other finds the item already moved — never two people on one task.
      expect(outcomes.filter((o) => o === "assigned")).toHaveLength(1);
    } finally {
      await other.end();
    }

    const rows = await physical<{ assigned_to: string; owner: string }>(
      `select t.assigned_to, i.accountable_owner_id as owner
         from management_items i, tasks t where i.id=$1 and t.id=$2`, [r.itemId, r.taskId]);
    const owners = await physical<{ user_id: string }>(
      `select user_id from memberships where id=$1`, [rows[0]!.owner]);
    // Whoever won, the two records agree.
    expect(owners[0]!.user_id).toBe(rows[0]!.assigned_to);
  }, 300_000);

  it("refuses an item with no created effect — there is nothing to assign", async () => {
    // An item that reached `approved` and stopped, because execution is disabled for its company.
    // Deleting a ledger row would have been the shorter route and is correctly impossible: the
    // execution ledger refuses a delete, which is the property that makes it a ledger.
    const co = randomUUID();
    await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`,
      [co, `asg-ne ${co.slice(0, 8)}`]);
    const managerMembership = await seedPerson(MANAGER, co, "project_manager");
    const workerMembership = await seedPerson(WORKER, co, "staff_submitter");
    expect(managerMembership).toBeTruthy();
    await q(
      `insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
       values ($1,true,$2,now()) on conflict (company_id) do update set enabled = true`,
      [co, MANAGER]);
    await q(
      `insert into management_execution_enablement (company_id, enabled, enabled_by, enabled_at)
       values ($1,false,$2,now()) on conflict (company_id) do update set enabled = false`,
      [co, MANAGER]);
    const { rows: t } = await q(
      `insert into tasks (company_id, title, status, due_date, estimate_hours)
       values ($1,'no-effect condition','scheduled',null,null) returning id`, [co]);

    const cycle = () => runManagementCycle(deps, { companyId: co, actorId: MANAGER, trigger: "test" });
    await cycle();
    const { rows: items } = await q(
      `select id from management_items
        where company_id=$1 and subject_table='tasks' and subject_id=$2`, [co, t[0].id]);
    const itemId = String(items[0].id);
    for (let i = 0; i < 5; i++) {
      await cycle();
      const { rows } = await q(`select state from management_items where id=$1`, [itemId]);
      if (rows[0].state === "awaiting_approval") break;
    }
    const { rows: item } = await q(
      `select proposed_action_id from management_items where id=$1`, [itemId]);
    const { rows: dg } = await q(`select public.r1_draft_evidence_digest($1,$2) as d`, [co, itemId]);
    await asUser(MANAGER,
      `select public.r1_draft_record_management_decision($1,'approve','awaiting_approval',$2,$3,null,null,$4) as r`,
      [itemId, item[0].proposed_action_id, String(dg[0].d), `ne-${itemId}`]);
    for (let i = 0; i < 2; i++) await cycle();

    const { rows: st } = await q(`select state from management_items where id=$1`, [itemId]);
    expect(st[0].state).toBe("approved");
    const { rows: att } = await q(
      `select count(*)::int as n from management_execution_attempts
        where item_id=$1 and status='executed'`, [itemId]);
    expect(att[0].n).toBe(0);

    const out = await asUser(MANAGER,
      `select public.r1_draft_assign_management_item($1,$2,'approved',$3,null,$4,$5) as r`,
      [itemId, workerMembership, String(dg[0].d), "nothing there", `ne-a-${itemId}`],
    ).then((row) => row.r as Record<string, unknown>);
    expect(out.refusal).toBe("no_effect_to_assign");
  }, 300_000);

  it("the assignment record cannot be edited or deleted", async () => {
    const r = await readyForAssignment();
    await assign(MANAGER, {
      itemId: r.itemId, membershipId: r.memberships[WORKER]!,
      condition: r.conditionDigest, eligibility: await eligibilityFor(r.itemId, r.memberships[WORKER]!),
      overrideReason: "for the append-only check", key: `ao-${r.itemId}`,
    });
    // The trigger fires per ROW, so a statement matching nothing raises nothing. Proving the row
    // exists first is what makes the two refusals below mean something.
    expect(await physical(
      `select id from management_item_assignments where item_id=$1`, [r.itemId])).toHaveLength(1);
    await expect(physical(
      `update management_item_assignments set override_reason='rewritten' where item_id=$1`,
      [r.itemId])).rejects.toThrow(/append-only/);
    await expect(physical(
      `delete from management_item_assignments where item_id=$1`, [r.itemId]))
      .rejects.toThrow(/append-only/);
  }, 300_000);
});
