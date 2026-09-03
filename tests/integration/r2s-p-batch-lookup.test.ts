/**
 * R2S-P — identity lookups grow in BOUNDED CHUNKS, not one query per observation.
 *
 * Measured cause of the loader-contract timeouts, in one management cycle over a 400-row fixture:
 *
 *     total statements                2,074
 *       RPC signature introspection     866   (42%, a test-shim artifact — now cached)
 *       per-observation identity        494   (24%, the N+1 — batched here)
 *
 * The dual-lane reconciliation itself accounted for +266 statements. It was not the cause; it
 * pushed two pre-existing inefficiencies past the 30-second line.
 *
 * These assertions count QUERIES rather than milliseconds. A wall-clock threshold on a shared
 * machine proves very little and fails for unrelated reasons; a query count is exact, and it is
 * the thing that actually regressed.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps, IDENTITY_LOOKUP_CHUNK } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);
const ACTOR = randomUUID();

let raw: pg.Client;
let deps: CycleDeps;
let savedFlag: string | undefined;

/** Counts identity-lookup statements only. */
let identityQueries = 0;
let counting = false;

const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);

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
      `($1,'${prefix}${i + k}','in_progress','2026-01-01')`).join(",");
    await q(`insert into tasks (company_id, title, status, due_date) values ` + values, [co]);
  }
}

describe.skipIf(!enabled)("R2S-P — bounded identity lookups", () => {
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
        if (s.startsWith("select") && s.includes("management_items") && s.includes("identity_key")) {
          identityQueries++;
        }
      }
      // eslint-disable-next-line
      return (original as any)(...args);
    };

    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    await q(`insert into auth.users (id) values ($1) on conflict do nothing`, [ACTOR]);
    await q(`insert into users (id,full_name,is_active) values ($1,'batch actor',true)
             on conflict (id) do nothing`, [ACTOR]);
    deps = makeCycleDeps(pgSupabase(raw), () => new Date());
  }, 180_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
    else process.env.MANAGEMENT_KERNEL = savedFlag;
    await raw?.end();
  });

  it("a page of hundreds of observations costs a HANDFUL of lookups, not hundreds", async () => {
    const co = await freshCompany("batch-count");
    await addTasks(co, 300, "batch-");

    identityQueries = 0;
    counting = true;
    const s = await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
    counting = false;

    // Every overdue task without an estimate raises two conditions, so one cycle carries many
    // hundreds of identity keys.
    const observations = s.itemsCreated + s.itemsReused + s.observationsSkipped;
    expect(observations).toBeGreaterThan(200);

    // The bound: one query per chunk, per source that produced observations — NOT one per
    // observation. Generous on the source count, exact on the growth rate.
    const chunksNeeded = Math.ceil(observations / IDENTITY_LOOKUP_CHUNK);
    expect(identityQueries,
      `${identityQueries} lookups for ${observations} observations`)
      .toBeLessThanOrEqual(chunksNeeded + 12);
    // And decisively fewer than the one-per-observation pattern it replaced.
    expect(identityQueries).toBeLessThan(observations / 4);
  }, 600_000);

  it("scales by CHUNKS: doubling the rows does not double the lookups", async () => {
    const small = await freshCompany("batch-small");
    await addTasks(small, 100, "small-");
    identityQueries = 0;
    counting = true;
    await runManagementCycle(deps, { companyId: small, actorId: null, trigger: "test" });
    counting = false;
    const forSmall = identityQueries;

    const large = await freshCompany("batch-large");
    await addTasks(large, 400, "large-");
    identityQueries = 0;
    counting = true;
    await runManagementCycle(deps, { companyId: large, actorId: null, trigger: "test" });
    counting = false;
    const forLarge = identityQueries;

    // Four times the rows must not mean four times the queries. Under the old pattern it did,
    // exactly and linearly.
    expect(forLarge, `${forSmall} -> ${forLarge}`).toBeLessThan(forSmall * 3);
  }, 600_000);

  it("returns an EXACT mapping, and never invents an absence", async () => {
    const co = await freshCompany("batch-exact");
    await addTasks(co, 5, "exact-");
    await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });

    const { rows } = await q(
      `select identity_key from management_items where company_id=$1 limit 3`, [co]);
    const known = rows.map((r: { identity_key: string }) => r.identity_key);
    expect(known.length).toBeGreaterThan(0);

    const absent = `never-existed-${randomUUID()}`;
    const found = await deps.findExistingByIdentities!({
      companyId: co,
      // Duplicates and a missing key, deliberately.
      identityKeys: [...known, ...known, absent],
    });

    for (const k of known) expect(found.get(k), `${k} was not found`).toBeTruthy();
    expect(found.has(absent), "a key with no item was reported as present").toBe(false);
    expect(found.size).toBe(new Set(known).size);
  }, 300_000);

  it("never returns another COMPANY's item, whatever the key", async () => {
    const a = await freshCompany("batch-iso-a");
    const b = await freshCompany("batch-iso-b");
    await addTasks(a, 5, "iso-a-");
    await runManagementCycle(deps, { companyId: a, actorId: null, trigger: "test" });

    const { rows } = await q(
      `select identity_key from management_items where company_id=$1`, [a]);
    const aKeys = rows.map((r: { identity_key: string }) => r.identity_key);
    expect(aKeys.length).toBeGreaterThan(0);

    // A's keys, asked for in B's name. Company scope is on every chunk, so the answer is empty
    // — the mapping cannot be used to learn that another company holds something.
    const found = await deps.findExistingByIdentities!({ companyId: b, identityKeys: aKeys });
    expect(found.size, "a foreign item leaked through the identity mapping").toBe(0);
  }, 300_000);

  it("an EMPTY page asks nothing at all", async () => {
    const co = await freshCompany("batch-empty");
    identityQueries = 0;
    counting = true;
    const found = await deps.findExistingByIdentities!({ companyId: co, identityKeys: [] });
    counting = false;
    expect(found.size).toBe(0);
    expect(identityQueries).toBe(0);
  }, 120_000);

  it("a FAILED lookup is never read as 'nothing exists'", async () => {
    // The dangerous failure mode: treating an unreadable lookup as an empty result would create
    // a second item for every condition already open, silently doubling the queue.
    const co = await freshCompany("batch-fail");
    await addTasks(co, 20, "fail-");
    await runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" });
    const { rows: before } = await q(
      `select count(*)::int as n from management_items where company_id=$1`, [co]);

    const broken: CycleDeps = {
      ...deps,
      async findExistingByIdentities() {
        throw new Error("identity lookup failed");
      },
    };
    const s = await runManagementCycle(broken, { companyId: co, actorId: null, trigger: "test" });

    // The source fails loudly, and NOT ONE duplicate item is created.
    expect(s.sourcesFailed).toBeGreaterThan(0);
    expect(s.status).not.toBe("completed");
    const { rows: after } = await q(
      `select count(*)::int as n from management_items where company_id=$1`, [co]);
    expect(after[0].n, "a failed lookup created duplicate items").toBe(before[0].n);
  }, 300_000);

  it("the atomic create RPC remains the final authority on concurrency", async () => {
    // The batch answers "what existed a moment ago". Between the lookup and the write another
    // cycle may create the same item — so the database, not the mapping, has the last word.
    const co = await freshCompany("batch-concurrent");
    await addTasks(co, 30, "conc-");

    const other = new pg.Client({ connectionString: URL, ssl: false });
    await other.connect();
    await other.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    try {
      const otherDeps = makeCycleDeps(pgSupabase(other), () => new Date());
      await Promise.all([
        runManagementCycle(deps, { companyId: co, actorId: null, trigger: "test" }),
        runManagementCycle(otherDeps, { companyId: co, actorId: null, trigger: "test" }),
      ]);
      const { rows } = await q(
        `select count(*)::int as items, count(distinct (subject_id, kind))::int as pairs
           from management_items where company_id=$1`, [co]);
      expect(rows[0].items, "a duplicate survived the race").toBe(rows[0].pairs);
    } finally {
      await other.end();
    }
  }, 300_000);
});
