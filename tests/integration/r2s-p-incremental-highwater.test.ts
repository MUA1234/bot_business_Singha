/**
 * R2S-P — the incremental lane keeps its HIGH-WATER MARK once it catches up.
 *
 * The incremental keyset lane exists to notice recent changes quickly. Forward reconciliation and
 * the recovery rescan own eventual historical coverage; this lane does not.
 *
 * A short page means "nothing newer right now", and `nextCursorFrom` answered null — correct for a
 * type-3 sweep, whose design is to wrap and start again, and wrong for a keyset lane. Committing
 * that null made the next cycle read from the OLDEST rows. On any table larger than one page the
 * lane then spent its whole budget re-reading history, and a change made moments ago — which sorts
 * LAST in (updated_at, id) — waited behind every one of those pages.
 *
 * These tests measure that behaviour rather than assuming it, in rows and queries rather than
 * milliseconds, and they hold the line on what must NOT change: backdated rows stay reconciliation's
 * responsibility, and a deleted high-water row must not wedge progress.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";
import { PAGE_SIZE, reconcileSourceKey } from "@/kernel/pagination";
import { OVERLAP_RESCAN } from "@/kernel/source-queries";
import { OPERATIONS_SOURCE } from "@/kernel/adapters";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);
const ACTOR = randomUUID();

let raw: pg.Client;
let deps: CycleDeps;
let savedFlag: string | undefined;

let taskReads = 0;
let counting = false;

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

/** Tasks that raise nothing, so the measurement is of SCANNING rather than item creation. */
async function addQuietTasks(co: string, n: number, prefix: string) {
  for (let i = 0; i < n; i += 250) {
    const batch = Math.min(250, n - i);
    const values = Array.from({ length: batch }, (_, k) =>
      `($1,'${prefix}${i + k}','in_progress','2099-01-01')`).join(",");
    await q(`insert into tasks (company_id, title, status, due_date) values ` + values, [co]);
  }
}

/** The incremental lane's stored position. */
async function incrementalCursor(co: string) {
  const { rows } = await q(
    `select cursor from observation_source_cursors where company_id=$1 and source=$2`,
    [co, OPERATIONS_SOURCE]);
  return (rows[0]?.cursor ?? null) as { kind?: string; updatedAt?: string; id?: string } | null;
}

/**
 * Deps that count rows returned to the INCREMENTAL lane only.
 *
 * `summary.recordsInspected` is every lane added together, and the reconciliation lanes are
 * SUPPOSED to read their reserved 100 + 50 rows on every cycle — that guarantee is the whole
 * point of the reserve. Measuring the total would therefore report the reserve working as if
 * it were the incremental lane misbehaving, which is the mistake this wrapper removes.
 */
function countingIncremental(source: string) {
  const counter = { rows: 0, pages: 0 };
  const d: CycleDeps = {
    ...deps,
    async loadPage(req) {
      const page = await deps.loadPage!(req);
      if (req.source === source) {
        counter.rows += (page.rows as unknown[]).length;
        counter.pages += 1;
      }
      return page;
    },
  };
  return { deps: d, counter };
}

/** Run cycles until the incremental lane reports nothing more. */
async function catchUp(co: string, max = 20) {
  for (let i = 1; i <= max; i++) {
    const s = await cycle(co);
    const c = s.continuation.find((x) => x.source === OPERATIONS_SOURCE);
    if (c && !c.hasMore) return i;
  }
  return max;
}

describe.skipIf(!enabled)("R2S-P — the incremental lane parks at its high-water mark", () => {
  beforeAll(async () => {
    savedFlag = process.env.MANAGEMENT_KERNEL;
    process.env.MANAGEMENT_KERNEL = "on";
    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();

    const original = raw.query.bind(raw);
    // eslint-disable-next-line
    (raw as any).query = (...args: any[]) => {
      if (counting) {
        const sql = typeof args[0] === "string" ? args[0] : String(args[0]?.text ?? "");
        const s = sql.trim().toLowerCase();
        if (s.startsWith("select") && s.includes("from \"tasks\"")) taskReads++;
      }
      // eslint-disable-next-line
      return (original as any)(...args);
    };

    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [ACTOR]);
    await q(`insert into users (id,full_name,is_active) values ($1,'highwater actor',true)
             on conflict (id) do nothing`, [ACTOR]);
    deps = makeCycleDeps(pgSupabase(raw), () => new Date());
  }, 180_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
    else process.env.MANAGEMENT_KERNEL = savedFlag;
    await raw?.end();
  });

  it("a caught-up source KEEPS a position rather than clearing it", async () => {
    // Larger than one incremental page, so catching up takes several cycles and the question is
    // real rather than degenerate.
    const co = await freshCompany("hw-keeps");
    await addQuietTasks(co, PAGE_SIZE * 3, "keep-");
    const cycles = await catchUp(co);
    expect(cycles).toBeGreaterThan(1);

    const cursor = await incrementalCursor(co);
    expect(cursor, "the caught-up lane cleared its position").toBeTruthy();
    expect(cursor!.kind).toBe("keyset_updated");
    expect(cursor!.updatedAt, "the high-water timestamp was not kept").toBeTruthy();
    expect(cursor!.id, "the high-water id was not kept").toBeTruthy();
  }, 600_000);

  it("the next quiet cycle does NOT re-read the table head", async () => {
    const co = await freshCompany("hw-quiet");
    await addQuietTasks(co, PAGE_SIZE * 3, "quiet-");
    await catchUp(co);

    // Nothing has changed. A lane holding its mark reads almost nothing; one that rewound
    // reads a full page of the OLDEST rows — so the incremental lane's own count is measured,
    // not the cycle total, which legitimately includes the reconciliation reserve.
    const { deps: counted, counter } = countingIncremental(OPERATIONS_SOURCE);

    await cycle(co, counted);
    const firstQuiet = counter.rows;
    await cycle(co, counted);
    const secondQuiet = counter.rows - firstQuiet;

    // A rewound lane would return a full page each time. Only the bounded overlap re-scan
    // may appear here, and it is far smaller than a page.
    expect(firstQuiet, `quiet cycle read ${firstQuiet} rows from the head`)
      .toBeLessThan(PAGE_SIZE / 2);
    expect(secondQuiet, `second quiet cycle read ${secondQuiet} rows from the head`)
      .toBeLessThan(PAGE_SIZE / 2);
  }, 600_000);

  it("repeated caught-up cycles stay BOUNDED in rows and queries", async () => {
    const co = await freshCompany("hw-bounded");
    await addQuietTasks(co, PAGE_SIZE * 3, "bounded-");
    await catchUp(co);

    const { deps: counted, counter } = countingIncremental(OPERATIONS_SOURCE);
    taskReads = 0;
    counting = true;
    for (let i = 0; i < 5; i++) await cycle(co, counted);
    counting = false;

    // Five quiet cycles over a 600-row table.
    //
    // A REWOUND lane re-reads a full page from the oldest end every cycle: 5 × PAGE_SIZE.
    // A PARKED lane reads only the bounded late-writer look-back: 5 × OVERLAP_RESCAN. The
    // measured figure must sit at the parked bound, not merely below the rewound one — the
    // first draft of this assertion used PAGE_SIZE and would have passed at 199 rows a cycle,
    // which is a head scan by any other name.
    const parkedBound = 5 * OVERLAP_RESCAN;
    const rewoundCost = 5 * PAGE_SIZE;
    expect(counter.rows,
      `incremental lane read ${counter.rows} rows across 5 quiet cycles; ` +
      `parked bound ${parkedBound}, rewound would be ${rewoundCost}`)
      .toBeLessThanOrEqual(parkedBound);
    // Queries stay bounded too: the reconciliation lanes each take one page per cycle, so the
    // total is a small constant rather than a function of table size.
    expect(taskReads, `${taskReads} task reads across 5 quiet cycles`).toBeLessThan(80);
  }, 600_000);

  it("an UPDATE to an old row is seen on the next cycle, not behind the whole table", async () => {
    const co = await freshCompany("hw-update");
    await addQuietTasks(co, PAGE_SIZE * 3, "upd-");
    await catchUp(co);

    // The oldest row in the table, edited now. Its new updated_at sorts LAST, so a lane holding
    // its mark sees it immediately — and a lane that rewound would reach it only after paging
    // through every older row first.
    const { rows: oldest } = await q(
      `select id from tasks where company_id=$1 order by updated_at asc, id asc limit 1`, [co]);
    const id = oldest[0].id;
    await q(`update tasks set status='blocked', due_date='2026-01-01', updated_at=now() where id=$1`, [id]);

    const s = await cycle(co);
    const { rows } = await q(
      `select count(*)::int as n from management_items where company_id=$1 and subject_id=$2`,
      [co, id]);
    expect(rows[0].n, `not seen on the next cycle; inspected=${s.recordsInspected}`)
      .toBeGreaterThan(0);
  }, 600_000);

  it("a NEW current row is seen on the next cycle", async () => {
    const co = await freshCompany("hw-insert");
    await addQuietTasks(co, PAGE_SIZE * 3, "ins-");
    await catchUp(co);

    const { rows: made } = await q(
      `insert into tasks (company_id, title, status, due_date)
       values ($1,'fresh-work','in_progress','2026-01-01') returning id`, [co]);
    const id = made[0].id;

    await cycle(co);
    const { rows } = await q(
      `select count(*)::int as n from management_items where company_id=$1 and subject_id=$2`,
      [co, id]);
    expect(rows[0].n, "a newly inserted current row was not seen promptly").toBeGreaterThan(0);
  }, 600_000);

  it("a BACKDATED row is not this lane's job — reconciliation finds it", async () => {
    const co = await freshCompany("hw-backdated");
    await addQuietTasks(co, PAGE_SIZE * 2, "back-");
    await catchUp(co);

    const { rows: made } = await q(
      `insert into tasks (company_id, title, status, due_date, created_at, updated_at)
       values ($1,'historical','in_progress','2026-01-01',
               now() - interval '400 days', now() - interval '400 days') returning id`, [co]);
    const id = made[0].id;

    // Behind the high-water mark, so the incremental lane will not return it. That is correct:
    // this is precisely the case the reconciliation lanes exist for, and they do find it.
    let found = 0;
    for (let i = 1; i <= 30; i++) {
      await cycle(co);
      const { rows } = await q(
        `select count(*)::int as n from management_items where company_id=$1 and subject_id=$2`,
        [co, id]);
      if (rows[0].n > 0) { found = i; break; }
    }
    expect(found, "reconciliation never recovered the backdated row").toBeGreaterThan(0);
  }, 900_000);

  it("DELETING the row that established the mark does not wedge progress", async () => {
    const co = await freshCompany("hw-delete");
    await addQuietTasks(co, PAGE_SIZE * 2, "del-");
    await catchUp(co);

    const cursor = await incrementalCursor(co);
    expect(cursor?.id).toBeTruthy();
    // The cursor is a VALUE pair, not a reference to a row, so removing that row leaves the
    // boundary perfectly usable.
    await q(`delete from tasks where id=$1`, [cursor!.id]);

    const { rows: made } = await q(
      `insert into tasks (company_id, title, status, due_date)
       values ($1,'after-delete','in_progress','2026-01-01') returning id`, [co]);
    const s = await cycle(co);
    expect(s.sourcesFailed).toBe(0);
    const { rows } = await q(
      `select count(*)::int as n from management_items where company_id=$1 and subject_id=$2`,
      [co, made[0].id]);
    expect(rows[0].n, "progress wedged after the high-water row was deleted").toBeGreaterThan(0);
  }, 600_000);

  it("SUSTAINED writes cannot starve recent work behind history", async () => {
    const co = await freshCompany("hw-sustained");
    await addQuietTasks(co, PAGE_SIZE * 4, "sust-");
    await catchUp(co);

    // Ordinary traffic, every cycle, on a table four pages deep. The newest row must still be
    // seen on the following cycle — not after a full traversal of the table.
    for (let i = 0; i < 4; i++) {
      await addQuietTasks(co, 50, `sust-more${i}-`);
      const { rows: made } = await q(
        `insert into tasks (company_id, title, status, due_date)
         values ($1,$2,'in_progress','2026-01-01') returning id`, [co, `urgent-${i}`]);
      await cycle(co);
      const { rows } = await q(
        `select count(*)::int as n from management_items where company_id=$1 and subject_id=$2`,
        [co, made[0].id]);
      expect(rows[0].n, `urgent-${i} waited behind history`).toBeGreaterThan(0);
    }
  }, 900_000);

  it("the exact TIMESTAMP precision of the mark survives being parked", async () => {
    const co = await freshCompany("hw-precision");
    await addQuietTasks(co, 20, "prec-");
    await catchUp(co);

    const cursor = await incrementalCursor(co);
    const { rows } = await q(
      `select updated_at::text as t from tasks where id=$1`, [cursor!.id]);
    // The stored boundary is the row's timestamp verbatim — microseconds included. Rounding it
    // was R2S-P-F-002, and parking must not reintroduce it.
    expect(cursor!.updatedAt).toBe(rows[0].t);
  }, 300_000);

  it("forward reconciliation still wraps and restarts — parking is keyset-only", async () => {
    const co = await freshCompany("hw-forward-unchanged");
    await addQuietTasks(co, 60, "fwd-");
    for (let i = 0; i < 6; i++) await cycle(co);

    const { rows } = await q(
      `select cursor, generation from observation_source_cursors where company_id=$1 and source=$2`,
      [co, reconcileSourceKey(OPERATIONS_SOURCE)]);
    // The type-3 sweep's wrap is its whole design and must be untouched by this change: on
    // completing a pass it returns to the start of the table with a new generation.
    expect(Number(rows[0]?.generation ?? 0)).toBeGreaterThanOrEqual(1);
  }, 600_000);
});
