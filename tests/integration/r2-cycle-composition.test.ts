/**
 * The COMPOSITION edge: does the dependency graph the runtime actually builds verify anything?
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────────
 *
 * `runVerificationSweep` was proven correct by twenty live tests. It was also never called: the
 * cycle asked for `deps.verificationSweep` only if it was present, and `makeCycleDeps` — the one
 * factory the request path and the worker use — did not provide it. So the deployed system verified
 * nothing, and said so with a summary of zeroes that is indistinguishable from a company with
 * nothing pending.
 *
 * A test that calls the sweep directly cannot detect that, because it constructs the dependency the
 * runtime is missing. Every test below therefore builds the graph the SAME way the runtime does —
 * `makeCycleDeps(client)`, no injection, no override — and drives `runManagementCycle`. The only
 * substitution is the HTTP transport (`pgSupabase`), which is this repository's established way of
 * running production modules against a real database without a Supabase server.
 *
 * Synthetic data, disposable local PostgreSQL, no network, no model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { createSqlVerificationStore } from "@/kernel/verification/store-sql";
import { createSupabaseVerificationStore } from "@/kernel/verification/store-supabase";
import { runVerificationSweep } from "@/kernel/verification/schedule";
import type { VerificationStore } from "@/kernel/verification/store";
import { pgSupabase } from "./helpers/pg-supabase";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
const MANAGER = randomUUID();

let raw: pg.Client;
let deps: CycleDeps;
const membership = new Map<string, string>();
let savedFlag: string | undefined;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

async function enable(companyId: string, on = true) {
  await q(
    `insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
     values ($1,$2,$3,now())
     on conflict (company_id) do update set enabled = excluded.enabled`,
    [companyId, on, MANAGER],
  );
}

async function seedTask(companyId: string, status = "completed"): Promise<string> {
  const { rows } = await q(
    `insert into tasks (company_id, title, status, due_date, requires_evidence)
     values ($1,'composition subject',$2,'2020-01-01'::date,false) returning id`,
    [companyId, status],
  );
  return String(rows[0].id);
}

/**
 * An item awaiting verification, with a completion already claimed an hour ago.
 *
 * The claim itself is proven by `r2-completion-claim.test.ts` against the real RPC. What is under
 * test HERE is whether the runtime's own dependency graph reaches verification at all, so the
 * claim is seeded rather than re-proved.
 */
async function seedPending(companyId: string, taskId: string): Promise<string> {
  const itemId = randomUUID();
  await q(
    `insert into management_items
       (id, company_id, department, kind, subject_table, subject_id, identity_key, state,
        accountable_owner_id)
     values ($1,$2,'operations','overdue_task','tasks',$3,$4,'verifying',$5)`,
    [itemId, companyId, taskId, `${companyId}:comp:${itemId}`, membership.get(`${companyId}`)!],
  );
  await q(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id)
     values ($1,$2,'tasks',$3)`,
    [companyId, itemId, taskId],
  );
  await q(
    `insert into management_item_transitions
       (company_id, item_id, from_state, to_state, actor_id, actor_type, reason, created_at)
     values ($1,$2,'monitoring','verifying',$3,'user','claimed complete', now() - interval '1 hour')`,
    [companyId, itemId, MANAGER],
  );
  return itemId;
}

const stateOf = async (itemId: string): Promise<string> => {
  const { rows } = await q(`select state from management_items where id = $1`, [itemId]);
  return String(rows[0]?.state);
};

const cycle = (companyId: string, d: CycleDeps = deps) =>
  runManagementCycle(d, { companyId, actorId: MANAGER, trigger: "test" });

beforeAll(async () => {
  if (!enabled) return;
  savedFlag = process.env.MANAGEMENT_KERNEL;
  process.env.MANAGEMENT_KERNEL = "on";

  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();
  // The atomic create RPC is a service-only boundary; in production the service-role key sets
  // this claim, and the harness sets it explicitly for the same effect.
  await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);

  for (const co of [CO_A, CO_B]) {
    await q(
      `insert into companies (id,name,base_currency) values ($1,$2,'LKR') on conflict do nothing`,
      [co, `comp ${co.slice(0, 8)}`],
    );
  }
  await q(
    `insert into users (id, full_name, is_active) values ($1,'composition manager',true)
       on conflict (id) do nothing`,
    [MANAGER],
  );
  for (const co of [CO_A, CO_B]) {
    const { rows } = await q(
      `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`,
      [co, MANAGER],
    );
    membership.set(co, String(rows[0].id));
  }

  // THE REAL GRAPH. No verification dependency is injected: whatever the runtime gets, this gets.
  deps = makeCycleDeps(pgSupabase(raw));
}, 180_000);

afterAll(async () => {
  if (!enabled) return;
  if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
  else process.env.MANAGEMENT_KERNEL = savedFlag;
  await raw?.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("the runtime's own dependency graph", () => {
  it("supplies verification — the factory, not the test, constructs it", () => {
    // Not a style assertion. The dependency being optional, and this factory not providing it, is
    // the exact defect: `runManagementCycle` skipped verification entirely and nothing failed.
    expect(typeof deps.verificationSweep).toBe("function");
  });

  it("verifies a resolved item through the composition, over the Supabase transport", async () => {
    await enable(CO_A, true);
    const taskId = await seedTask(CO_A, "completed");
    const itemId = await seedPending(CO_A, taskId);

    const summary = await cycle(CO_A);

    // The cycle has to have finished looking before anything may be concluded.
    expect(summary.status, JSON.stringify(summary.verification)).toBe("completed");
    expect(summary.verification.transport).toBe("supabase");
    expect(summary.verification.considered).toBeGreaterThanOrEqual(1);
    expect(summary.verification.verified).toBe(1);
    expect(summary.verification.unavailableReason).toBeNull();

    expect(await stateOf(itemId)).toBe("verified");

    // The attempt was recorded through the same transport, not just decided in memory.
    const { rows } = await q(
      `select outcome, actor_type, generation from management_verification_attempts
        where item_id = $1`,
      [itemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("verified_resolved");
    // A scheduled sweep is the SYSTEM's act. Recorded as a person's it would become evidence
    // about whoever was accountable.
    expect(rows[0].actor_type).toBe("system");
    expect(String(rows[0].generation)).toMatch(/^cycle:/);

    // And the lifecycle transition carries the same truth.
    const { rows: t } = await q(
      `select actor_id, actor_type from management_item_transitions
        where item_id = $1 and to_state = 'verified'`,
      [itemId],
    );
    expect(t).toHaveLength(1);
    expect(t[0].actor_type).toBe("system");
    expect(t[0].actor_id).toBeNull();
  }, 120_000);

  it("reopens a persisting condition rather than closing it", async () => {
    await enable(CO_A, true);
    // The task is still open and overdue: the same detector that raised the item raises it again.
    const taskId = await seedTask(CO_A, "in_progress");
    const itemId = await seedPending(CO_A, taskId);

    const summary = await cycle(CO_A);
    expect(summary.verification.persists).toBe(1);
    expect(summary.verification.verified).toBe(0);
    expect(await stateOf(itemId)).toBe("reopened");
  }, 120_000);

  it("a DISABLED company verifies nothing and writes nothing", async () => {
    await enable(CO_B, false);
    const taskId = await seedTask(CO_B, "completed");
    const itemId = await seedPending(CO_B, taskId);

    const summary = await cycle(CO_B);
    expect(summary.status).toBe("skipped_disabled");
    // Zero, and zero of everything: no attempt, no schedule row, no state change.
    expect(summary.verification.attempted).toBe(0);
    expect(await stateOf(itemId)).toBe("verifying");
    const { rows } = await q(
      `select (select count(*)::int from management_verification_attempts where item_id = $1) as a,
              (select count(*)::int from management_verification_schedule where item_id = $1) as s`,
      [itemId],
    );
    expect(rows[0].a).toBe(0);
    expect(rows[0].s).toBe(0);
  }, 120_000);

  it("never reads across companies: another company's pending item is untouched", async () => {
    await enable(CO_A, true);
    await enable(CO_B, false);
    const foreignItem = await seedPending(CO_B, await seedTask(CO_B, "completed"));

    await cycle(CO_A);
    expect(await stateOf(foreignItem)).toBe("verifying");
  }, 120_000);

  it("a transport that cannot reach the schema says SO, and the cycle is partial", async () => {
    await enable(CO_A, true);
    const broken: VerificationStore = {
      transport: "supabase",
      async listPending() { throw new Error("relation \"management_verification_schedule\" does not exist"); },
      async loadItem() { throw new Error("unreachable"); },
      async readTask() { return { ok: false, reason: "unreachable" }; },
      async evidenceGeneration() { throw new Error("unreachable"); },
      async transition() { throw new Error("unreachable"); },
      async recordAttempt() { throw new Error("unreachable"); },
    };
    // Still the real factory and the real cycle — only the transport is broken.
    const summary = await cycle(CO_A, makeCycleDeps(pgSupabase(raw), () => new Date(), broken));

    expect(summary.verification.unavailableReason).toMatch(/does not exist/);
    expect(summary.verification.partial).toBe(true);
    expect(summary.verification.considered).toBe(0);
    // The distinction that matters: unknown verification work is not a completed cycle.
    expect(summary.status).toBe("partial");
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("the two transports are transports, not two implementations", () => {
  it("reach identical conclusions on identical fixtures", async () => {
    await enable(CO_A, true);
    const sqlStore = createSqlVerificationStore(async (text, params) => {
      const r = await raw.query(text, params as unknown[]);
      return { rows: r.rows as Record<string, unknown>[] };
    });
    const restStore = createSupabaseVerificationStore(pgSupabase(raw));

    const sweep = {
      complete: true,
      generation: "parity",
      interrupted: false,
      observedAt: new Date(Date.now() + 60_000),
    };

    const outcomes: string[] = [];
    for (const store of [sqlStore, restStore]) {
      // A fresh company each time, so neither run can see the other's work.
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, `par ${co.slice(0, 8)}`]);
      const { rows } = await q(
        `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`,
        [co, MANAGER],
      );
      membership.set(co, String(rows[0].id));

      const resolved = await seedPending(co, await seedTask(co, "completed"));
      const persisting = await seedPending(co, await seedTask(co, "in_progress"));

      const s = await runVerificationSweep({ store, now: () => new Date() },
        { companyId: co, sweep, cycleComplete: true });

      outcomes.push(
        [store.transport, s.attempted, s.verified, s.persists, s.remaining,
         await stateOf(resolved), await stateOf(persisting)].slice(1).join("|"),
      );
    }

    // Identical, field for field. An adapter that decided anything for itself would show here —
    // and deciding anything is precisely what an adapter must not do.
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes[0]).toBe("2|1|1|0|verified|reopened");
  }, 120_000);
});
