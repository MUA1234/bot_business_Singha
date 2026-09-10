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
  RECONCILE_PAGE, RESCAN_PAGE, OVERLAP_MS, maxGenerationPages,
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

/** Where the FORWARD coverage lane currently sits. */
async function forwardPosition(co: string): Promise<string> {
  const { rows } = await q(
    `select cursor from observation_source_cursors where company_id=$1 and source=$2`,
    [co, REC_KEY]);
  return String((rows[0]?.cursor as { id?: string } | null)?.id ?? "");
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
    /**
     * The forward-coverage lane must reach the END of the table.
     *
     * A PREVIOUS version of this test asserted only "the sentinel was observed", and passed on
     * cycle 4 — arithmetically impossible for the forward lane, which advances 100 rows a cycle
     * behind 600 rows and cannot arrive before cycle 7. The INCREMENTAL lane found it: the
     * sentinel's `created_at` was backdated but its `updated_at` was left at now(), so it sat
     * among the newest rows in the keyset ordering. The assertion was satisfied by the one lane
     * the test was not about.
     *
     * So both other lanes are now closed off:
     *
     *   INCREMENTAL — the sentinel's `updated_at` is 400 days old and the incremental cursor is
     *     driven past that point first, so the keyset bound can never return it again. The
     *     60-second look-back is nowhere near.
     *   RESCAN — the recovery lane is stubbed to return nothing for this company, so it cannot
     *     satisfy a claim about forward coverage.
     *
     * What remains is the claim itself: the forward lane, resuming rather than restarting across
     * abandonments, arrives at the last row.
     */
    it("the FORWARD lane reaches a sentinel at the very end, across repeated abandonment", async () => {
      const co = await freshCompany("tail-sentinel");
      const PRECEDING = 600;
      await addBackdated(co, PRECEDING, "bulk-");

      // Drive the INCREMENTAL cursor past everything that exists, so the keyset lane is
      // finished with this table before the sentinel is written behind it — while leaving the
      // forward lane exactly where it started.
      //
      // Warming up with ordinary cycles carried the forward lane to the end of the table too,
      // and it then reached the sentinel in a single step: a pass, but not the pass this test
      // is about. The forward lane has to begin at the front and cross all 600 rows.
      const incrementalOnly: CycleDeps = {
        ...deps,
        async loadReconcile() {
          return { rows: [], next: null, complete: true, inspected: 0 };
        },
      };
      for (let i = 0; i < 8; i++) {
        await runManagementCycle(incrementalOnly, {
          companyId: co, actorId: null, trigger: "test",
        });
      }
      expect(await forwardPosition(co), "the warm-up moved the forward lane").toBe("");

      // Last in the id ordering. PostgreSQL has no max(uuid) — ordering is defined,
      // aggregation is not.
      const { rows: maxRow } = await q(
        `select id::text as m from tasks where company_id=$1 order by id desc limit 1`, [co]);
      const lastId: string = maxRow[0].m;
      const sentinelId = lastId.replace(/^[0-9a-f]/i, "f").replace(/[0-9a-f]{12}$/i, "ffffffffffff");

      // Backdated in BOTH senses: created_at puts it inside any fence, updated_at puts it
      // behind the incremental cursor for good.
      await q(
        `insert into tasks (id, company_id, title, status, due_date, created_at, updated_at)
         values ($1,$2,'SENTINEL-tail','in_progress','2026-01-01',
                 now() - interval '400 days', now() - interval '400 days')`,
        [sentinelId, co]);

      const { rows: after } = await q(
        `select count(*)::int as n from tasks where company_id=$1 and id > $2`, [co, sentinelId]);
      expect(after[0].n, "the sentinel is not actually last in id ordering").toBe(0);

      // The incremental lane CANNOT be excluded, and pretending otherwise would be the same
      // mistake in a new place. A keyset sweep that catches up stores a null position and
      // therefore restarts from the front, so it re-reads the whole table and will eventually
      // carry the sentinel too. (Recorded as TD-002: a caught-up keyset lane rewinding to the
      // beginning is wasteful, but it is not this checkpoint's defect.)
      //
      // So the claim is measured where it actually lives: on the cycle at which the FORWARD
      // lane itself carries the sentinel in one of its pages. Whether some other lane also
      // saw it is irrelevant to whether forward coverage reaches the tail.
      const { rows: cur } = await q(
        `select cursor from observation_source_cursors where company_id=$1 and source=$2`,
        [co, OPERATIONS_SOURCE]);
      void cur;

      // Close the recovery lane, and record which lane each reconciliation page came from.
      let forwardSawSentinel = 0;
      const forwardOnly: CycleDeps = {
        ...deps,
        async loadReconcile(req) {
          if (req.lane === "rescan") {
            return { rows: [], next: null, complete: true, inspected: 0 };
          }
          const page = await deps.loadReconcile!(req);
          const ids = (page.rows as Array<{ id?: unknown }>).map((r) => String(r?.id));
          if (ids.includes(sentinelId)) forwardSawSentinel++;
          return page;
        },
      };

      const timeline: string[] = [];
      let found = 0;
      let abandonments = 0;
      for (let i = 1; i <= 40; i++) {
        const before = await forwardPosition(co);
        await addBackdated(co, 60, `refill${i}-`);
        const s = await runManagementCycle(forwardOnly, {
          companyId: co, actorId: null, trigger: "test",
        });
        if (s.reconciliationDelayed.includes(OPERATIONS_SOURCE)) abandonments++;
        const rec = s.reconciliation.find((r) => r.source === OPERATIONS_SOURCE);
        const after2 = await forwardPosition(co);
        timeline.push(
          `c${i}: fwd ${before.slice(0, 8) || "start"}->${after2.slice(0, 8) || "start"} ` +
          `rows=${rec?.inspected ?? 0} inspected=${s.recordsInspected} ` +
          `abandon=${s.reconciliationDelayed.length > 0}`);
        // The measured event: the FORWARD lane carried the sentinel in its own page.
        if (forwardSawSentinel > 0) { found = i; break; }
      }

      console.log("\n=== FORWARD-LANE TIMELINE\n" + timeline.join("\n"));

      // The forward lane reached the last row…
      expect(found, `the forward lane never reached the sentinel in 40 cycles; ` +
        `${abandonments} abandonments`).toBeGreaterThan(0);
      expect(forwardSawSentinel, "the forward lane never carried the sentinel").toBeGreaterThan(0);
      // …and the row genuinely became a management item.
      expect(await observed(co, sentinelId), "the sentinel was never observed at all").toBe(true);
      // …across genuine abandonments, so the scenario actually bit.
      expect(abandonments, "no generation was abandoned — the scenario did not reproduce")
        .toBeGreaterThanOrEqual(2);
      // …and no sooner than the page size allows.
      //
      // The sentinel is row PRECEDING + 1. Cycle k carries rows (k-1)·PAGE+1 … k·PAGE, so
      // with 600 preceding rows cycles 1–6 carry rows 1–600 and the sentinel can FIRST
      // appear on cycle 7. `ceil(600/100)` would say 6, which is off by exactly the
      // sentinel itself — a bound that admits an impossible pass is not a bound.
      const earliest = Math.ceil((PRECEDING + 1) / RECONCILE_PAGE);
      expect(found, `observed on cycle ${found}; the forward lane cannot arrive before ${earliest}`)
        .toBeGreaterThanOrEqual(earliest);

      console.log(`\n=== TAIL LIVENESS: the FORWARD lane carried the sentinel on cycle ${found} ` +
        `of this phase. Earliest arithmetically possible: ${earliest} — the sentinel is row ` +
        `${PRECEDING + 1}, and cycles 1..${PRECEDING / RECONCILE_PAGE} carry rows 1..${PRECEDING} ` +
        `at ${RECONCILE_PAGE}/cycle. ${abandonments} generation abandonments; rescan lane closed.`);
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
