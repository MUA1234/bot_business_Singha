/**
 * The two evidence contracts, kept apart (R2F-F-017).
 *
 * ── What went wrong, and why no test saw it ──────────────────────────────────────────────────
 *
 * The executor compared the item's CONDITION evidence — the business facts that raised it —
 * against the recommendation snapshot's CANDIDATE-ELIGIBILITY evidence — the facts that make a
 * person a plausible assignee. Two different record sets about two different subjects, compared
 * for equality. They cannot match, so no item the real cycle created could ever execute an
 * automatic action.
 *
 * The R2E suite passed throughout, because its fixture wrote the snapshot's `evidence_refs` with
 * the item's evidence pairs — a shape the runtime never produces. A test that constructs the thing
 * the runtime is missing cannot notice that it is missing.
 *
 * So every item here is created by the REAL cycle, through the real dependency graph, and nothing
 * below manufactures a snapshot. The first test asserts the two digests are genuinely DIFFERENT,
 * because a "fix" that made them equal would satisfy the executor and destroy the distinction.
 *
 * Synthetic data, disposable local PostgreSQL, no network, no model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { executeManagementAction } from "@/kernel/execution/service";
import { LOCAL_EXECUTION_TOKEN } from "@/kernel/execution/boundary";
import { EXECUTION_POLICY_VERSION } from "@/kernel/execution/policy";
import type { SqlExec } from "@/kernel/execution/ledger";
import { pgSupabase } from "./helpers/pg-supabase";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const MANAGER = randomUUID();

let raw: pg.Client;
let deps: CycleDeps;
let savedFlag: string | undefined;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);
const sql: SqlExec = async (text, params) => {
  const r = await raw.query(text, params as unknown[]);
  return { rows: r.rows as Record<string, unknown>[] };
};

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
  async audit() { /* asserted elsewhere; not the subject here */ },
  localToken: LOCAL_EXECUTION_TOKEN,
});

/** A company with the kernel and execution enabled, and one unestimated task to be observed. */
async function freshCompanyWithCondition(): Promise<{ co: string; taskId: string }> {
  const co = randomUUID();
  await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`,
    [co, `ec ${co.slice(0, 8)}`]);
  await q(
    `insert into users (id, full_name, is_active) values ($1,'contract manager',true)
       on conflict (id) do nothing`, [MANAGER]);
  await q(
    `insert into memberships (company_id,user_id,status) values ($1,$2,'active')
       on conflict (company_id, user_id) do nothing`, [co, MANAGER]);
  for (const t of ["management_kernel_enablement", "management_execution_enablement"]) {
    await q(
      `insert into ${t} (company_id, enabled, enabled_by, enabled_at) values ($1,true,$2,now())
         on conflict (company_id) do update set enabled = true`,
      [co, MANAGER],
    );
  }
  // A SCHEDULED task with no estimate raises exactly `missing_estimate`, which the catalogue maps
  // to the one locally-executable action.
  const { rows } = await q(
    `insert into tasks (company_id, title, status, due_date, estimate_hours)
     values ($1,'contract condition','scheduled',null,null) returning id`,
    [co],
  );
  return { co, taskId: String(rows[0].id) };
}

/** Run the real cycle and return the item it filed for this task, with its recorded plan. */
async function observe(co: string, taskId: string) {
  const summary = await runManagementCycle(deps, { companyId: co, actorId: MANAGER, trigger: "test" });
  expect(summary.itemsCreated).toBeGreaterThan(0);
  const { rows } = await q(
    `select i.id, i.proposed_action_id,
            r.condition_evidence_digest, r.eligibility_evidence_digest, r.action_id,
            r.planned_parameters, r.parameter_digest, r.policy_version, r.evidence_refs
       from management_items i
       join management_item_recommendations r on r.item_id = i.id
      where i.company_id = $1 and i.subject_table = 'tasks' and i.subject_id = $2
      order by r.created_at desc limit 1`,
    [co, taskId],
  );
  expect(rows, "the real cycle recorded no recommendation for this item").toHaveLength(1);
  return rows[0];
}

/**
 * Advance a freshly observed item to a state that admits execution.
 *
 * R2F-F-014: nothing in the application performs these hops, so the test performs them through the
 * database boundary — where the transition map, the evidence requirement and the append-only
 * history all still apply. Batch 2 replaces this with the real orchestrator; until it does, an item
 * created by the cycle sits in `observed`, which is the finding itself.
 */
async function advanceToApproved(itemId: string) {
  for (const [from, to] of [
    ["observed", "understood"], ["understood", "prioritised"],
    ["prioritised", "recommended"], ["recommended", "awaiting_approval"],
    ["awaiting_approval", "approved"],
  ] as const) {
    const { rows } = await q(
      `select public.r1_draft_transition_item($1,$2,$3,null,'system',$4,'[]'::jsonb) as r`,
      [itemId, from, to, "R2F-F-014: no runtime writer exists yet"],
    );
    const r = rows[0].r as { ok?: boolean };
    if (r?.ok !== true) throw new Error(`transition ${from}->${to} refused: ${JSON.stringify(r)}`);
  }
}

const run = (co: string, itemId: string, parameters: Record<string, unknown>) =>
  executeManagementAction(execEnv(), {
    companyId: co, itemId, actionId: "ops.task.create_internal", parameters,
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

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("the two sets are different, and both are recorded", () => {
  it("the real cycle records a condition digest and an eligibility digest that DIFFER", async () => {
    const { co, taskId } = await freshCompanyWithCondition();
    const rec = await observe(co, taskId);

    expect(String(rec.condition_evidence_digest)).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.eligibility_evidence_digest).not.toBeNull();
    // The heart of it. If these were ever made equal the executor would be satisfied and the
    // distinction would be gone.
    expect(rec.condition_evidence_digest).not.toBe(rec.eligibility_evidence_digest);

    // And they are digests OF DIFFERENT THINGS, not two hashes of the same rows.
    const { rows: conditionRows } = await q(
      `select source_table from management_item_evidence where item_id = $1`, [rec.id]);
    expect(conditionRows.map((r) => r.source_table)).toContain("tasks");
    const refs = (rec.evidence_refs ?? []) as Array<Record<string, string>>;
    for (const ref of refs) {
      expect(ref.sourceTable ?? ref.source_table).not.toBe("tasks");
    }
  }, 120_000);

  it("the condition digest the cycle stored equals what the canonical function says now", async () => {
    const { co, taskId } = await freshCompanyWithCondition();
    const rec = await observe(co, taskId);
    const { rows } = await q(
      `select public.r1_draft_evidence_digest($1,$2) as d`, [co, rec.id]);
    // Derived server-side, in the transaction that wrote the evidence, and still true afterwards.
    expect(rec.condition_evidence_digest).toBe(rows[0].d);
  }, 120_000);

  it("records the action, the plan and the policy version the advice was given under", async () => {
    const { co, taskId } = await freshCompanyWithCondition();
    const rec = await observe(co, taskId);
    expect(rec.action_id).toBe("ops.task.create_internal");
    expect(rec.policy_version).toBe(EXECUTION_POLICY_VERSION);
    expect(rec.planned_parameters).not.toBeNull();
    expect(String(rec.parameter_digest)).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("execution freshness, each set against its own kind", () => {
  it("a REAL cycle-created item reaches the automatic executor and runs once", async () => {
    const { co, taskId } = await freshCompanyWithCondition();
    const rec = await observe(co, taskId);
    await advanceToApproved(String(rec.id));

    const out = await run(co, String(rec.id), rec.planned_parameters as Record<string, unknown>);
    expect(out.status, JSON.stringify(out)).toBe("executed");

    const { rows } = await q(
      `select status from management_execution_attempts where item_id = $1`, [rec.id]);
    expect(rows.map((r) => r.status)).toEqual(["executed"]);
  }, 120_000);

  it("refuses when the CONDITION evidence changed", async () => {
    const { co, taskId } = await freshCompanyWithCondition();
    const rec = await observe(co, taskId);
    await advanceToApproved(String(rec.id));
    // The world moved: new evidence attached to the same item.
    await q(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id)
       values ($1,$2,'tasks',$3)`,
      [co, rec.id, `later-${randomUUID()}`],
    );

    const out = await run(co, String(rec.id), rec.planned_parameters as Record<string, unknown>);
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.reason).toBe("evidence_stale");
  }, 120_000);

  it("refuses when the PARAMETERS differ from the plan", async () => {
    const { co, taskId } = await freshCompanyWithCondition();
    const rec = await observe(co, taskId);
    await advanceToApproved(String(rec.id));

    const out = await run(co, String(rec.id), { title: "something else entirely" });
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.reason).toBe("parameters_stale");
    // Nothing was created on the strength of a request nobody recommended.
    const { rows } = await q(`select id from tasks where company_id = $1 and title = $2`,
      [co, "something else entirely"]);
    expect(rows).toHaveLength(0);
  }, 120_000);

  it("refuses when the recorded POLICY VERSION is not the current one", async () => {
    const { co, taskId } = await freshCompanyWithCondition();
    const rec = await observe(co, taskId);
    await advanceToApproved(String(rec.id));
    // Simulates the rules moving after the advice was recorded. Done at the database because a
    // policy bump is a code change; the effect on a stored recommendation is what matters here.
    await q(
      `update management_item_recommendations set policy_version = 'r2e.policy.0' where item_id = $1`,
      [rec.id],
    ).catch(async () => {
      // The table is append-only, correctly. Record a NEWER snapshot instead — which is what a
      // real re-recommendation under changed rules would do.
      await q(
        `insert into management_item_recommendations
           (company_id, item_id, purpose, outcome, routing_department, routing_reason_code,
            resolver_version, signal_rule_version, fingerprint, evidence_refs,
            condition_evidence_digest, eligibility_evidence_digest, action_id,
            planned_parameters, parameter_digest, policy_version)
         values ($1,$2,'assignee','needs_routing','operations','policy_changed',
                 'ec','ec',$3,'[]'::jsonb,$4,'empty','ops.task.create_internal',$5::jsonb,$6,
                 'r2e.policy.0')`,
        [co, rec.id, `fp-${randomUUID()}`, rec.condition_evidence_digest,
         JSON.stringify(rec.planned_parameters), rec.parameter_digest],
      );
    });

    const out = await run(co, String(rec.id), rec.planned_parameters as Record<string, unknown>);
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.reason).toBe("policy_version_changed");
  }, 120_000);

  it("a change to CANDIDATE eligibility does not stop the unassigned task being created", async () => {
    const { co, taskId } = await freshCompanyWithCondition();
    const rec = await observe(co, taskId);
    await advanceToApproved(String(rec.id));

    // The candidate's world moves — a role revoked, leave approved. The owner's rule is explicit:
    // that must block binding ASSIGNMENT, and must not block creating the task.
    await q(
      `insert into management_item_recommendations
         (company_id, item_id, purpose, outcome, routing_department, routing_reason_code,
          resolver_version, signal_rule_version, fingerprint, evidence_refs,
          condition_evidence_digest, eligibility_evidence_digest, action_id,
          planned_parameters, parameter_digest, policy_version)
       values ($1,$2,'assignee','needs_routing','operations','candidate_unavailable',
               'ec','ec',$3,'[]'::jsonb,$4,'a-different-eligibility','ops.task.create_internal',
               $5::jsonb,$6,$7)`,
      [co, rec.id, `fp-${randomUUID()}`, rec.condition_evidence_digest,
       JSON.stringify(rec.planned_parameters), rec.parameter_digest, EXECUTION_POLICY_VERSION],
    );

    const out = await run(co, String(rec.id), rec.planned_parameters as Record<string, unknown>);
    expect(out.status, JSON.stringify(out)).toBe("executed");
    // And the task it created is UNASSIGNED — eligibility was never consulted, so nobody was named.
    const effect = out.status === "executed" ? out.effectRef : "";
    const { rows } = await q(`select assigned_to from tasks where id = $1`, [effect]);
    expect(rows[0].assigned_to).toBeNull();
  }, 120_000);
});
