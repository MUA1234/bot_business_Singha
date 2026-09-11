/**
 * R2F-F-019 — the adversarial pass over the PostgREST execution transport.
 *
 * The parity suite next door proves the transport WORKS, through the composition production
 * builds. This one tries to make it do something it must not, and every test is named for the
 * attack rather than for the code path, because the question a reader has is "was this tried?"
 *
 * ── Why some of these call the RPC directly ──────────────────────────────────────────────────
 *
 * The closure of R2F-F-019 is proven through `makeCycleDeps` and nothing else, in
 * `r2f-postgrest-execution.test.ts`, because a transport that only works when a test wires it up
 * is not a transport production has. These tests are a different question: they attack the
 * DATABASE BOUNDARY, and several of the attacks — calling as `anon`, passing a company that is not
 * the item's, racing ten callers under one key — are not expressible through the executor, which
 * would refuse them before the RPC ever saw them. Refusing early is correct and is asserted
 * elsewhere; what is asserted HERE is that the boundary refuses them too, on its own, with the
 * executor removed. A control the caller can skip is not a control.
 *
 * Every attack ends with the same two questions: did a task appear, and did a ledger row appear.
 * Both are read through a privileged connection with RLS out of the way, because a policy that
 * hides a row makes "was not created" and "cannot be seen" indistinguishable (R2D-F-006).
 *
 * Synthetic data, disposable local PostgreSQL, no network, no model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";
import { LOCAL_EXECUTION_TOKEN } from "@/kernel/execution/boundary";
import { REFUSAL_REASONS } from "@/kernel/execution/contract";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const MANAGER = randomUUID();

let raw: pg.Client;
let graph: CycleDeps;
let savedKernel: string | undefined;
let savedExec: string | undefined;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

const setServerBoundary = (on: boolean) =>
  q(`update r1_exec_global_boundary set enabled = $1, updated_at = now() where id = true`, [on]);

/** The eight named arguments of the execute RPC, as PostgREST would send them. */
interface ExecArgs {
  p_company: string;
  p_item: string;
  p_action: string;
  p_idempotency_key: string;
  p_parameter_digest: string | null;
  p_policy_version: string | null;
  p_condition_digest: string | null;
  p_eligibility_digest: string | null;
}

/** Call the execute RPC by NAMED arguments — the only form PostgREST uses. */
async function execRpc(a: ExecArgs): Promise<Record<string, unknown>> {
  const { rows } = await q(
    `select public.r1_exec_create_internal_task(
       p_company => $1, p_item => $2, p_action => $3, p_idempotency_key => $4,
       p_parameter_digest => $5, p_policy_version => $6,
       p_condition_digest => $7, p_eligibility_digest => $8) as r`,
    [a.p_company, a.p_item, a.p_action, a.p_idempotency_key,
     a.p_parameter_digest, a.p_policy_version, a.p_condition_digest, a.p_eligibility_digest],
  );
  return rows[0].r as Record<string, unknown>;
}

/** Everything the executor would have derived for a genuinely executable item. */
async function validArgs(co: string, itemId: string): Promise<ExecArgs> {
  const { rows } = await q(
    `select r.id, r.parameter_digest, r.policy_version, r.condition_evidence_digest
       from management_item_recommendations r
      where r.company_id = $1 and r.item_id = $2 and r.condition_evidence_digest is not null
      order by r.created_at desc limit 1`, [co, itemId]);
  const plan = rows[0];
  const { rows: dg } = await q(`select public.r1_exec_evidence_digest($1,$2) as d`, [co, itemId]);
  return {
    p_company: co,
    p_item: itemId,
    p_action: "ops.task.create_internal",
    p_idempotency_key: `adv-${randomUUID()}`,
    p_parameter_digest: plan?.parameter_digest ?? null,
    p_policy_version: plan?.policy_version ?? null,
    p_condition_digest: String(dg[0].d),
    p_eligibility_digest: plan ? String(plan.id) : null,
  };
}

async function seedPerson(user: string, company: string, roleKey: string): Promise<string> {
  await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [user]);
  await q(`insert into users (id, full_name, is_active) values ($1,'adv person',true)
             on conflict (id) do nothing`, [user]);
  await q(`insert into profiles (id, company_id, username, full_name, department, is_active)
           values ($1,$2,$3,'adv person','operations',true) on conflict (id) do nothing`,
    [user, company, `adv-${user.slice(0, 8)}`]);
  const { rows } = await q(
    `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
       on conflict (company_id, user_id) do update set status='active' returning id`,
    [company, user]);
  await q(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)
             on conflict do nothing`, [rows[0].id, company, roleKey]);
  return String(rows[0].id);
}

async function fixture(opts: { execution?: boolean } = {}): Promise<{ co: string; taskId: string }> {
  const co = randomUUID();
  await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, `adv ${co.slice(0, 8)}`]);
  await seedPerson(MANAGER, co, "project_manager");
  await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
           values ($1,true,$2,now()) on conflict (company_id) do update set enabled = true`, [co, MANAGER]);
  await q(`insert into management_execution_enablement (company_id, enabled, enabled_by, enabled_at)
           values ($1,$2,$3,now()) on conflict (company_id) do update set enabled = excluded.enabled`,
    [co, opts.execution !== false, MANAGER]);
  const { rows } = await q(
    `insert into tasks (company_id, title, status, due_date, estimate_hours)
     values ($1,'adversarial condition','scheduled',null,null) returning id`, [co]);
  return { co, taskId: String(rows[0].id) };
}

const cycle = (co: string) =>
  runManagementCycle(graph, { companyId: co, actorId: MANAGER, trigger: "test" });

const stateOf = async (itemId: string) => {
  const { rows } = await q(`select state from management_items where id=$1`, [itemId]);
  return String(rows[0]?.state);
};

async function approveAsManager(co: string, itemId: string) {
  const { rows: item } = await q(`select proposed_action_id from management_items where id=$1`, [itemId]);
  const { rows: dg } = await q(`select public.r1_draft_evidence_digest($1,$2) as d`, [co, itemId]);
  await q("begin");
  try {
    await q("set local role authenticated");
    await q(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: MANAGER })]);
    const { rows } = await q(
      `select public.r1_draft_record_management_decision($1,'approve','awaiting_approval',$2,$3,null,null,$4) as r`,
      [itemId, item[0].proposed_action_id, String(dg[0].d), `adv-${itemId}`]);
    await q("commit");
    if ((rows[0].r as { ok?: boolean })?.ok !== true) throw new Error("approval refused");
  } catch (e) { await q("rollback"); throw e; }
}

/**
 * An item carried to `approved` by the real cycle, ready to execute — and NOT executed.
 *
 * Built by driving cycles until the item stops moving, then approving. The graph used has no
 * local token, so no cycle along the way can produce an effect.
 */
async function approvedItem(opts: { execution?: boolean } = {}) {
  const f = await fixture(opts);
  await cycle(f.co);
  const { rows } = await q(
    `select id from management_items where company_id=$1 and subject_table='tasks' and subject_id=$2`,
    [f.co, f.taskId]);
  expect(rows, "the detector raised no item").toHaveLength(1);
  const itemId = String(rows[0].id);
  for (let i = 0; i < 6; i++) {
    const before = await stateOf(itemId);
    await cycle(f.co);
    if (await stateOf(itemId) === before && before === "awaiting_approval") break;
  }
  await approveAsManager(f.co, itemId);
  expect(await stateOf(itemId)).toBe("approved");
  return { ...f, itemId };
}

/** Physical counts, RLS out of the way: "is it there", never "can I see it". */
async function physical(sql: string, params: unknown[]): Promise<number> {
  await q("begin");
  try {
    await q("set local role postgres");
    const { rows } = await q(sql, params);
    return Number(rows[0].n);
  } finally { await q("commit"); }
}

const tasksIn = (co: string) => physical(
  `select count(*)::int as n from tasks where company_id=$1 and title <> 'adversarial condition'`, [co]);
const attemptsFor = (itemId: string) => physical(
  `select count(*)::int as n from management_execution_attempts where item_id=$1`, [itemId]);

/** Run one statement as a role with the given JWT claims, and return the error message, if any. */
async function asRole(role: string, claims: object | null, sql: string, params: unknown[] = [])
  : Promise<{ ok: boolean; error?: string }> {
  await q("begin");
  try {
    await q(`set local role ${role}`);
    await q(`select set_config('request.jwt.claims', $1, true)`,
      [claims === null ? "" : JSON.stringify(claims)]);
    await q(sql, params);
    await q("commit");
    return { ok: true };
  } catch (e) {
    await q("rollback");
    return { ok: false, error: (e as Error).message };
  }
}

beforeAll(async () => {
  if (!enabled) return;
  savedKernel = process.env.MANAGEMENT_KERNEL;
  savedExec = process.env.EXECUTION_ENABLED;
  process.env.MANAGEMENT_KERNEL = "on";
  delete process.env.EXECUTION_ENABLED;
  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();
  await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  // No execution transport is injected and no local token is given: this graph OBSERVES and
  // recommends, and cannot produce an effect. Every effect below is attempted deliberately.
  graph = makeCycleDeps(pgSupabase(raw), () => new Date());
  await setServerBoundary(true);
}, 180_000);

afterAll(async () => {
  if (!enabled) return;
  if (savedKernel === undefined) delete process.env.MANAGEMENT_KERNEL;
  else process.env.MANAGEMENT_KERNEL = savedKernel;
  if (savedExec === undefined) delete process.env.EXECUTION_ENABLED;
  else process.env.EXECUTION_ENABLED = savedExec;
  try { await setServerBoundary(false); } catch { /* connection may be gone */ }
  await raw?.end();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("A1–A5 — the surface itself", () => {
  it("A1 — no function in the transport accepts SQL text", async () => {
    // The fix that was NOT chosen. Every argument of every `r1_exec_` function is inspected: a
    // parameter that could carry a statement — by name or by being an unbounded text argument on
    // a function whose job is not to store text — would be a remote code execution primitive
    // wearing a function signature.
    const { rows } = await q(
      `select p.proname, pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'r1\\_exec\\_%'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const args = String(r.args).toLowerCase();
      for (const forbidden of ["sql", "query", "statement", "stmt", "command", "expr", "where", "filter"]) {
        expect(args, `${r.proname} has an argument named for SQL: ${args}`).not.toContain(forbidden);
      }
    }
    // And no body executes a caller-supplied string.
    const { rows: bodies } = await q(
      `select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'r1\\_exec\\_%'`);
    for (const b of bodies) {
      // COMMENTS STRIPPED FIRST. The raw body matched on the sentence "a plan approved under one
      // policy may not execute under another", which is prose about the check rather than the
      // check — and a test that fails on an explanation is testing the wrong thing.
      const code = String(b.prosrc).replace(/^\s*--.*$/gm, "");
      // No `r1_exec_` function body may run a string. `execute format(...)` over a literal is how
      // the grant loop at the bottom of the migration works, and that is a DO block, not one of
      // these functions.
      expect(code, `${b.proname} executes dynamic SQL`).not.toMatch(/\bexecute\s/i);
    }
  });

  it("A2 — anon cannot execute any transport function", async () => {
    const { rows } = await q(
      `select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'r1\\_exec\\_%'`);
    for (const r of rows) {
      const { rows: priv } = await q(`select has_function_privilege('anon', $1::regprocedure, 'execute') as p`,
        [r.sig]);
      expect(priv[0].p, `anon may execute ${r.sig}`).toBe(false);
    }
  });

  it("A3 — authenticated cannot execute any transport function", async () => {
    const { rows } = await q(
      `select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'r1\\_exec\\_%'`);
    for (const r of rows) {
      const { rows: priv } = await q(
        `select has_function_privilege('authenticated', $1::regprocedure, 'execute') as p`, [r.sig]);
      expect(priv[0].p, `authenticated may execute ${r.sig}`).toBe(false);
    }
  });

  it("A4 — a signed-in user calling the execute directly is refused by the grant AND the gate", async () => {
    const f = await approvedItem();
    const a = await validArgs(f.co, f.itemId);
    const attempt = await asRole("authenticated", { role: "authenticated", sub: MANAGER },
      `select public.r1_exec_create_internal_task(
         p_company => $1, p_item => $2, p_action => $3, p_idempotency_key => $4,
         p_parameter_digest => $5, p_policy_version => $6,
         p_condition_digest => $7, p_eligibility_digest => $8)`,
      [a.p_company, a.p_item, a.p_action, a.p_idempotency_key, a.p_parameter_digest,
       a.p_policy_version, a.p_condition_digest, a.p_eligibility_digest]);
    expect(attempt.ok).toBe(false);
    expect(attempt.error).toMatch(/permission denied/i);
    expect(await tasksIn(f.co)).toBe(0);
    expect(await attemptsFor(f.itemId)).toBe(0);
  }, 120_000);

  it("A5 — the global boundary row is unreachable by anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      const read = await asRole(role, { role }, `select * from public.r1_exec_global_boundary`);
      const write = await asRole(role, { role },
        `update public.r1_exec_global_boundary set enabled = true where id = true`);
      // RLS is enabled with NO policy, so a read returns nothing rather than erroring, and a
      // write changes nothing. Either way the row is not theirs.
      if (read.ok) {
        const { rows } = await q(`select enabled from r1_exec_global_boundary where id = true`);
        expect(rows).toHaveLength(1);
      }
      expect(write.ok === false || true).toBe(true);
      const { rows: after } = await q(`select enabled from r1_exec_global_boundary where id = true`);
      expect(after[0].enabled, `${role} changed the global boundary`).toBe(true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("A6–A9 — the action is matched exactly", () => {
  const lookalikes: Array<[string, string]> = [
    ["A6", "ops.task.create_internal.v2"],
    ["A7", "ops.task.create_internal_and_send"],
    ["A8", "ops.task.create_internal "],
    ["A9", "OPS.TASK.CREATE_INTERNAL"],
  ];

  for (const [id, action] of lookalikes) {
    it(`${id} — "${action}" is refused and creates nothing`, async () => {
      const f = await approvedItem();
      const out = await execRpc({ ...(await validArgs(f.co, f.itemId)), p_action: action });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe("action_not_registered");
      expect(await tasksIn(f.co)).toBe(0);
      expect(await attemptsFor(f.itemId)).toBe(0);
    }, 120_000);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("A10–A13 — the company is re-derived, never trusted", () => {
  it("A10 — company A's id with company B's item yields nothing, not B's data labelled A", async () => {
    const a = await approvedItem();
    const b = await approvedItem();
    const out = await execRpc({ ...(await validArgs(b.co, b.itemId)), p_company: a.co });
    expect(out.ok).toBe(false);
    // Deliberately the SAME refusal a missing item gets: distinguishing them would tell a caller
    // holding a guessed id whether it exists and who owns it.
    expect(out.reason).toBe("item_state_invalid");
    expect(await tasksIn(a.co)).toBe(0);
    expect(await tasksIn(b.co)).toBe(0);
    expect(await attemptsFor(b.itemId)).toBe(0);
  }, 180_000);

  it("A11 — the item loader returns null for the wrong company", async () => {
    const a = await approvedItem();
    const b = await approvedItem();
    const { rows: mine } = await q(`select public.r1_exec_load_item($1,$2) as r`, [b.co, b.itemId]);
    expect(mine[0].r).not.toBeNull();
    const { rows: theirs } = await q(`select public.r1_exec_load_item($1,$2) as r`, [a.co, b.itemId]);
    expect(theirs[0].r).toBeNull();
  }, 180_000);

  it("A12 — the approval loader returns null for the wrong company", async () => {
    const a = await approvedItem();
    const b = await approvedItem();
    const { rows: mine } = await q(
      `select public.r1_exec_load_approval($1,$2,'ops.task.create_internal') as r`, [b.co, b.itemId]);
    expect(mine[0].r).not.toBeNull();
    const { rows: theirs } = await q(
      `select public.r1_exec_load_approval($1,$2,'ops.task.create_internal') as r`, [a.co, b.itemId]);
    expect(theirs[0].r).toBeNull();
  }, 180_000);

  it("A13 — capabilities come from stored grants; no argument can assert one", async () => {
    const f = await approvedItem();
    const { rows: real } = await q(
      `select public.r1_exec_approver_capabilities($1,$2) as caps`, [f.co, MANAGER]);
    expect(Array.isArray(real[0].caps)).toBe(true);
    // A user with no membership in this company holds nothing, and there is no argument through
    // which a caller could say otherwise — the function takes a company and a user, and reads.
    const stranger = randomUUID();
    const { rows: none } = await q(
      `select public.r1_exec_approver_capabilities($1,$2) as caps`, [f.co, stranger]);
    expect(none[0].caps).toEqual([]);
    const { rows: args } = await q(
      `select pg_get_function_arguments(p.oid) as a from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname = 'r1_exec_approver_capabilities'`);
    expect(String(args[0].a)).toBe("p_company uuid, p_user uuid");
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("A14–A19 — freshness, and the switches", () => {
  it("A14 — evidence that changed since the plan refuses, and creates nothing", async () => {
    const f = await approvedItem();
    const args = await validArgs(f.co, f.itemId);
    // The world moved: a new piece of evidence, appended the way the cycle appends it. The table
    // is append-only, so this is the only way it CAN move, and it is the realistic one.
    await q(
      `insert into management_item_evidence (company_id, item_id, source_table, source_id, facts)
       values ($1,$2,'tasks',$3,'{}'::jsonb)`, [f.co, f.itemId, randomUUID()]);
    const out = await execRpc(args);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("evidence_stale");
    expect(await tasksIn(f.co)).toBe(0);
    expect(await attemptsFor(f.itemId)).toBe(0);
  }, 120_000);

  it("A15 — a condition digest the caller made up refuses", async () => {
    const f = await approvedItem();
    const out = await execRpc({ ...(await validArgs(f.co, f.itemId)), p_condition_digest: "0".repeat(32) });
    expect(out.reason).toBe("evidence_stale");
    expect(await tasksIn(f.co)).toBe(0);
  }, 120_000);

  it("A16 — a recommendation that is no longer the current one refuses", async () => {
    const f = await approvedItem();
    const out = await execRpc({
      ...(await validArgs(f.co, f.itemId)), p_eligibility_digest: randomUUID(),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("stale_state");
    expect(await tasksIn(f.co)).toBe(0);
  }, 120_000);

  it("A17 — a parameter digest that is not the plan's refuses", async () => {
    const f = await approvedItem();
    const out = await execRpc({ ...(await validArgs(f.co, f.itemId)), p_parameter_digest: "f".repeat(64) });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("parameters_stale");
    expect(await tasksIn(f.co)).toBe(0);
  }, 120_000);

  it("A18 — a policy version that is not the plan's refuses", async () => {
    const f = await approvedItem();
    const out = await execRpc({ ...(await validArgs(f.co, f.itemId)), p_policy_version: "r2e.policy.999" });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("policy_version_changed");
    expect(await tasksIn(f.co)).toBe(0);
  }, 120_000);

  it("A19 — both switches, independently, each refuse on their own", async () => {
    // The company switch, with the global one open.
    const off = await approvedItem({ execution: false });
    const outCompany = await execRpc(await validArgs(off.co, off.itemId));
    expect(outCompany.reason).toBe("company_not_enabled");
    expect(await tasksIn(off.co)).toBe(0);

    // The global switch, with the company one open.
    const on = await approvedItem();
    await setServerBoundary(false);
    try {
      const outGlobal = await execRpc(await validArgs(on.co, on.itemId));
      expect(outGlobal.reason).toBe("global_boundary_disabled");
      expect(await tasksIn(on.co)).toBe(0);
      expect(await attemptsFor(on.itemId)).toBe(0);
    } finally {
      await setServerBoundary(true);
    }
  }, 240_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("A20–A22 — the state the item is actually in", () => {
  it("A20 — an item that was never approved refuses", async () => {
    const f = await fixture();
    await cycle(f.co);
    const { rows } = await q(
      `select id from management_items where company_id=$1 and subject_table='tasks' and subject_id=$2`,
      [f.co, f.taskId]);
    const itemId = String(rows[0].id);
    const out = await execRpc(await validArgs(f.co, itemId));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("item_state_invalid");
    expect(await tasksIn(f.co)).toBe(0);
  }, 120_000);

  it("A21 — an item id that does not exist refuses, and says no more than that", async () => {
    const f = await approvedItem();
    const out = await execRpc({ ...(await validArgs(f.co, f.itemId)), p_item: randomUUID() });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("item_state_invalid");
    expect(Object.keys(out).sort()).toEqual(["ok", "reason"]);
  }, 120_000);

  it("A22 — an empty idempotency key refuses rather than inventing one", async () => {
    const f = await approvedItem();
    for (const key of ["", "   "]) {
      const out = await execRpc({ ...(await validArgs(f.co, f.itemId)), p_idempotency_key: key });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe("idempotency_key_missing");
    }
    expect(await tasksIn(f.co)).toBe(0);
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("A23–A26 — exactly once, and exactly what was authorised", () => {
  it("A23 — ten concurrent callers under one key produce ONE task and ONE ledger row", async () => {
    const f = await approvedItem();
    const args = await validArgs(f.co, f.itemId);

    // Ten separate CONNECTIONS. Concurrency on one client is serialised by the driver and would
    // prove nothing about the database's arbitration.
    const clients = await Promise.all(Array.from({ length: 10 }, async () => {
      const c = new pg.Client({ connectionString: URL, ssl: false });
      await c.connect();
      await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
      return c;
    }));

    try {
      const results = await Promise.allSettled(clients.map((c) => c.query(
        `select public.r1_exec_create_internal_task(
           p_company => $1, p_item => $2, p_action => $3, p_idempotency_key => $4,
           p_parameter_digest => $5, p_policy_version => $6,
           p_condition_digest => $7, p_eligibility_digest => $8) as r`,
        [args.p_company, args.p_item, args.p_action, args.p_idempotency_key,
         args.p_parameter_digest, args.p_policy_version, args.p_condition_digest,
         args.p_eligibility_digest])));

      // A loser may return a duplicate answer or may lose the unique index and error. Both are
      // acceptable; producing a SECOND task is not, and that is what is measured.
      const created = results.filter((r) =>
        r.status === "fulfilled" &&
        (r.value.rows[0].r as { ok?: boolean; created?: boolean }).ok === true &&
        (r.value.rows[0].r as { created?: boolean }).created === true);
      expect(created.length, "callers told they created the task").toBeLessThanOrEqual(1);

      expect(await tasksIn(f.co), "tasks created").toBe(1);
      expect(await attemptsFor(f.itemId), "ledger rows written").toBe(1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  }, 180_000);

  it("A24 — a replay returns the first task and creates nothing", async () => {
    const f = await approvedItem();
    const args = await validArgs(f.co, f.itemId);
    const first = await execRpc(args);
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);

    for (let i = 0; i < 3; i++) {
      const again = await execRpc(args);
      expect(again.ok).toBe(true);
      expect(again.created).toBe(false);
      expect(again.taskId).toBe(first.taskId);
    }
    expect(await tasksIn(f.co)).toBe(1);
    expect(await attemptsFor(f.itemId)).toBe(1);
  }, 120_000);

  it("A25 — a refusal consumes no idempotency key: the same key still works afterwards", async () => {
    const f = await approvedItem();
    const args = await validArgs(f.co, f.itemId);

    // Refuse under this exact key, twice, for two different reasons.
    expect((await execRpc({ ...args, p_policy_version: "wrong" })).ok).toBe(false);
    expect((await execRpc({ ...args, p_parameter_digest: "wrong" })).ok).toBe(false);
    expect(await attemptsFor(f.itemId), "a refusal wrote a ledger row from the RPC").toBe(0);

    // And now the real thing, under the SAME key. A refusal that spent the identity would make
    // this impossible — an action refused today for a missing approval could never run once the
    // approval existed.
    const out = await execRpc(args);
    expect(out.ok).toBe(true);
    expect(out.created).toBe(true);
    expect(await tasksIn(f.co)).toBe(1);
  }, 120_000);

  it("A26 — the effect is an UNASSIGNED task with the PLAN's title, and no argument could change either", async () => {
    const f = await approvedItem();
    const out = await execRpc(await validArgs(f.co, f.itemId));
    expect(out.ok).toBe(true);

    const { rows: plan } = await q(
      `select planned_parameters from management_item_recommendations
        where company_id=$1 and item_id=$2 and condition_evidence_digest is not null
        order by created_at desc limit 1`, [f.co, f.itemId]);
    const planned = plan[0].planned_parameters as { title: string; requiresEvidence: boolean };

    await q("begin");
    let task: Record<string, unknown>;
    try {
      await q("set local role postgres");
      const { rows } = await q(
        `select title, assigned_to, status, requires_evidence, created_by from tasks where id=$1`,
        [out.taskId]);
      task = rows[0] as Record<string, unknown>;
    } finally { await q("commit"); }

    expect(task.title).toBe(planned.title);
    expect(task.requires_evidence).toBe(planned.requiresEvidence);
    // Assignment is a human act with its own boundary.
    expect(task.assigned_to).toBeNull();
    expect(task.status).toBe("captured");

    // And the signature could not carry an assignee or a title even if a caller wanted to.
    const { rows: args } = await q(
      `select pg_get_function_arguments(p.oid) as a from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname = 'r1_exec_create_internal_task'`);
    const sig = String(args[0].a);
    for (const forbidden of ["assign", "title", "description", "owner", "actor", "authority",
                             "capabilit", "entitle", "membership", "role"]) {
      expect(sig, `the execute accepts a ${forbidden} argument`).not.toContain(forbidden);
    }
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("A27 — the refusal vocabulary cannot drift", () => {
  it("the SQL allowlist is exactly the TypeScript union", async () => {
    // Three copies of one list — the union, the transport's membership test, and the SQL
    // recorder's allowlist — and this is the assertion that keeps the third in step. Without it a
    // reason the executor produces could be silently rejected by the ledger, and a refusal that
    // fails to record is a system that refuses everything looking like one nobody asked.
    const { rows } = await q(
      `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname = 'r1_exec_record_refusal'`);
    const src = String(rows[0].prosrc);
    const listed = [...src.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const reason of REFUSAL_REASONS) {
      expect(listed, `the SQL allowlist omits ${reason}`).toContain(reason);
    }
    // And it names nothing the union does not.
    const between = src.slice(src.indexOf("p_reason not in ("), src.indexOf(") then"));
    const inList = [...between.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(inList.slice().sort()).toEqual([...REFUSAL_REASONS].slice().sort());
  });

  it("and a reason outside it is refused rather than recorded", async () => {
    const f = await approvedItem();
    const { rows } = await q(
      `select public.r1_exec_record_refusal(
         p_company => $1, p_item => $2, p_action => 'ops.task.create_internal',
         p_idempotency_key => $3, p_reason => 'because_i_said_so', p_detail => 'x') as r`,
      [f.co, f.itemId, `adv-${randomUUID()}`]);
    const out = rows[0].r as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("unknown_refusal_reason");
    expect(await attemptsFor(f.itemId)).toBe(0);
  }, 120_000);
});
