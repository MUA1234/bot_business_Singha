/**
 * R2F-F-019 — the PostgREST execution transport, through the composition production builds.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────────────────────
 *
 * `executeManagementAction` reached its ledger and its four loaders through `SqlExec`, a raw SQL
 * executor. The request path speaks PostgREST, which cannot run SQL text, so `makeCycleDeps`
 * supplied no transport at all: the orchestrator recorded an "execution transport unavailable"
 * hold and marked every cycle partial. The loop's one authorised effect was unreachable from the
 * deployed graph — an implementation that existed and could not be called.
 *
 * ── Why this suite passes NO `executionSql` ──────────────────────────────────────────────────
 *
 * `r2-lifecycle-orchestrator.test.ts` injects one, and says so. That injection is exactly what
 * this suite must not do: a test that hands the runtime the dependency the runtime was missing
 * cannot detect that it was missing. Every graph below is `makeCycleDeps(pgSupabase(raw), …)`
 * with the fourth argument omitted — the shape a server process builds — so everything that
 * happens here happens over named RPCs, and nothing anywhere accepts SQL text.
 *
 * The one substitution is the HTTP transport: `pgSupabase` is this repository's established way
 * of running production modules against a real database, and its `.rpc()` resolves named
 * arguments from the function's own signature exactly as PostgREST does. So an argument-name
 * mismatch between `postgrest-transport.ts` and `R1_DRAFT_029` fails here, which is one of the
 * things it is for.
 *
 * ── Parity ───────────────────────────────────────────────────────────────────────────────────
 *
 * The second block drives the SAME scenario through both transports and compares what the
 * database holds afterwards, field by field. Parity asserted on outcomes is worth something;
 * parity asserted on prose is not.
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

let raw: pg.Client;
/** The DEPLOYED shape: PostgREST only, no local token. */
let deployed: CycleDeps;
/** The deployed shape plus the deterministic-local-test token. Still PostgREST only. */
let rpcGraph: CycleDeps;
/** The SQL transport, for the parity comparison and for nothing else. */
let sqlGraph: CycleDeps;
let savedKernel: string | undefined;
let savedExec: string | undefined;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

/** Set the SERVER-side global boundary row. */
async function setServerBoundary(on: boolean): Promise<void> {
  await q(`update r1_exec_global_boundary set enabled = $1, updated_at = now() where id = true`, [on]);
}

async function seedPerson(user: string, company: string, roleKey: string): Promise<string> {
  await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [user]);
  await q(
    `insert into users (id, full_name, is_active) values ($1,'rpc person',true)
       on conflict (id) do nothing`, [user]);
  await q(
    `insert into profiles (id, company_id, username, full_name, department, is_active)
     values ($1,$2,$3,'rpc person','operations',true) on conflict (id) do nothing`,
    [user, company, `rpc-${user.slice(0, 8)}`]);
  const { rows } = await q(
    `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
       on conflict (company_id, user_id) do update set status='active' returning id`,
    [company, user]);
  await q(
    `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)
       on conflict do nothing`, [rows[0].id, company, roleKey]);
  return String(rows[0].id);
}

interface Fixture { co: string; taskId: string }

async function fixture(opts: { execution?: boolean } = {}): Promise<Fixture> {
  const co = randomUUID();
  await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`,
    [co, `rpc ${co.slice(0, 8)}`]);
  await seedPerson(MANAGER, co, "project_manager");
  await q(
    `insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
     values ($1,true,$2,now()) on conflict (company_id) do update set enabled = true`, [co, MANAGER]);
  await q(
    `insert into management_execution_enablement (company_id, enabled, enabled_by, enabled_at)
     values ($1,$2,$3,now()) on conflict (company_id) do update set enabled = excluded.enabled`,
    [co, opts.execution !== false, MANAGER]);
  const { rows } = await q(
    `insert into tasks (company_id, title, status, due_date, estimate_hours)
     values ($1,'rpc transport condition','scheduled',null,null) returning id`, [co]);
  return { co, taskId: String(rows[0].id) };
}

const cycle = (co: string, graph: CycleDeps): Promise<CycleSummary> =>
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

async function approveAsManager(co: string, itemId: string) {
  const { rows: item } = await q(
    `select proposed_action_id from management_items where id=$1`, [itemId]);
  const { rows: dg } = await q(`select public.r1_draft_evidence_digest($1,$2) as d`, [co, itemId]);
  await q("begin");
  try {
    await q("set local role authenticated");
    await q(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: MANAGER }),
    ]);
    const { rows } = await q(
      `select public.r1_draft_record_management_decision($1,'approve','awaiting_approval',$2,$3,null,null,$4) as r`,
      [itemId, item[0].proposed_action_id, String(dg[0].d), `rpc-${itemId}`],
    );
    await q("commit");
    const r = rows[0].r as { ok?: boolean };
    if (r?.ok !== true) throw new Error(`approval refused: ${JSON.stringify(r)}`);
  } catch (e) {
    await q("rollback");
    throw e;
  }
}

/** Run cycles until the item stops moving. Mirrors the orchestrator suite's settle. */
async function settle(co: string, itemId: string, graph: CycleDeps, max = 10): Promise<string[]> {
  const seen: string[] = [await stateOf(itemId)];
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

/** Carry a fresh item all the way to `approved`, ready to be executed. */
async function approvedItem(graph: CycleDeps, opts: { execution?: boolean } = {}) {
  const f = await fixture(opts);
  await cycle(f.co, graph);
  const itemId = await itemFor(f.co, f.taskId);
  await settle(f.co, itemId, graph);
  await approveAsManager(f.co, itemId);
  expect(await stateOf(itemId)).toBe("approved");
  return { ...f, itemId };
}

/** Every ledger row for an item, with RLS out of the way — "is it there", not "can I see it". */
async function attemptsFor(itemId: string): Promise<Record<string, unknown>[]> {
  await q("begin");
  try {
    await q("set local role postgres");
    const { rows } = await q(
      `select status, refusal_reason, handler, resolved_authority, approved_by, effect_ref,
              action_id, idempotency_key, detail
         from management_execution_attempts where item_id=$1 order by created_at, id`, [itemId]);
    return rows as Record<string, unknown>[];
  } finally {
    await q("commit");
  }
}

/** Tasks the EXECUTOR created, never the condition row the fixture seeded. */
async function tasksFor(co: string): Promise<Record<string, unknown>[]> {
  const { rows } = await q(
    `select id, title, status, assigned_to, requires_evidence, created_by
       from tasks where company_id=$1 and title <> 'rpc transport condition'
       order by created_at`, [co]);
  return rows as Record<string, unknown>[];
}

beforeAll(async () => {
  if (!enabled) return;
  savedKernel = process.env.MANAGEMENT_KERNEL;
  savedExec = process.env.EXECUTION_ENABLED;
  process.env.MANAGEMENT_KERNEL = "on";
  // The global VARIABLE stays off for the whole suite. Everything that executes below does so on
  // the deterministic local token, which no environment can supply.
  delete process.env.EXECUTION_ENABLED;

  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();
  await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);

  const execSql: SqlExec = async (text, params) => {
    const r = await raw.query(text, params as unknown[]);
    return { rows: r.rows as Record<string, unknown>[] };
  };

  // NO fourth argument. This is the shape a server process builds.
  deployed = makeCycleDeps(pgSupabase(raw), () => new Date());
  rpcGraph = makeCycleDeps(pgSupabase(raw), () => new Date(), undefined, undefined, LOCAL_EXECUTION_TOKEN);
  sqlGraph = makeCycleDeps(pgSupabase(raw), () => new Date(), undefined, execSql, LOCAL_EXECUTION_TOKEN);
}, 180_000);

afterAll(async () => {
  if (!enabled) return;
  if (savedKernel === undefined) delete process.env.MANAGEMENT_KERNEL;
  else process.env.MANAGEMENT_KERNEL = savedKernel;
  if (savedExec === undefined) delete process.env.EXECUTION_ENABLED;
  else process.env.EXECUTION_ENABLED = savedExec;
  // Leave the server-side boundary as this suite found it: shut.
  try { await setServerBoundary(false); } catch { /* the connection may already be gone */ }
  await raw?.end();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. The blocker itself
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("R2F-F-019 — the deployed graph can reach the executor", () => {
  it("no longer holds an approved item for a missing transport", async () => {
    await setServerBoundary(true);
    const f = await approvedItem(rpcGraph);
    const summary = await cycle(f.co, rpcGraph);

    // The old behaviour, named exactly, so a regression is unmistakable.
    const note = summary.lifecycle.notes.find((n) => n.itemId === f.itemId);
    expect(JSON.stringify(note ?? {})).not.toMatch(/transport unavailable/i);

    // The effect is produced in the cycle that finds the item approved; the item moves to
    // `needs_routing` in the next one, which is the orchestrator's existing shape and not
    // something this transport changes.
    expect(await settle(f.co, f.itemId, rpcGraph)).toEqual(["approved", "needs_routing"]);
  }, 240_000);

  it("produces exactly one unassigned task and one terminal ledger row", async () => {
    await setServerBoundary(true);
    const f = await approvedItem(rpcGraph);
    await settle(f.co, f.itemId, rpcGraph);

    const attempts = await attemptsFor(f.itemId);
    expect(attempts.map((a) => a.status)).toEqual(["executed"]);
    const ledger = attempts[0]!;
    expect(ledger.handler).toBe("ops.task.create_internal.v1");
    expect(ledger.resolved_authority).toBe("automatic");

    const tasks = await tasksFor(f.co);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.id).toBe(ledger.effect_ref);
    // The executor may create work. It may not give it to anyone.
    expect(task.assigned_to).toBeNull();
    expect(task.status).toBe("captured");
  }, 240_000);

  it("runs the automatic action ONCE however many cycles pass", async () => {
    await setServerBoundary(true);
    const f = await approvedItem(rpcGraph);
    for (let i = 0; i < 6; i++) await cycle(f.co, rpcGraph);

    const executed = (await attemptsFor(f.itemId)).filter((a) => a.status === "executed");
    expect(executed).toHaveLength(1);
    expect(await tasksFor(f.co)).toHaveLength(1);
  }, 240_000);

  it("still refuses at the global boundary when nothing authorises execution", async () => {
    await setServerBoundary(true);
    const f = await approvedItem(deployed);
    const summary = await cycle(f.co, deployed);

    expect(await stateOf(f.itemId)).toBe("approved");
    expect(summary.lifecycle.notes.find((n) => n.itemId === f.itemId)?.reason)
      .toBe("global_boundary_disabled");
    expect(await tasksFor(f.co)).toHaveLength(0);
  }, 240_000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. Parity with the SQL transport
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!enabled)("the two transports are the same system", () => {
  it("write the same ledger row and the same task for the same scenario", async () => {
    await setServerBoundary(true);
    const viaSql = await approvedItem(sqlGraph);
    await settle(viaSql.co, viaSql.itemId, sqlGraph);
    const viaRpc = await approvedItem(rpcGraph);
    await settle(viaRpc.co, viaRpc.itemId, rpcGraph);

    const a = await attemptsFor(viaSql.itemId);
    const b = await attemptsFor(viaRpc.itemId);

    // Every field that is not an identity or a timestamp, compared directly.
    const shape = (r: Record<string, unknown>) => ({
      status: r.status,
      refusal_reason: r.refusal_reason,
      handler: r.handler,
      resolved_authority: r.resolved_authority,
      action_id: r.action_id,
      approvedByIsTheApprover: r.approved_by === MANAGER,
    });
    expect(a.map(shape)).toEqual(b.map(shape));

    const tSql = await tasksFor(viaSql.co);
    const tRpc = await tasksFor(viaRpc.co);
    const taskShape = (t: Record<string, unknown>) => ({
      title: t.title, status: t.status, assigned_to: t.assigned_to,
      requires_evidence: t.requires_evidence, createdByIsTheApprover: t.created_by === MANAGER,
    });
    expect(tSql.map(taskShape)).toEqual(tRpc.map(taskShape));
  }, 300_000);

  it("both leave an unapproved item alone, and produce nothing", async () => {
    await setServerBoundary(true);
    for (const graph of [sqlGraph, rpcGraph]) {
      const f = await fixture();
      await cycle(f.co, graph);
      const itemId = await itemFor(f.co, f.taskId);
      await settle(f.co, itemId, graph);
      expect(await stateOf(itemId)).toBe("awaiting_approval");
      expect((await attemptsFor(itemId)).filter((r) => r.status === "executed")).toHaveLength(0);
      expect(await tasksFor(f.co)).toHaveLength(0);
    }
  }, 300_000);

  it("both refuse identically when the company is not enabled for execution", async () => {
    await setServerBoundary(true);
    const reasons: string[] = [];
    for (const graph of [sqlGraph, rpcGraph]) {
      const f = await approvedItem(graph, { execution: false });
      const summary = await cycle(f.co, graph);
      reasons.push(String(summary.lifecycle.notes.find((n) => n.itemId === f.itemId)?.reason ?? ""));
      expect(await tasksFor(f.co)).toHaveLength(0);
    }
    expect(reasons[0]).toBe("company_not_enabled");
    expect(reasons[1]).toBe(reasons[0]);
  }, 300_000);
});
