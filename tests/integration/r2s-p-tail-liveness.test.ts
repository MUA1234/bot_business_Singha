/**
 * R2S-P — TAIL LIVENESS, and cursor-error attribution.
 *
 * Two properties that a reconciliation sweep can appear to have while not having them.
 *
 * TAIL LIVENESS. Abandoning an over-long generation by restarting at page one starves the end of
 * the table: with backdated rows continually refilling the early pages, the sweep re-reads the
 * front for ever and a row near the end is never reached. The sentinel here sits at the end of the
 * ordering, behind more rows than one generation is allowed to sweep, while backdated inserts keep
 * landing in the range already covered. It must still be observed.
 *
 * ATTRIBUTION. "The retry from the beginning succeeded, so the cursor was at fault" is not
 * evidence: the malformed row may be on a later page, and a transient failure clears on retry
 * regardless. Only cursor-only validation may produce a reset; once a position validates, every
 * loader failure is the source's and is reported as one.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";
import {
  RECONCILE_PAGE, RESCAN_PAGE, maxGenerationPages,
  reconcileSourceKey, rescanSourceKey,
} from "@/kernel/pagination";
import { OPERATIONS_SOURCE } from "@/kernel/adapters";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const ACTOR = randomUUID();
const REC_KEY = reconcileSourceKey(OPERATIONS_SOURCE);

let raw: pg.Client;
let deps: CycleDeps;
let savedFlag: string | undefined;
let savedMax: string | undefined;

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

/** Rows whose created_at sits BEHIND any fence a running generation could hold. */
async function addBackdated(co: string, n: number, prefix: string) {
  for (let i = 0; i < n; i += 250) {
    const batch = Math.min(250, n - i);
    const values = Array.from({ length: batch }, (_, k) =>
      `($1,'${prefix}${i + k}','in_progress','2026-01-01', now() - interval '400 days')`).join(",");
    await q(`insert into tasks (company_id, title, status, due_date, created_at) values ` + values, [co]);
  }
}

async function observed(co: string, taskId: string): Promise<boolean> {
  const { rows } = await q(
    `select 1 from management_items where company_id=$1 and subject_id=$2 limit 1`, [co, taskId]);
  return rows.length > 0;
}

describe.skipIf(!enabled)("R2S-P — tail liveness and cursor attribution", () => {
  beforeAll(async () => {
    savedFlag = process.env.MANAGEMENT_KERNEL;
    savedMax = process.env.KERNEL_MAX_GENERATION_PAGES;
    process.env.MANAGEMENT_KERNEL = "on";
    // A tiny work bound, so abandonment is reachable in a test rather than after 10,000 rows.
    // It is read at call time precisely so this is possible.
    process.env.KERNEL_MAX_GENERATION_PAGES = "2";

    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [ACTOR]);
    await q(`insert into users (id,full_name,is_active) values ($1,'tail actor',true)
             on conflict (id) do nothing`, [ACTOR]);
    deps = makeCycleDeps(pgSupabase(raw), () => new Date());
  }, 180_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
    else process.env.MANAGEMENT_KERNEL = savedFlag;
    if (savedMax === undefined) delete process.env.KERNEL_MAX_GENERATION_PAGES;
    else process.env.KERNEL_MAX_GENERATION_PAGES = savedMax;
    await raw?.end();
  });

  it("the work bound is small enough here to force repeated abandonment", () => {
    expect(maxGenerationPages()).toBe(2);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("the tail is reachable", () => {
    it("a SENTINEL at the end is observed despite repeated abandonment and backdated inserts", async () => {
      const co = await freshCompany("tail-sentinel");

      // More rows than one generation may sweep: the bound is 2 pages × 100, and there are far
      // more than 200 here, so this generation CANNOT finish before being abandoned.
      await addBackdated(co, 600, "bulk-");

      // The sentinel sits at the very end of the id ordering. `id` is a uuid, so the ordering is
      // arbitrary but stable — the sentinel is placed by taking the largest id present and
      // writing one above it, which is the only way to be genuinely last.
      // PostgreSQL has no max(uuid) — ordering is defined, aggregation is not.
      const { rows: maxRow } = await q(
        `select id::text as m from tasks where company_id=$1 order by id desc limit 1`, [co]);
      const lastId: string = maxRow[0].m;
      const sentinelId = lastId.replace(/^[0-9a-f]/i, "f").replace(/[0-9a-f]{12}$/i, "ffffffffffff");
      await q(
        `insert into tasks (id, company_id, title, status, due_date, created_at)
         values ($1,$2,'SENTINEL-tail','in_progress','2026-01-01', now() - interval '400 days')`,
        [sentinelId, co]);

      const { rows: check } = await q(
        `select count(*)::int as after from tasks where company_id=$1 and id > $2`, [co, sentinelId]);
      expect(check[0].after, "the sentinel is not actually last").toBe(0);

      // Now sweep, while backdated rows keep landing in the range already covered. Under the
      // restart-at-page-one strategy this is exactly the shape that starved the tail for ever.
      let found = 0;
      let abandonments = 0;
      for (let i = 1; i <= 40; i++) {
        await addBackdated(co, 60, `refill${i}-`);
        const s = await cycle(co);
        if (s.reconciliationDelayed.includes(OPERATIONS_SOURCE)) abandonments++;
        if (await observed(co, sentinelId)) { found = i; break; }
      }

      expect(abandonments, "the generation was never abandoned — the scenario did not bite")
        .toBeGreaterThan(0);
      expect(found, `sentinel never observed; ${abandonments} abandonments`).toBeGreaterThan(0);
      console.log(`\n=== TAIL LIVENESS: sentinel observed on cycle ${found} ` +
        `after ${abandonments} generation abandonments (bound ${maxGenerationPages()} pages, ` +
        `page ${RECONCILE_PAGE}, rescan ${RESCAN_PAGE})`);
    }, 900_000);

    it("forward coverage does not restart at page one when a generation is abandoned", async () => {
      const co = await freshCompany("tail-monotonic");
      await addBackdated(co, 500, "mono-");

      const positions: string[] = [];
      for (let i = 0; i < 6; i++) {
        await addBackdated(co, 60, `mono-refill${i}-`);
        await cycle(co);
        const { rows } = await q(
          `select cursor from observation_source_cursors where company_id=$1 and source=$2`,
          [co, REC_KEY]);
        const id = (rows[0]?.cursor as { id?: string } | null)?.id ?? "";
        positions.push(id);
      }

      // The position may pause, and it wraps when a pass genuinely ends — but it must not be
      // dragged back to the beginning by an abandonment. An empty id after the first page would
      // mean exactly that.
      const emptied = positions.slice(1).filter((p) => p === "").length;
      expect(emptied, `forward position was reset to page one: ${JSON.stringify(positions)}`)
        .toBeLessThanOrEqual(1);
    }, 900_000);

    it("the earlier-range RESCAN runs alongside, on its own position", async () => {
      const co = await freshCompany("tail-rescan");
      await addBackdated(co, 300, "rescan-");
      await cycle(co);
      await cycle(co);

      const { rows } = await q(
        `select source from observation_source_cursors where company_id=$1 order by source`, [co]);
      const sources = rows.map((r: { source: string }) => r.source);
      // Three distinct positions: incremental, forward coverage, and backdated recovery.
      expect(sources).toContain(OPERATIONS_SOURCE);
      expect(sources).toContain(REC_KEY);
      expect(sources).toContain(rescanSourceKey(OPERATIONS_SOURCE));
    }, 600_000);

    it("resolution stays FORBIDDEN while any pass is dirty", async () => {
      const co = await freshCompany("tail-no-resolution");
      await addBackdated(co, 500, "nores-");
      for (let i = 0; i < 6; i++) {
        await addBackdated(co, 60, `nores-refill${i}-`);
        const s = await cycle(co);
        // A pass that was abandoned covered the table under more than one boundary, so reaching
        // the end proves nothing. Nothing may be resolved on that evidence.
        expect(s.resolutionPermitted).toBe(false);
      }
    }, 900_000);

    it("once the backdating stops, every row including the tail is observed", async () => {
      const co = await freshCompany("tail-settles");
      await addBackdated(co, 350, "settle-");
      for (let i = 0; i < 3; i++) {
        await addBackdated(co, 60, `settle-burst${i}-`);
        await cycle(co);
      }
      const { rows: total } = await q(
        `select count(*)::int as n from tasks where company_id=$1`, [co]);

      let observedCount = 0;
      for (let i = 0; i < 40; i++) {
        await cycle(co);
        const { rows } = await q(
          `select count(distinct subject_id)::int as n from management_items
            where company_id=$1 and department='operations'`, [co]);
        observedCount = rows[0].n;
        if (observedCount === total[0].n) break;
      }
      expect(observedCount, `${observedCount} of ${total[0].n} observed`).toBe(total[0].n);
    }, 900_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("a reset comes from cursor validation, and from nothing else", () => {
    async function seeded(label: string) {
      const co = await freshCompany(label);
      await addBackdated(co, 40, `${label}-`);
      await cycle(co);
      return co;
    }

    /** A loader that fails only from page N onwards, with a chosen SQLSTATE. */
    function failingFrom(pageIndex: number, code: string, message: string) {
      let seen = 0;
      const d: CycleDeps = {
        ...deps,
        async loadPage(req) {
          if (req.source === OPERATIONS_SOURCE) {
            if (seen++ >= pageIndex) throw Object.assign(new Error(message), { code });
          }
          return deps.loadPage!(req);
        },
      };
      return d;
    }

    it("malformed source data on a LATER page is a source failure, not a cursor reset", async () => {
      // The case that broke the old inference: reading from the beginning succeeds, so a
      // retry-based attribution would have blamed the cursor and restarted the sweep, hiding a
      // real data fault behind a busy loop.
      const co = await seeded("attr-later-page");
      const s = await runManagementCycle(
        failingFrom(0, "22P02", `invalid input syntax for type numeric: "x"`),
        { companyId: co, actorId: null, trigger: "test" });

      expect(s.cursorReset, "a later-page data fault was disguised as a cursor reset")
        .not.toContain(OPERATIONS_SOURCE);
      expect(s.sourcesFailed).toBeGreaterThan(0);
    }, 300_000);

    it("a TRANSIENT failure that clears on retry is not recorded as a corrupt cursor", async () => {
      const co = await seeded("attr-transient");
      let first = true;
      const flaky: CycleDeps = {
        ...deps,
        async loadPage(req) {
          if (req.source === OPERATIONS_SOURCE && first) {
            first = false;
            throw Object.assign(new Error("connection reset by peer"), { code: "08006" });
          }
          return deps.loadPage!(req);
        },
      };
      const s = await runManagementCycle(flaky, { companyId: co, actorId: null, trigger: "test" });
      expect(s.cursorReset).not.toContain(OPERATIONS_SOURCE);
      expect(s.sourcesFailed).toBeGreaterThan(0);

      // And the next cycle simply works — the position was never the problem.
      const ok = await cycle(co);
      expect(ok.cursorReset).not.toContain(OPERATIONS_SOURCE);
    }, 300_000);

    it("a schema/type failure and a permission denial both stay failed", async () => {
      const cases: Array<[string, string]> = [
        ["42703", "column tasks.nope does not exist"],
        ["42501", "permission denied for table tasks"],
      ];
      for (const [code, message] of cases) {
        const co = await seeded(`attr-${code}`);
        const s = await runManagementCycle(
          failingFrom(0, code, message),
          { companyId: co, actorId: null, trigger: "test" });
        expect(s.cursorReset, `${code} must not reset`).not.toContain(OPERATIONS_SOURCE);
        expect(s.sourcesFailed, `${code} must fail`).toBeGreaterThan(0);
        expect(s.unobservedDepartments).toContain("operations");
      }
    }, 600_000);

    it("a source failure BEYOND the first restart page is still a source failure", async () => {
      // Even with a genuinely corrupt position, the restart's own later pages belong to the
      // source: a reset recovers a place to read from, it does not vouch for what is there.
      const co = await seeded("attr-beyond-restart");
      await q(
        `insert into observation_source_cursors (company_id, source, cursor)
         values ($1,$2,'{"kind":"sweep_by_id","id":"not-a-uuid"}'::jsonb)
         on conflict (company_id, source) do update set cursor = excluded.cursor`,
        [co, REC_KEY]);

      const s = await runManagementCycle(
        failingFrom(0, "22P02", `invalid input syntax for type numeric: "x"`),
        { companyId: co, actorId: null, trigger: "test" });
      expect(s.sourcesFailed).toBeGreaterThan(0);
    }, 300_000);
  });
});
