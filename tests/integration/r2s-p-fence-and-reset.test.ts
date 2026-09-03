/**
 * R2S-P — the reconciliation generation's fence, and the NARROW cursor reset.
 *
 * Two separate claims, both easy to get wrong in the same direction — by being too generous.
 *
 * The fence bounds a generation: without a fixed upper boundary a sweep never finishes while rows
 * keep arriving, so `ceil(N / page)` describes nothing. With one, N is definite and everything
 * newer is the next generation's work.
 *
 * The reset is the opposite discipline: restarting a sweep is a real action that discards a
 * recorded position, so it must happen for a corrupt POSITION and for nothing else. A permission
 * denial, a missing column, a timeout or an isolation failure must stay visible as a failure. A
 * reset that swallowed those would convert an outage into a quiet retry loop.
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
  RECONCILE_PAGE, reconcileSourceKey, cursorIsUsable, isUnusableCursorError,
  validateCursorEnvelope,
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

async function addTasks(co: string, n: number, prefix: string, due = "2099-01-01") {
  for (let i = 0; i < n; i += 250) {
    const batch = Math.min(250, n - i);
    const values = Array.from({ length: batch }, (_, k) =>
      `($1,'${prefix}${i + k}','in_progress','${due}')`).join(",");
    await q(`insert into tasks (company_id, title, status, due_date) values ` + values, [co]);
  }
}

async function recState(co: string) {
  const { rows } = await q(
    `select cursor, generation, sweep_complete_at from observation_source_cursors
      where company_id=$1 and source=$2`, [co, REC_KEY]);
  return rows[0] as
    | { cursor: { fence?: string; id?: string } | null; generation: number; sweep_complete_at: string | null }
    | undefined;
}

/** Force a stored cursor value, bypassing the kernel. */
async function setCursor(co: string, source: string, cursor: unknown) {
  await q(
    `insert into observation_source_cursors (company_id, source, cursor)
     values ($1,$2,$3::jsonb)
     on conflict (company_id, source) do update set cursor = excluded.cursor`,
    [co, source, JSON.stringify(cursor)]);
}

describe.skipIf(!enabled)("R2S-P — generation fence and narrow reset", () => {
  beforeAll(async () => {
    savedFlag = process.env.MANAGEMENT_KERNEL;
    savedMax = process.env.KERNEL_MAX_GENERATION_PAGES;
    process.env.MANAGEMENT_KERNEL = "on";
    // Pinned explicitly. Another file lowers this to force abandonment, and these tests are
    // about a generation COMPLETING — leaving it ambient would let one file silently decide
    // what another file is testing.
    process.env.KERNEL_MAX_GENERATION_PAGES = "100";
    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [ACTOR]);
    await q(`insert into users (id,full_name,is_active) values ($1,'fence actor',true)
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

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("the generation fence", () => {
    it("is captured at the start and does NOT move during the generation", async () => {
      const co = await freshCompany("fence-stable");
      await addTasks(co, 350, "fence-");

      await cycle(co);
      const first = await recState(co);
      expect(first?.cursor?.fence, "no fence was captured").toBeTruthy();

      await addTasks(co, 200, "fence-more-");
      await cycle(co);
      const second = await recState(co);
      // Same generation, same boundary — otherwise the generation would keep growing.
      expect(second?.cursor?.fence).toBe(first!.cursor!.fence);
    }, 300_000);

    it("COMPLETES under continuous inserts, and the bound holds for the fenced N", async () => {
      const co = await freshCompany("fence-completes");
      const fencedRows = 450;
      await addTasks(co, fencedRows, "fenced-", "2026-01-01");

      // The bound is over the rows INSIDE the boundary, not the table's eventual size — so the
      // boundary has to exist before the arrivals begin. This first cycle captures it over
      // exactly `fencedRows` rows; everything added afterwards is deferred, by design.
      await cycle(co);
      const bound = Math.ceil(fencedRows / RECONCILE_PAGE) + 1;

      let cycles = 1;
      let generation = 0;
      for (let i = 2; i <= bound + 3; i++) {
        // Steady arrivals, every single cycle. Before the fence this prevented the generation
        // from ever wrapping: 450 rows were still unswept after 10 cycles.
        await addTasks(co, 150, `arriving${i}-`, "2026-01-01");
        await cycle(co);
        cycles = i;
        generation = (await recState(co))?.generation ?? 0;
        if (generation >= 1) break;
      }

      expect(generation, `no generation completed in ${cycles} cycles`).toBeGreaterThanOrEqual(1);
      expect(cycles, `took ${cycles} cycles, bound ${bound}`).toBeLessThanOrEqual(bound);
      console.log(`\n=== FENCED BOUND: ${fencedRows} fenced rows completed in ${cycles} cycles ` +
        `(bound ${bound}; ~${150 * cycles} rows arrived meanwhile and were deferred)`);
    }, 900_000);

    it("the NEXT generation observes the rows the last one deferred", async () => {
      const co = await freshCompany("fence-next-gen");
      await addTasks(co, 120, "gen1-", "2026-01-01");

      // Finish generation 1.
      for (let i = 0; i < 12; i++) {
        await cycle(co);
        if (((await recState(co))?.generation ?? 0) >= 1) break;
      }
      const afterFirst = await recState(co);
      expect(afterFirst!.generation).toBeGreaterThanOrEqual(1);

      // These arrive after that boundary, so they were NOT this generation's work.
      await addTasks(co, 60, "deferred-", "2026-01-01");

      for (let i = 0; i < 12; i++) {
        await cycle(co);
        const { rows } = await q(
          `select count(*)::int as n from tasks t
            where t.company_id=$1 and t.title like 'deferred-%'
              and exists (select 1 from management_items i
                           where i.company_id=$1 and i.subject_id = t.id::text)`, [co]);
        if (rows[0].n === 60) break;
      }
      const { rows } = await q(
        `select count(*)::int as n from tasks t
          where t.company_id=$1 and t.title like 'deferred-%'
            and exists (select 1 from management_items i
                         where i.company_id=$1 and i.subject_id = t.id::text)`, [co]);
      expect(rows[0].n, "deferred rows were never picked up").toBe(60);

      const afterSecond = await recState(co);
      // A new generation means a new boundary.
      expect(afterSecond!.cursor?.fence ?? null).not.toBe(afterFirst!.cursor?.fence ?? null);
    }, 900_000);

    it("no source is left permanently partial once the arrivals stop", async () => {
      const co = await freshCompany("fence-settles");
      await addTasks(co, 200, "settle-", "2026-01-01");
      for (let i = 0; i < 8; i++) await cycle(co);      // arrivals stop here
      let settled = false;
      const reasons: string[] = [];
      for (let i = 0; i < 30; i++) {
        const s = await cycle(co);
        if (s.status === "completed") { settled = true; break; }
        reasons.push(s.failureReason ?? s.status);
      }
      // If this fails, the message has to name what was still outstanding — "never settled"
      // on its own sends the next reader back to the database to find out.
      expect(settled,
        `never settled; last reasons: ${[...new Set(reasons.slice(-6))].join(" | ")}`)
        .toBe(true);
    }, 900_000);

    it("no completion is claimed around the generation boundary", async () => {
      const co = await freshCompany("fence-no-false");
      await addTasks(co, 250, "boundary-", "2026-01-01");
      for (let i = 0; i < 10; i++) {
        const s = await cycle(co);
        const st = await recState(co);
        const rec = s.reconciliation.find((r) => r.source === OPERATIONS_SOURCE);
        // A completion time appears only WITH a completed generation. It is checked against the
        // cycle that actually finished the pass — a stamp left by an EARLIER cycle says nothing
        // about what THIS one still has outstanding.
        if (st?.sweep_complete_at && rec && !rec.hasMore) {
          expect(st.generation).toBeGreaterThanOrEqual(1);
        }
        if (!s.resolutionPermitted) continue;
        // Resolution is only ever permitted when nothing is outstanding anywhere.
        expect(s.reconciliation.every((r) => !r.hasMore)).toBe(true);
        expect(s.continuation.every((c) => !c.hasMore)).toBe(true);
      }
    }, 900_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("a reset happens for a corrupt POSITION and nothing else", () => {
    it("classifies unusable positions without touching the database", () => {
      // Explicit validation, ahead of any query.
      expect(cursorIsUsable({ kind: "sweep_by_id", id: "not-a-uuid" })).toBe(false);
      expect(cursorIsUsable({ kind: "sweep_by_id", id: "", fence: "not-a-date" })).toBe(false);
      expect(cursorIsUsable({ kind: "keyset_updated", updatedAt: "not-a-date", id: "" })).toBe(false);
      expect(cursorIsUsable({ kind: "sweep_by_id", id: randomUUID() })).toBe(true);
      expect(cursorIsUsable({ kind: "keyset_updated", updatedAt: new Date().toISOString(), id: randomUUID() }))
        .toBe(true);
      expect(cursorIsUsable(null)).toBe(true);
    });

    it("a SQLSTATE never decides attribution any more", () => {
      // The classifier survives for diagnosis, but it is deliberately NOT consulted when
      // deciding whether to restart a sweep. A 22-class code is raised by malformed row DATA
      // and by a schema mismatch exactly as readily as by a bad bound, so it cannot attribute
      // a failure to the cursor. `validateCursorEnvelope` decides that, on the cursor alone.
      expect(isUnusableCursorError({ code: "22P02" })).toBe(true);
      for (const code of ["42501", "42P01", "42703", "57014", "53100", "08006", "40001"]) {
        expect(isUnusableCursorError({ code }), code).toBe(false);
      }
      expect(isUnusableCursorError(new Error("invalid input syntax for type uuid"))).toBe(false);
    });

    it("validates the cursor ENVELOPE — kind, then values", () => {
      // A position written for a different source, or by a different version, is not merely
      // wrong: it cannot be used at all.
      expect(validateCursorEnvelope({ kind: "keyset_updated", updatedAt: new Date().toISOString(), id: "" }, "sweep_by_id"))
        .toEqual({ ok: false, problem: "kind_mismatch" });
      expect(validateCursorEnvelope({ kind: "sweep_by_id", id: "not-a-uuid" }, "sweep_by_id"))
        .toEqual({ ok: false, problem: "invalid_id" });
      expect(validateCursorEnvelope({ kind: "sweep_by_id", id: "", fence: "March 3 2026" }, "sweep_by_id"))
        .toEqual({ ok: false, problem: "invalid_fence" });
      expect(validateCursorEnvelope({ kind: "keyset_updated", updatedAt: "March 3 2026", id: "" }, "keyset_updated"))
        .toEqual({ ok: false, problem: "invalid_timestamp" });

      // "March 3 2026" matters: Date.parse accepts it and PostgreSQL does not, so validating
      // with Date.parse alone would wave a bad bound straight through into a failing query.
      expect(Number.isNaN(Date.parse("March 3 2026"))).toBe(false);

      expect(validateCursorEnvelope(null, "sweep_by_id")).toEqual({ ok: true });
      expect(validateCursorEnvelope({ kind: "sweep_by_id", id: randomUUID() }, "sweep_by_id"))
        .toEqual({ ok: true });
    });

    it("an invalid ID cursor is reset, and the sweep recovers completely", async () => {
      const co = await freshCompany("reset-bad-id");
      await addTasks(co, 80, "badid-", "2026-01-01");
      await cycle(co);
      await setCursor(co, REC_KEY, { kind: "sweep_by_id", id: "not-a-uuid" });

      const s = await cycle(co);
      expect(s.cursorReset).toContain(OPERATIONS_SOURCE);
      // A restarted position may not license resolution in the same cycle.
      expect(s.resolutionPermitted).toBe(false);
      expect(s.status).toBe("partial");
      expect(s.failureReason).toMatch(/stored position unusable/);

      for (let i = 0; i < 15; i++) await cycle(co);
      const { rows } = await q(
        `select count(distinct subject_id)::int as n from management_items
          where company_id=$1 and department='operations'`, [co]);
      expect(rows[0].n).toBe(80);
    }, 600_000);

    it("an invalid TIMESTAMP cursor is reset", async () => {
      const co = await freshCompany("reset-bad-ts");
      await addTasks(co, 40, "badts-", "2026-01-01");
      await cycle(co);
      await setCursor(co, OPERATIONS_SOURCE, { kind: "keyset_updated", updatedAt: "1999-99-99", id: "" });

      // Refused at parse, before it can reach a query.
      const s = await cycle(co);
      expect(s.status).not.toBe("failed");
      for (let i = 0; i < 10; i++) await cycle(co);
      const { rows } = await q(
        `select count(distinct subject_id)::int as n from management_items
          where company_id=$1 and department='operations'`, [co]);
      expect(rows[0].n).toBe(40);
    }, 600_000);

    it("a cursor from ANOTHER COMPANY cannot read across the boundary", async () => {
      const a = await freshCompany("reset-iso-a");
      const b = await freshCompany("reset-iso-b");
      await addTasks(a, 30, "iso-a-", "2026-01-01");
      await addTasks(b, 30, "iso-b-", "2026-01-01");
      await cycle(b);

      // B's position, planted in A. It is a well-formed uuid, so it is USED, not reset — and the
      // query is company-scoped, so it can only ever move A's sweep within A's own rows.
      const bState = await recState(b);
      if (bState?.cursor?.id) {
        await setCursor(a, REC_KEY, { kind: "sweep_by_id", id: bState.cursor.id });
      }
      for (let i = 0; i < 15; i++) await cycle(a);

      const { rows } = await q(
        `select count(*)::int as n from management_items i
           join tasks t on t.id::text = i.subject_id
          where i.company_id=$1 and t.company_id <> $1`, [a]);
      expect(rows[0].n, "a foreign row was observed in this company").toBe(0);
    }, 600_000);

    it("a PERMISSION failure propagates as failed — it is never reset away", async () => {
      const co = await freshCompany("reset-not-perm");
      await addTasks(co, 20, "perm-", "2026-01-01");
      await cycle(co);

      const denied: CycleDeps = {
        ...deps,
        async loadPage(req) {
          if (req.source === OPERATIONS_SOURCE) {
            throw Object.assign(new Error("permission denied for table tasks"), { code: "42501" });
          }
          return deps.loadPage!(req);
        },
      };
      const s = await runManagementCycle(denied, { companyId: co, actorId: null, trigger: "test" });
      expect(s.cursorReset).not.toContain(OPERATIONS_SOURCE);
      expect(s.sourcesFailed).toBeGreaterThan(0);
      expect(s.unobservedDepartments).toContain("operations");
    }, 300_000);

    it("a MISSING COLUMN and a TIMEOUT propagate as failed", async () => {
      for (const [code, message] of [["42703", "column does not exist"], ["57014", "canceling statement due to statement timeout"]]) {
        const co = await freshCompany(`reset-not-${code}`);
        await addTasks(co, 20, `code${code}-`, "2026-01-01");
        await cycle(co);

        const broken: CycleDeps = {
          ...deps,
          async loadPage(req) {
            if (req.source === OPERATIONS_SOURCE) throw Object.assign(new Error(message), { code });
            return deps.loadPage!(req);
          },
        };
        const s = await runManagementCycle(broken, { companyId: co, actorId: null, trigger: "test" });
        expect(s.cursorReset, `${code} must not reset`).not.toContain(OPERATIONS_SOURCE);
        expect(s.sourcesFailed, `${code} must fail`).toBeGreaterThan(0);
      }
    }, 600_000);

    it("retries AT MOST once — a second failure is not swallowed", async () => {
      const co = await freshCompany("reset-once");
      await addTasks(co, 20, "once-", "2026-01-01");
      await cycle(co);
      await setCursor(co, OPERATIONS_SOURCE, { kind: "keyset_updated", updatedAt: new Date().toISOString(), id: "not-a-uuid" });

      let calls = 0;
      const alwaysBad: CycleDeps = {
        ...deps,
        async loadPage(req) {
          if (req.source === OPERATIONS_SOURCE) {
            calls++;
            throw Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
          }
          return deps.loadPage!(req);
        },
      };
      const s = await runManagementCycle(alwaysBad, { companyId: co, actorId: null, trigger: "test" });
      // The pre-validation rejects the bad id, so the restart is the FIRST query; its failure is
      // real and is reported rather than retried again.
      expect(calls).toBeLessThanOrEqual(2);
      expect(s.sourcesFailed).toBeGreaterThan(0);
    }, 300_000);

    it("two CONCURRENT cycles resetting one source resolve deterministically", async () => {
      const co = await freshCompany("reset-concurrent");
      await addTasks(co, 60, "conc-", "2026-01-01");
      await cycle(co);
      await setCursor(co, REC_KEY, { kind: "sweep_by_id", id: "not-a-uuid" });

      // A second connection, so the company lock is genuinely contended rather than re-entered.
      const other = new pg.Client({ connectionString: URL, ssl: false });
      await other.connect();
      await other.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
      const otherDeps = makeCycleDeps(pgSupabase(other), () => new Date());
      try {
        const [a, b] = await Promise.all([
          cycle(co),
          runManagementCycle(otherDeps, { companyId: co, actorId: null, trigger: "test" }),
        ]);
        // The company lock serialises them: one runs, the other is told so plainly.
        const statuses = [a.status, b.status];
        expect(statuses).toContain("skipped_locked");
        // Exactly one stored position survives, and it is readable.
        const st = await recState(co);
        expect(st).toBeTruthy();
        expect(cursorIsUsable((st!.cursor ?? null) as never)).toBe(true);
      } finally {
        await other.end();
      }
    }, 300_000);

    it("never records the raw cursor in the status it reports", async () => {
      const co = await freshCompany("reset-no-leak");
      await addTasks(co, 20, "leak-", "2026-01-01");
      await cycle(co);
      await setCursor(co, REC_KEY, { kind: "sweep_by_id", id: "not-a-uuid" });

      const s = await cycle(co);
      const text = JSON.stringify({ reason: s.failureReason, reset: s.cursorReset });
      // The source is named; the position value is not echoed back.
      expect(text).toContain(OPERATIONS_SOURCE);
      expect(text).not.toContain("not-a-uuid");

      const { rows } = await q(
        `select last_error from observation_source_cursors where company_id=$1 and source=$2`,
        [co, REC_KEY]);
      expect(String(rows[0]?.last_error ?? "")).not.toContain("not-a-uuid");
    }, 300_000);
  });
});
