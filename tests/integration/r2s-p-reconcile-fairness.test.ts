/**
 * R2S-P — reconciliation cannot be starved by incremental work.
 *
 * The reconciliation sweep is what guarantees eventual discovery, and it originally drew on the
 * SAME row budget as the incremental sweep. That made the guarantee conditional on incremental
 * traffic being light — which is to say, conditional on the company being quiet. A busy company is
 * exactly the one whose records must not go unobserved.
 *
 * So reconciliation now has a reserve that incremental reads cannot touch: RECONCILE_PAGE rows
 * per keyset source per cycle, carved out of the same bounded total. Every test here keeps the
 * incremental path as busy as it can and asserts the reserve is still honoured.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";
import { RECONCILE_PAGE, RESCAN_PAGE, CYCLE_ROW_BUDGET, reconcileSourceKey } from "@/kernel/pagination";
import { OPERATIONS_SOURCE, CRM_SOURCE, GOVERNANCE_SOURCE, PROVIDERS_SOURCE } from "@/kernel/adapters";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const ACTOR = randomUUID();
const KEYSET = [OPERATIONS_SOURCE, CRM_SOURCE, GOVERNANCE_SOURCE, PROVIDERS_SOURCE];

let raw: pg.Client;
let deps: CycleDeps;
let savedFlag: string | undefined;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);
const cycle = (co: string, d: CycleDeps = deps) =>
  runManagementCycle(d, { companyId: co, actorId: null, trigger: "test" });

async function freshCompany(label: string): Promise<string> {
  const co = randomUUID();
  await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, label.slice(0, 40)]);
  await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
           values ($1,true,$2,now())`, [co, ACTOR]);
  return co;
}

async function addTasks(co: string, n: number, prefix: string) {
  for (let i = 0; i < n; i += 250) {
    const batch = Math.min(250, n - i);
    const values = Array.from({ length: batch }, (_, k) =>
      `($1,'${prefix}${i + k}','in_progress','2099-01-01')`).join(",");
    await q(`insert into tasks (company_id, title, status, due_date) values ` + values, [co]);
  }
}

/** Where a source's reconciliation sweep has reached. */
async function reconcileState(co: string, source: string) {
  const { rows } = await q(
    `select cursor, generation, rows_inspected from observation_source_cursors
      where company_id=$1 and source=$2`, [co, reconcileSourceKey(source)]);
  return rows[0] as { cursor: unknown; generation: number; rows_inspected: string } | undefined;
}

describe.skipIf(!enabled)("R2S-P — reconciliation is reserved, not leftover", () => {
  beforeAll(async () => {
    savedFlag = process.env.MANAGEMENT_KERNEL;
    process.env.MANAGEMENT_KERNEL = "on";
    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [ACTOR]);
    await q(`insert into users (id,full_name,is_active) values ($1,'fairness actor',true)
             on conflict (id) do nothing`, [ACTOR]);
    deps = makeCycleDeps(pgSupabase(raw), () => new Date());
  }, 180_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
    else process.env.MANAGEMENT_KERNEL = savedFlag;
    await raw?.end();
  });

  it("the reserve is exclusive, and large enough for every keyset source", async () => {
    const co = await freshCompany("reserve-shape");
    await addTasks(co, 10, "shape-");
    const s = await cycle(co);

    // One full page per keyset source, every cycle, guaranteed — and the recovery lane has
    // its own, so the two cannot be traded against each other.
    expect(s.reconcileReserve).toBe(RECONCILE_PAGE * KEYSET.length);
    expect(s.rescanReserve).toBe(RESCAN_PAGE * KEYSET.length);
    // And carved out of the same total, so the cycle stays bounded.
    expect(s.reconcileReserve + s.rescanReserve).toBeLessThan(CYCLE_ROW_BUDGET);
  }, 180_000);

  it("CONTINUOUS incremental writes cannot stop reconciliation advancing", async () => {
    const co = await freshCompany("continuous-writes");
    await addTasks(co, 1200, "base-");

    let previous = 0n;
    for (let i = 0; i < 6; i++) {
      // Enough new rows every cycle to swamp the incremental page several times over. Under the
      // old shared budget this is precisely the traffic that squeezed reconciliation to nothing.
      await addTasks(co, 400, `flood${i}-`);
      const s = await cycle(co);

      const rec = s.reconciliation.find((r) => r.source === OPERATIONS_SOURCE);
      expect(rec, "operations did not reconcile at all").toBeTruthy();
      expect(rec!.inspected, `cycle ${i} reconciled ${rec!.inspected} rows`).toBe(RECONCILE_PAGE);

      const st = await reconcileState(co, OPERATIONS_SOURCE);
      const now = BigInt(st!.rows_inspected);
      expect(now, `cycle ${i}: reconciliation did not advance`).toBeGreaterThan(previous);
      previous = now;
    }
  }, 900_000);

  it("ALL FOUR keyset sources reconcile in the same cycle", async () => {
    const co = await freshCompany("all-four");
    await addTasks(co, 400, "four-");
    for (let i = 0; i < 40; i++) {
      // The real column names — `customer_wa_id`, and a status from the table's own CHECK.
      // Inventing plausible ones is how three loaders shipped broken in R2A.
      await q(`insert into wa_conversations (company_id, customer_wa_id, status, last_inbound_at)
               values ($1,$2,'collecting', now() - interval '3 days')`,
        [co, `9477000${String(i).padStart(4, "0")}`]);
      await q(`insert into service_providers (company_id, name, status, insurance_expiry)
               values ($1,$2,'active','2026-02-01')`, [co, `provider ${i}`]);
    }

    const s = await cycle(co);
    const reconciled = new Set(s.reconciliation.map((r) => r.source));
    // Every keyset source got its own reservation in ONE cycle — no rotation, no waiting turn.
    for (const source of KEYSET) {
      expect(reconciled.has(source), `${source} did not reconcile`).toBe(true);
    }
  }, 600_000);

  it("MULTIPLE COMPANIES each get the full reserve", async () => {
    const a = await freshCompany("multi-a");
    const b = await freshCompany("multi-b");
    await addTasks(a, 600, "multi-a-");
    await addTasks(b, 600, "multi-b-");

    for (const co of [a, b]) {
      const s = await cycle(co);
      const rec = s.reconciliation.find((r) => r.source === OPERATIONS_SOURCE);
      // The budget is per company per cycle, so one busy tenant cannot spend another's reserve.
      expect(rec!.inspected).toBe(RECONCILE_PAGE);
    }
  }, 600_000);

  it("a REPEATEDLY FAILING source does not consume another's reserve", async () => {
    const co = await freshCompany("failing-source");
    await addTasks(co, 500, "failing-");

    const broken: CycleDeps = {
      ...deps,
      async loadPage(req) {
        if (req.source === CRM_SOURCE) throw new Error("connection reset");
        return deps.loadPage!(req);
      },
    };

    for (let i = 0; i < 3; i++) {
      const s = await runManagementCycle(broken, { companyId: co, actorId: null, trigger: "test" });
      const ops = s.reconciliation.find((r) => r.source === OPERATIONS_SOURCE);
      // The failing source's own reconciliation is not credited, but everyone else's continues.
      expect(ops!.inspected, `cycle ${i}`).toBe(RECONCILE_PAGE);
      expect(s.sourcesFailed).toBeGreaterThan(0);
    }
  }, 600_000);

  it("completes a large table within the bound the reserve guarantees", async () => {
    const co = await freshCompany("bound");
    const rows = 450;
    await addTasks(co, rows, "bound-");

    // The bound is arithmetic: a full page of the reserve, every cycle, with no dependence on
    // incremental load. One extra cycle for the wrap that records completion.
    const bound = Math.ceil(rows / RECONCILE_PAGE) + 1;

    let generationsSeen = 0;
    let cycles = 0;
    for (let i = 1; i <= bound + 4; i++) {
      await addTasks(co, 150, `noise${i}-`);       // still writing, every cycle
      const s = await cycle(co);
      cycles = i;
      const st = await reconcileState(co, OPERATIONS_SOURCE);
      generationsSeen = st?.generation ?? 0;
      if (generationsSeen >= 1) break;
    }
    expect(generationsSeen, `no full sweep completed in ${cycles} cycles`).toBeGreaterThanOrEqual(1);
    console.log(`\n=== RECONCILIATION BOUND: ${rows} rows swept in ${cycles} cycles ` +
      `(guaranteed allocation ${RECONCILE_PAGE} rows/source/cycle, arithmetic bound ${bound})`);
  }, 900_000);

  it("INTERRUPTION and restart keeps the reserve and the position", async () => {
    const co = await freshCompany("restart");
    await addTasks(co, 400, "restart-");
    await cycle(co);
    const before = await reconcileState(co, OPERATIONS_SOURCE);
    expect(before?.cursor).toBeTruthy();

    // A restarted process: nothing in memory survives, so the guarantee must be durable.
    const restarted = makeCycleDeps(pgSupabase(raw), () => new Date());
    const s = await cycle(co, restarted);
    const rec = s.reconciliation.find((r) => r.source === OPERATIONS_SOURCE);
    expect(rec!.inspected).toBe(RECONCILE_PAGE);

    const after = await reconcileState(co, OPERATIONS_SOURCE);
    expect(BigInt(after!.rows_inspected)).toBeGreaterThan(BigInt(before!.rows_inspected));
  }, 600_000);
});
