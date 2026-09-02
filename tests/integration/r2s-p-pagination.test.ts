/**
 * R2S-P — bounded pagination, cursors and complete reconciliation, against a live database.
 *
 * The question this answers is not "does pagination work" but "can a record hide from it". So the
 * dataset sizes straddle the page boundary exactly (499 / 500 / 501), rows are inserted, edited
 * and deleted DURING a sweep, pages are made to fail, cursors are tampered with, and every case
 * is checked for the two failures that matter: a row that is never observed, and a duplicate
 * management item.
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
import { PAGE_SIZE, CYCLE_ROW_BUDGET, parseCursor, CursorRejected } from "@/kernel/pagination";
import { OPERATIONS_SOURCE, FINANCE_SOURCE, LEGAL_SOURCE, WORKFORCE_SOURCE } from "@/kernel/adapters";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO = randomUUID();
const CO_OTHER = randomUUID();
const ACTOR = randomUUID();

let raw: pg.Client;
let deps: CycleDeps;
let customerId: string;
let savedFlag: string | undefined;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);
const cycle = (companyId = CO) =>
  runManagementCycle(deps, { companyId, actorId: null, trigger: "test" });

/** Run cycles until every source reports it has nothing more, or the guard trips. */
async function sweepToCompletion(maxCycles = 60) {
  let cycles = 0;
  for (;;) {
    const s = await cycle();
    cycles++;
    const more = s.continuation.some((c) => c.hasMore);
    if (!more || cycles >= maxCycles) return { cycles, summary: s };
  }
}

const countItems = async (department: string, companyId = CO) => {
  const { rows } = await q(
    `select count(*)::int as n from management_items where company_id=$1 and department=$2`,
    [companyId, department]);
  return rows[0].n as number;
};

/**
 * Distinct (subject, condition) pairs.
 *
 * Duplication means the SAME condition about the same subject raised twice. It is not
 * `items === subjects`: one overdue task with no estimate legitimately raises two different
 * conditions, and asserting otherwise would demand the product stop reporting one of them.
 */
const distinctPairs = async (department: string, companyId = CO) => {
  const { rows } = await q(
    `select count(distinct (subject_id, kind))::int as n from management_items
      where company_id=$1 and department=$2`, [companyId, department]);
  return rows[0].n as number;
};

const distinctSubjects = async (department: string, companyId = CO) => {
  const { rows } = await q(
    `select count(distinct subject_id)::int as n from management_items
      where company_id=$1 and department=$2`, [companyId, department]);
  return rows[0].n as number;
};

/**
 * N tasks for the operations source (keyset_updated).
 *
 * `condition` controls whether each row RAISES something. Volume tests pass false: the rows are
 * still read, paged and cursored exactly the same way, but they create no management item, so the
 * test measures pagination rather than item-creation throughput. Correctness tests pass true,
 * because "every record is eventually observed" is precisely what they assert.
 */
async function seedTasks(n: number, prefix: string, companyId = CO, condition = true) {
  const size = 250;
  const due = condition ? "2026-01-01" : "2099-01-01";
  for (let i = 0; i < n; i += size) {
    const batch = Math.min(size, n - i);
    const values = Array.from({ length: batch }, (_, k) =>
      "($1,'" + prefix + (i + k) + "','in_progress','" + due + "')").join(",");
    await q("insert into tasks (company_id, title, status, due_date) values " + values, [companyId]);
  }
}

describe.skipIf(!enabled)("R2S-P — bounded pagination and complete reconciliation", () => {
  beforeAll(async () => {
    savedFlag = process.env.MANAGEMENT_KERNEL;
    process.env.MANAGEMENT_KERNEL = "on";

    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);

    for (const co of [CO, CO_OTHER]) {
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR') on conflict (id) do nothing`,
        [co, `pg ${co.slice(0, 8)}`]);
    }
    await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [ACTOR]);
    await q(`insert into users (id,full_name,is_active) values ($1,'pg actor',true) on conflict (id) do nothing`, [ACTOR]);
    const { rows } = await q(
      `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`, [CO, ACTOR]);
    await q(`insert into membership_roles (membership_id,company_id,role_key) values ($1,$2,'owner_management')`,
      [rows[0].id, CO]);
    for (const co of [CO, CO_OTHER]) {
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now()) on conflict (company_id) do update set enabled = true`, [co, ACTOR]);
    }
    const { rows: cust } = await q(
      `insert into customers (company_id, name, status) values ($1,'pg customer','active') returning id`, [CO]);
    customerId = cust[0].id;

    deps = makeCycleDeps(pgSupabase(raw), () => new Date());
  }, 180_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
    else process.env.MANAGEMENT_KERNEL = savedFlag;
    await raw?.end();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("dataset sizes across the page boundary", () => {
    const sizes = [0, 1, 499, 500, 501];

    for (const n of sizes) {
      it(`${n} records: every one is eventually observed, exactly once`, async () => {
        const co = randomUUID();
        await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, `sz${n}`]);
        await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
                 values ($1,true,$2,now())`, [co, ACTOR]);
        await seedTasks(n, `size${n}-`, co);

        let cycles = 0;
        for (;;) {
          const s = await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
          cycles++;
          if (!s.continuation.some((c) => c.hasMore) || cycles >= 40) break;
        }

        const { rows } = await q(
          `select count(*)::int as items,
                  count(distinct subject_id)::int as subjects,
                  count(distinct (subject_id, kind))::int as pairs
             from management_items where company_id=$1 and department='operations'`, [co]);
        // EVERY task is observed…
        expect(rows[0].subjects, `${n} tasks -> ${rows[0].subjects} subjects`).toBe(n);
        // …and NO (subject, condition) pair is raised twice.
        //
        // Not `items === subjects`: one overdue task with no estimate raises TWO distinct
        // conditions, which is two items about one subject and is correct. Duplication means
        // the SAME condition about the same subject appearing more than once, which is what
        // identity-key deduplication exists to prevent.
        expect(rows[0].items, "a (subject, kind) pair was raised twice").toBe(rows[0].pairs);
      }, 240_000);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("mutation during a sweep", () => {
    it("a record INSERTED mid-sweep is not lost", async () => {
      await seedTasks(300, "mid-insert-", CO, false);
      await cycle();                       // first page only
      await seedTasks(1, "inserted-during-sweep-");
      await sweepToCompletion();

      const { rows } = await q(
        `select count(*)::int as n from management_items i
           join tasks t on t.id::text = i.subject_id
          where i.company_id=$1 and t.title like 'inserted-during-sweep-%'`, [CO]);
      expect(rows[0].n).toBeGreaterThan(0);
    }, 180_000);

    it("an OLD record modified mid-sweep is eventually re-observed", async () => {
      // A keyset_updated source: editing a row moves it to the END of the order, so the sweep
      // reaches it again. This is why created_at must never be a mutation cursor.
      const { rows: t } = await q(
        `insert into tasks (company_id, title, status, due_date)
         values ($1,'old-then-edited','completed','2026-01-01') returning id`, [CO]);
      await sweepToCompletion();
      const before = await countItems("operations");

      await q(`update tasks set status='in_progress', updated_at=now() where id=$1`, [t[0].id]);
      await sweepToCompletion();

      const { rows } = await q(
        `select count(*)::int as n from management_items
          where company_id=$1 and subject_id=$2`, [CO, t[0].id]);
      expect(rows[0].n).toBeGreaterThan(0);
      expect(await countItems("operations")).toBeGreaterThanOrEqual(before);
    }, 180_000);

    it("a record DELETED mid-sweep does not break the sweep or resurrect", async () => {
      const { rows: t } = await q(
        `insert into tasks (company_id, title, status, due_date)
         values ($1,'to-delete-midsweep','in_progress','2026-01-01') returning id`, [CO]);
      await cycle();
      await q(`delete from tasks where id=$1`, [t[0].id]);
      const after = await sweepToCompletion();
      expect(after.summary.status === "completed" || after.summary.status === "partial").toBe(true);
    }, 180_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("equal and out-of-order timestamps", () => {
    it("rows sharing ONE timestamp are all observed — a compound cursor, not a bare one", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "equal-ts"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);

      // 300 tasks, all with the SAME updated_at. A bare timestamp cursor would advance past the
      // whole group after the first page and silently lose the remainder.
      const at = "2026-06-01T00:00:00.000Z";
      const values = Array.from({ length: 300 }, (_, i) =>
        "($1,'equal" + i + "','in_progress','2026-01-01',$2)").join(",");
      await q("insert into tasks (company_id, title, status, due_date, updated_at) values " + values, [co, at]);

      let cycles = 0;
      for (;;) {
        const s = await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
        cycles++;
        if (!s.continuation.some((c) => c.hasMore) || cycles >= 40) break;
      }
      const { rows } = await q(
        `select count(distinct subject_id)::int as n from management_items
          where company_id=$1 and department='operations'`, [co]);
      expect(rows[0].n).toBe(300);
    }, 240_000);

    it("an OUT-OF-ORDER late write is recovered by the overlap window", async () => {
      const { rows: t } = await q(
        `insert into tasks (company_id, title, status, due_date, updated_at)
         values ($1,'late-writer','in_progress','2026-01-01', now() - interval '10 seconds')
         returning id`, [CO]);
      await sweepToCompletion();
      const { rows } = await q(
        `select count(*)::int as n from management_items where company_id=$1 and subject_id=$2`,
        [CO, t[0].id]);
      expect(rows[0].n).toBeGreaterThan(0);
    }, 180_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("failure, retry and idempotency", () => {
    it("a PAGE FAILURE does not advance the cursor, and the retry loses nothing", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "pagefail"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      await seedTasks(50, "pagefail-", co);

      let fail = true;
      const flaky: CycleDeps = {
        ...deps,
        async loadPage(source, companyId, cursor, limit) {
          if (source === OPERATIONS_SOURCE && fail) throw new Error("connection reset");
          return deps.loadPage!(source, companyId, cursor, limit);
        },
      };

      const failed = await runManagementCycle(flaky, { companyId: co, actorId: null, trigger: "test" });
      expect(failed.unobservedDepartments).toContain("operations");
      expect(failed.status).toBe("partial");
      expect(await countItems("operations", co)).toBe(0);

      fail = false;
      let cycles = 0;
      for (;;) {
        const s = await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
        cycles++;
        if (!s.continuation.some((c) => c.hasMore) || cycles >= 20) break;
      }
      expect(await distinctSubjects("operations", co)).toBe(50);
    }, 240_000);

    it("a DUPLICATE page delivery creates no duplicate item", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "dupe"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      await seedTasks(20, "dupe-", co);

      // The SAME page, delivered twice, with the cursor never moving.
      const stuck: CycleDeps = {
        ...deps,
        async loadPage(source, companyId, _cursor, limit) {
          return deps.loadPage!(source, companyId, null, limit);
        },
        async writeCursor() { /* deliberately never commits a position */ },
      };
      await runManagementCycle(stuck, { companyId: co, actorId: null, trigger: "test" });
      await runManagementCycle(stuck, { companyId: co, actorId: null, trigger: "test" });
      await runManagementCycle(stuck, { companyId: co, actorId: null, trigger: "test" });

      // The same page three times over creates no second item for any condition.
      expect(await countItems("operations", co)).toBe(await distinctPairs("operations", co));
    }, 180_000);

    it("a failed CURSOR WRITE does not lose the page's items", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "cursorfail"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      await seedTasks(10, "cursorfail-", co);

      const noCommit: CycleDeps = {
        ...deps,
        async writeCursor() { throw new Error("cursor store unavailable"); },
      };
      const s = await runManagementCycle(noCommit, { companyId: co, actorId: null, trigger: "test" });
      // The items are persisted even though the position could not be committed…
      expect(await distinctSubjects("operations", co)).toBe(10);
      // …and the cycle says so rather than claiming a clean sweep.
      expect(s.status).toBe("partial");
    }, 180_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("cursor integrity", () => {
    it("REFUSES a cursor carrying anything but position", () => {
      for (const bad of [
        { kind: "sweep_by_id", id: "x", customerMessage: "hello" },
        { kind: "sweep_by_id", id: "x", amount: 1000 },
        { kind: "sweep_by_id", id: "x", secret: "token" },
      ]) {
        expect(() => parseCursor(bad)).toThrow(CursorRejected);
      }
    });

    it("REFUSES a malformed or unknown cursor rather than repositioning a sweep", () => {
      expect(() => parseCursor({ kind: "teleport", id: "x" })).toThrow(CursorRejected);
      expect(() => parseCursor({ kind: "keyset_updated", updatedAt: "not a date", id: "x" })).toThrow(CursorRejected);
      expect(() => parseCursor("a string")).toThrow(CursorRejected);
    });

    it("the DATABASE refuses a cursor payload carrying content", async () => {
      await expect(q(
        `insert into observation_source_cursors (company_id, source, cursor)
         values ($1,'x.y', '{"kind":"sweep_by_id","id":"a","body":"customer said hello"}'::jsonb)`,
        [CO],
      )).rejects.toThrow(/cursor state holds POSITION only/);
    });

    it("a TAMPERED cursor restarts the sweep instead of silently skipping to the end", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "tamper"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      await seedTasks(5, "tamper-", co);

      // A cursor whose kind is unreadable. The safe direction is to look again from the start:
      // repositioning to the end would make the whole domain look empty for ever.
      await q(
        `insert into observation_source_cursors (company_id, source, cursor, generation)
         values ($1,$2,'{"kind":"none"}'::jsonb, 3)`, [co, OPERATIONS_SOURCE]);
      await q(
        `update observation_source_cursors set cursor = '{"kind":"sweep_by_id","id":"zzzz"}'::jsonb
          where company_id=$1 and source=$2`, [co, OPERATIONS_SOURCE]);

      let cycles = 0;
      for (;;) {
        const s = await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
        cycles++;
        if (!s.continuation.some((c) => c.hasMore) || cycles >= 20) break;
      }
      // A uuid > 'zzzz' is impossible, so the first sweep sees nothing; the wrap then restarts it.
      expect(await distinctSubjects("operations", co)).toBe(5);
    }, 180_000);

    it("cursor state is COMPANY-SCOPED and never shared", async () => {
      await seedTasks(5, "iso-", CO_OTHER);
      await cycle(CO_OTHER);
      const { rows } = await q(
        `select company_id, source from observation_source_cursors where source = $1 order by company_id`,
        [OPERATIONS_SOURCE]);
      const companies = new Set(rows.map((r) => r.company_id));
      expect(companies.size).toBeGreaterThan(1);
      // Each company's row is its own; none is a shared default.
      for (const r of rows) expect(r.company_id).toBeTruthy();
    }, 180_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("budgets, fairness and generations", () => {
    it("the whole-cycle budget bounds the sweep and says so", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "budget"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      await seedTasks(3000, "budget-", co, false);

      const s = await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
      expect(s.recordsInspected).toBeLessThanOrEqual(CYCLE_ROW_BUDGET + PAGE_SIZE);
      expect(s.status).toBe("partial");
      expect(s.continuation.length).toBeGreaterThan(0);
    }, 240_000);

    it("a rapidly growing source cannot starve the others", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "starve"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      await seedTasks(3000, "starve-", co, false);
      // One expired licence, in a source that would sort after operations without rotation.
      await q(`insert into licences (company_id, name, licence_number, expiry_date, status)
               values ($1,'starved licence',$2, current_date - 30, 'active')`,
        [co, `SL-${randomUUID().slice(0, 8)}`]);

      let sawLegal = false;
      for (let i = 0; i < 8 && !sawLegal; i++) {
        await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
        const { rows } = await q(
          `select count(*)::int as n from management_items where company_id=$1 and department='legal'`, [co]);
        sawLegal = rows[0].n > 0;
      }
      expect(sawLegal, "a huge operations table starved the legal domain").toBe(true);
    }, 300_000);

    it("a completed sweep advances the GENERATION and records a completion time", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "gen"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      await seedTasks(3, "gen-", co);

      await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
      const { rows } = await q(
        `select generation, sweep_complete_at, status, rows_inspected, pages_processed
           from observation_source_cursors where company_id=$1 and source=$2`,
        [co, OPERATIONS_SOURCE]);
      expect(rows[0].generation).toBeGreaterThanOrEqual(1);
      expect(rows[0].sweep_complete_at).toBeTruthy();
      expect(rows[0].status).toBe("complete");
      expect(Number(rows[0].pages_processed)).toBeGreaterThan(0);
    }, 180_000);

    it("a FAILED sweep records no completion time — the flag resolution would gate on", async () => {
      await expect(q(
        `insert into observation_source_cursors (company_id, source, status, sweep_complete_at)
         values ($1,'bad.source','failed', now())`, [CO],
      )).rejects.toThrow(/osc_completion_shape_ck|check constraint/i);
    });

    it("resolutionPermitted is FALSE while any source has more to read", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "resperm"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      await seedTasks(600, "resperm-", co, false);

      const first = await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
      expect(first.continuation.some((c) => c.hasMore)).toBe(true);
      expect(first.resolutionPermitted).toBe(false);
    }, 240_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("the semantic cases, re-tested beyond one page", () => {
    it("an EXPIRED LEGAL RECORD far beyond 500 rows is still found", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "deeplegal"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);

      // 700 healthy licences, and ONE expired two years ago. Under the old 500-row cap it could
      // sit unread for ever; the priority pre-pass should surface it on the FIRST cycle.
      for (let i = 0; i < 700; i += 200) {
        const batch = Math.min(200, 700 - i);
        const values = Array.from({ length: batch }, (_, k) =>
          "($1,'ok" + (i + k) + "','N" + (i + k) + "-" + randomUUID().slice(0, 6) + "', current_date + 400, 'active')").join(",");
        await q("insert into licences (company_id, name, licence_number, expiry_date, status) values " + values, [co]);
      }
      await q(`insert into licences (company_id, name, licence_number, expiry_date, status)
               values ($1,'ancient',$2, current_date - 730, 'active')`,
        [co, `ANC-${randomUUID().slice(0, 8)}`]);

      await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
      const { rows } = await q(
        `select count(*)::int as n from management_items
          where company_id=$1 and department='legal'`, [co]);
      expect(rows[0].n, "the priority pre-pass did not surface the ancient licence").toBeGreaterThan(0);
    }, 300_000);

    it("an OLD UNPAID INVOICE deep in the table is found and is not de-prioritised", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "deepfin"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      const { rows: c } = await q(
        `insert into customers (company_id, name, status) values ($1,'deep','active') returning id`, [co]);

      for (let i = 0; i < 600; i += 200) {
        const batch = Math.min(200, 600 - i);
        const values = Array.from({ length: batch }, (_, k) =>
          "($1,$2,'F" + (i + k) + "-" + randomUUID().slice(0, 6) + "','LKR','2026-01-01', current_date + 90, 1000, 0, 'issued')").join(",");
        await q(
          "insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, due_date, total_amount, amount_settled, status) values " + values,
          [co, c[0].id]);
      }
      const { rows: old } = await q(
        `insert into customer_invoices
           (company_id, customer_id, invoice_number, currency, issue_date, due_date,
            total_amount, amount_settled, status)
         values ($1,$2,$3,'LKR','2024-01-01', current_date - 45, 250000, 0, 'issued') returning id`,
        [co, c[0].id, `OLD-${randomUUID().slice(0, 8)}`]);

      await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
      const { rows } = await q(
        `select priority from management_items where company_id=$1 and subject_id=$2`, [co, old[0].id]);
      expect(rows[0], "the overdue invoice was not surfaced by the priority pre-pass").toBeTruthy();
      expect(rows[0].priority).toBe("high");
    }, 300_000);

    it("an obsolete workforce snapshot never represents current state, however many exist", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "wf"]);
      const u = randomUUID();
      await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [u]);
      await q(`insert into users (id,full_name,is_active) values ($1,'wf',true) on conflict (id) do nothing`, [u]);
      const { rows: m } = await q(
        `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`, [co, u]);
      for (const [weeks, status, util] of [[8, "overloaded", 180], [0, "healthy", 50]] as const) {
        await q(`insert into capacity_snapshots
                   (company_id, membership_id, week_start, total_hours, net_capacity_hours,
                    allocated_hours, available_hours, utilization_pct, status)
                 values ($1,$2,(date_trunc('week', current_date) - interval '${weeks} weeks')::date,
                         40,36,40,0,$3,$4)`, [co, m[0].id, util, status]);
      }
      const page = await deps.loadPage!(WORKFORCE_SOURCE, co, null, PAGE_SIZE);
      const rows = page.rows as Array<{ membershipId: string; status: string }>;
      expect(rows.filter((r) => r.membershipId === m[0].id)).toHaveLength(1);
      expect(rows.find((r) => r.membershipId === m[0].id)!.status).toBe("healthy");
    }, 180_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("isolation, enablement and honest status", () => {
    it("a REVOKED company enablement stops the sweep and writes nothing", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "revoked"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      await seedTasks(5, "revoked-", co);
      await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });

      await q(`update management_kernel_enablement set enabled=false where company_id=$1`, [co]);
      const before = await q(
        `select count(*)::int as n from management_items where company_id=$1`, [co]);
      const s = await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
      const after = await q(
        `select count(*)::int as n from management_items where company_id=$1`, [co]);

      expect(s.status).toBe("skipped_disabled");
      expect(after.rows[0].n).toBe(before.rows[0].n);
    }, 180_000);

    it("one company's sweep never reads or advances another's", async () => {
      const { rows: before } = await q(
        `select cursor, generation from observation_source_cursors
          where company_id=$1 and source=$2`, [CO_OTHER, OPERATIONS_SOURCE]);
      await cycle(CO);
      const { rows: after } = await q(
        `select cursor, generation from observation_source_cursors
          where company_id=$1 and source=$2`, [CO_OTHER, OPERATIONS_SOURCE]);
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    }, 180_000);

    it("a PARTIAL cycle is never presented as all clear", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "honest"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      await seedTasks(600, "honest-", co, false);

      const s = await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
      expect(s.status).toBe("partial");
      expect(s.failureReason).toBeTruthy();
      expect(s.resolutionPermitted).toBe(false);
      expect(s.recordsInspected).toBeGreaterThan(0);
      expect(s.pagesProcessed).toBeGreaterThan(0);
    }, 240_000);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════
  describe("performance shape", () => {
    it("a large sweep issues a BOUNDED number of queries — no N+1", async () => {
      const co = randomUUID();
      await q(`insert into companies (id,name,base_currency) values ($1,$2,'LKR')`, [co, "perf"]);
      await q(`insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
               values ($1,true,$2,now())`, [co, ACTOR]);
      const { rows: c } = await q(
        `insert into customers (company_id, name, status) values ($1,'perf','active') returning id`, [co]);
      for (let i = 0; i < 400; i += 200) {
        const values = Array.from({ length: 200 }, (_, k) =>
          "($1,$2,'P" + (i + k) + "-" + randomUUID().slice(0, 6) + "','LKR','2026-01-01','2026-02-01', 1000, 0, 'issued')").join(",");
        await q(
          "insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, due_date, total_amount, amount_settled, status) values " + values,
          [co, c[0].id]);
      }

      // Count the queries the finance page issues. The payment-allocation companion read must be
      // ONE query for the whole page, not one per invoice — that is the N+1 this guards.
      let queries = 0;
      const counting = pgSupabase({
        query: (sql: string, params?: unknown[]) => { queries++; return raw.query(sql, params); },
      });
      const countingDeps = makeCycleDeps(counting, () => new Date());
      const page = await countingDeps.loadPage!(FINANCE_SOURCE, co, null, PAGE_SIZE);

      expect((page.rows as unknown[]).length).toBe(PAGE_SIZE);
      // One page read + one companion read. A per-row lookup would be 200+.
      expect(queries, `${queries} queries for a ${PAGE_SIZE}-row page`).toBeLessThanOrEqual(4);
    }, 300_000);

    it("a page never materialises the whole table", async () => {
      const page = await deps.loadPage!(OPERATIONS_SOURCE, CO, null, PAGE_SIZE);
      expect((page.rows as unknown[]).length).toBeLessThanOrEqual(PAGE_SIZE);
    }, 120_000);
  });
});
