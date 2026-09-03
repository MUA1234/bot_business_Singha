/**
 * R2S-P cursor handoff — proving discovery does NOT rest on the overlap window.
 *
 * The incremental keyset cursor only moves forward through `updated_at`. Every scenario here puts
 * a row somewhere that cursor can never look again — behind it in time, or written with a
 * historical timestamp, or committed by a clock that disagrees — and then asserts the row is
 * still observed. The mechanism that has to do that work is the periodic reconciliation sweep,
 * which pages by primary key and restarts, so no timestamp can hide a row from it.
 *
 * The overlap constants are deliberately NOT relied on. Where a test needs the incremental path to
 * be unable to help, it puts the row far outside the window on purpose.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 * Run via scripts/r1/run-r1-security-tests.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";
import { RECONCILE_PAGE, reconcileSourceKey, OVERLAP_MS } from "@/kernel/pagination";
import { OPERATIONS_SOURCE } from "@/kernel/adapters";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const ACTOR = randomUUID();

let raw: pg.Client;
let deps: CycleDeps;
let savedFlag: string | undefined;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

/** A fresh company, so each scenario starts from a clean sweep with no shared cursor. */
async function freshCompany(label: string): Promise<string> {
  const co = randomUUID();
  await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, label.slice(0, 40)]);
  await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
           values ($1,true,$2,now())`, [co, ACTOR]);
  return co;
}

const cycle = (co: string) =>
  runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });

/** Cycles until nothing reports more work, returning how many it took. */
async function sweepUntilQuiet(co: string, maxCycles = 40) {
  for (let i = 1; i <= maxCycles; i++) {
    const s = await cycle(co);
    if (!s.continuation.some((c) => c.hasMore) && !s.reconciliation.some((r) => r.hasMore)) {
      return { cycles: i, summary: s };
    }
  }
  return { cycles: maxCycles, summary: await cycle(co) };
}

/**
 * Remove this company's items.
 *
 * Items CANNOT be cleared: `management_item_transitions` is append-only and refuses DELETE,
 * and evidence is held by ON DELETE RESTRICT. Both are deliberate — an item's history is not
 * disposable — so a test that wants a company with no items must use a NEW company rather
 * than dismantling one, which is also closer to what production ever does.
 */
async function clearItems(_co: string) {
  throw new Error("management items are append-only; use a fresh company instead");
}
void clearItems;

/** Is this task observed as a management item? */
async function observed(co: string, taskId: string): Promise<boolean> {
  const { rows } = await q(
    `select 1 from management_items where company_id=$1 and subject_id=$2 limit 1`, [co, taskId]);
  return rows.length > 0;
}

async function seedTasks(co: string, n: number, prefix: string, opts: { due?: string; updatedAt?: string } = {}) {
  const due = opts.due ?? "2099-01-01";
  for (let i = 0; i < n; i += 250) {
    const batch = Math.min(250, n - i);
    const values = Array.from({ length: batch }, (_, k) =>
      opts.updatedAt
        ? `($1,'${prefix}${i + k}','in_progress','${due}',$2)`
        : `($1,'${prefix}${i + k}','in_progress','${due}')`).join(",");
    const cols = opts.updatedAt
      ? "(company_id, title, status, due_date, updated_at)"
      : "(company_id, title, status, due_date)";
    await q(`insert into tasks ${cols} values ` + values,
      opts.updatedAt ? [co, opts.updatedAt] : [co]);
  }
}

/** One overdue task, inserted with an explicit updated_at. Returns its id. */
async function seedOne(co: string, title: string, updatedAt: string): Promise<string> {
  const { rows } = await q(
    `insert into tasks (company_id, title, status, due_date, updated_at)
     values ($1,$2,'in_progress','2026-01-01',$3) returning id`, [co, title, updatedAt]);
  return rows[0].id as string;
}

describe.skipIf(!enabled)("R2S-P cursor handoff — discovery beyond the overlap", () => {
  beforeAll(async () => {
    savedFlag = process.env.MANAGEMENT_KERNEL;
    process.env.MANAGEMENT_KERNEL = "on";
    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [ACTOR]);
    await q(`insert into users (id,full_name,is_active) values ($1,'handoff actor',true)
             on conflict (id) do nothing`, [ACTOR]);
    deps = makeCycleDeps(pgSupabase(raw), () => new Date());
  }, 180_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
    else process.env.MANAGEMENT_KERNEL = savedFlag;
    await raw?.end();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("rows the incremental cursor can never look at again", () => {
    it("a late row timestamped WELL BEYOND the overlap is still discovered", async () => {
      const co = await freshCompany("late-row");
      // Move the incremental cursor forward past a batch of recent rows.
      await seedTasks(co, 300, "recent-");
      await sweepUntilQuiet(co);

      // Now a row arrives carrying a timestamp an hour old — sixty times the overlap window, so
      // the incremental keyset bound will never return it.
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      expect(3_600_000).toBeGreaterThan(OVERLAP_MS * 10);
      const lateId = await seedOne(co, "late-arrival", hourAgo);

      const { cycles } = await sweepUntilQuiet(co);
      expect(await observed(co, lateId), `not found after ${cycles} cycles`).toBe(true);
    }, 300_000);

    it("an OLD row mutated with a historical timestamp is re-observed", async () => {
      const co = await freshCompany("hist-mutate");
      const id = await seedOne(co, "will-be-edited", new Date().toISOString());
      await sweepUntilQuiet(co);
      // The item raised by the first sighting stays: an item's history is append-only. What
      // this asserts is that the EDIT is seen again — a new condition on the same subject.

      // Edited, but stamped as if edited long ago — a backfill script, or an ETL that preserves
      // source timestamps. The incremental cursor is already past this point.
      await q(`update tasks set status='blocked', updated_at=$2 where id=$1`,
        [id, new Date(Date.now() - 86_400_000).toISOString()]);

      await sweepUntilQuiet(co);
      // "blocked" is a different condition from the overdue one already raised, so a second
      // item under a new kind is the proof that the edited row was read again.
      const { rows } = await q(
        `select count(distinct kind)::int as kinds from management_items
          where company_id=$1 and subject_id=$2`, [co, id]);
      expect(rows[0].kinds, "the historically-stamped edit was never re-observed")
        .toBeGreaterThan(1);
    }, 300_000);

    it("an IMPORT of historical rows is discovered in full", async () => {
      const co = await freshCompany("backfill");
      await seedTasks(co, 250, "current-");
      await sweepUntilQuiet(co);

      // A migration from an old system: every row carries its original timestamp, years back.
      await seedTasks(co, 120, "imported-", { due: "2026-01-01", updatedAt: "2024-03-01T00:00:00Z" });

      await sweepUntilQuiet(co);
      const { rows } = await q(
        `select count(*)::int as n from tasks t
          where t.company_id=$1 and t.title like 'imported-%'
            and exists (select 1 from management_items i
                         where i.company_id=$1 and i.subject_id = t.id::text)`, [co]);
      expect(rows[0].n).toBe(120);
    }, 600_000);

    it("a row from a writer whose CLOCK IS BEHIND is discovered", async () => {
      const co = await freshCompany("clock-skew");
      await seedTasks(co, 250, "ontime-");
      await sweepUntilQuiet(co);

      // Ten minutes behind: plausible for an unsynchronised host, and far outside the overlap.
      const skewed = new Date(Date.now() - 600_000).toISOString();
      const id = await seedOne(co, "skewed-writer", skewed);

      await sweepUntilQuiet(co);
      expect(await observed(co, id)).toBe(true);
    }, 300_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("the sweep's own mechanics", () => {
    it("equal microsecond timestamps spanning MANY pages are all observed", async () => {
      const co = await freshCompany("equal-ts-pages");
      const at = "2026-05-01T00:00:00.000000Z";
      await seedTasks(co, 700, "same-ts-", { due: "2026-01-01", updatedAt: at });

      await sweepUntilQuiet(co, 60);
      const { rows } = await q(
        `select count(distinct subject_id)::int as n from management_items
          where company_id=$1 and department='operations'`, [co]);
      expect(rows[0].n).toBe(700);
    }, 900_000);

    it("RAPID GROWTH during reconciliation does not lose the rows already there", async () => {
      const co = await freshCompany("growth");
      await seedTasks(co, 300, "before-", { due: "2026-01-01" });
      await cycle(co);                                    // reconciliation part-way through
      await seedTasks(co, 300, "during-", { due: "2026-01-01" });

      await sweepUntilQuiet(co, 60);
      const { rows } = await q(
        `select count(distinct subject_id)::int as n from management_items
          where company_id=$1 and department='operations'`, [co]);
      expect(rows[0].n).toBe(600);
    }, 900_000);

    it("INTERRUPTION and restart resumes rather than starting over or skipping", async () => {
      const co = await freshCompany("interrupt");
      await seedTasks(co, 400, "interrupt-", { due: "2026-01-01" });

      await cycle(co);
      const { rows: mid } = await q(
        `select cursor, generation from observation_source_cursors
          where company_id=$1 and source=$2`, [co, reconcileSourceKey(OPERATIONS_SOURCE)]);
      expect(mid[0]?.cursor, "reconciliation cursor was not persisted").toBeTruthy();

      // A new deps object stands in for a restarted process: nothing in memory carries over,
      // so everything depends on what was durably written.
      const restarted = makeCycleDeps(pgSupabase(raw), () => new Date());
      for (let i = 0; i < 40; i++) {
        const s = await runManagementCycle(restarted, { companyId: co, actorId: null, trigger: "test" });
        if (!s.continuation.some((c) => c.hasMore) && !s.reconciliation.some((r) => r.hasMore)) break;
      }
      const { rows } = await q(
        `select count(distinct subject_id)::int as n from management_items
          where company_id=$1 and department='operations'`, [co]);
      expect(rows[0].n).toBe(400);
    }, 900_000);

    it("an UNUSABLE cursor restarts the sweep instead of wedging the source", async () => {
      const co = await freshCompany("cursor-version");
      await seedTasks(co, 60, "version-", { due: "2026-01-01" });
      await sweepUntilQuiet(co);

      // Two different corruptions, because they fail in two different places.
      //
      // The reconciliation cursor keeps a well-formed shape carrying a value the COLUMN cannot
      // accept — a schema/version change, or corruption. It parses, then the query rejects it.
      // The incremental cursor carries a KIND this version does not know, refused at parse.
      //
      // Both must restart the sweep. Treating either as "finished" would make a whole domain
      // look empty, which reads exactly like "nothing needs attention"; leaving either in place
      // would wedge the source for ever.
      await q(`update observation_source_cursors set cursor = '{"kind":"sweep_by_id","id":"not-a-uuid"}'::jsonb
                where company_id=$1 and source=$2`, [co, reconcileSourceKey(OPERATIONS_SOURCE)]);
      await q(`update observation_source_cursors set cursor = '{"kind":"from_the_future"}'::jsonb
                where company_id=$1 and source=$2`, [co, OPERATIONS_SOURCE]);

      await sweepUntilQuiet(co);
      // Every seeded task is still observed after both corruptions — the sweeps restarted
      // rather than wedging or skipping to the end.
      const { rows } = await q(
        `select count(distinct subject_id)::int as n from management_items
          where company_id=$1 and department='operations'`, [co]);
      expect(rows[0].n).toBe(60);
    }, 300_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("the guarantees the sweep must keep while it does this", () => {
    it("is actually INVOKED through the runtime, not merely present", async () => {
      const co = await freshCompany("invoked");
      await seedTasks(co, 40, "invoked-", { due: "2026-01-01" });
      const s = await cycle(co);

      // Reported by the cycle…
      const rec = s.reconciliation.find((r) => r.source === OPERATIONS_SOURCE);
      expect(rec, JSON.stringify(s.reconciliation)).toBeTruthy();
      expect(rec!.inspected).toBeGreaterThan(0);

      // …and durably positioned, under its OWN key, separate from the incremental cursor.
      const { rows } = await q(
        `select source from observation_source_cursors where company_id=$1 order by source`, [co]);
      const sources = rows.map((r: { source: string }) => r.source);
      expect(sources).toContain(OPERATIONS_SOURCE);
      expect(sources).toContain(reconcileSourceKey(OPERATIONS_SOURCE));
    }, 300_000);

    it("is BOUNDED per cycle — a big table does not make one cycle unbounded", async () => {
      const co = await freshCompany("bounded");
      await seedTasks(co, 900, "bounded-");
      const s = await cycle(co);
      const rec = s.reconciliation.find((r) => r.source === OPERATIONS_SOURCE);
      expect(rec!.inspected).toBeLessThanOrEqual(RECONCILE_PAGE);
      expect(rec!.hasMore).toBe(true);
    }, 300_000);

    it("does not STARVE another domain", async () => {
      const co = await freshCompany("starve");
      await seedTasks(co, 900, "starve-");
      await q(`insert into licences (company_id, name, expiry_date, status)
               values ($1,'starve licence','2026-02-01','active')`, [co]);

      let sawLegal = false;
      for (let i = 0; i < 10 && !sawLegal; i++) {
        await cycle(co);
        const { rows } = await q(
          `select 1 from management_items where company_id=$1 and department='legal' limit 1`, [co]);
        sawLegal = rows.length > 0;
      }
      expect(sawLegal, "legal never observed while operations reconciled").toBe(true);
    }, 600_000);

    it("never licenses RESOLUTION from an incomplete sweep", async () => {
      const co = await freshCompany("resolution");
      await seedTasks(co, 900, "resolution-");
      const s = await cycle(co);
      // The incremental page may well be complete; the full sweep is not.
      expect(s.reconciliation.some((r) => r.hasMore)).toBe(true);
      expect(s.resolutionPermitted).toBe(false);
      expect(s.status).toBe("partial");
      expect(s.failureReason).toMatch(/reconciliation sweep in progress/);
    }, 300_000);

    it("reports the MAXIMUM discovery delay it took, in cycles", async () => {
      // The measured number this campaign can honestly quote: how many cycles a row placed
      // beyond the overlap needed before it was observed.
      const co = await freshCompany("delay");
      await seedTasks(co, 300, "delay-bulk-");
      await sweepUntilQuiet(co);

      const hidden = await seedOne(co, "hidden-row", new Date(Date.now() - 7_200_000).toISOString());
      let found = 0;
      for (let i = 1; i <= 40; i++) {
        await cycle(co);
        if (await observed(co, hidden)) { found = i; break; }
      }
      expect(found, "never discovered within 40 cycles").toBeGreaterThan(0);
      // Bounded by table size / reconcile page, plus a cycle for the rotation to come round.
      const bound = Math.ceil(301 / RECONCILE_PAGE) + 2;
      expect(found, `took ${found} cycles; bound is ${bound}`).toBeLessThanOrEqual(bound);
      console.log(`\n=== MAX TESTED DISCOVERY DELAY: ${found} cycles (bound ${bound}, 301 rows, page ${RECONCILE_PAGE})`);
    }, 600_000);
  });
});
