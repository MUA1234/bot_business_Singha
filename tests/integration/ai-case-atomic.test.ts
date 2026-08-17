/**
 * Completion P1B — the atomic, idempotent AI-manager case boundary (migration 0068,
 * `create_management_case_atomic`). Live PostgreSQL, real roles, two-connection concurrency.
 *
 * Invariants proven here:
 *   - one transaction creates the case + ALL its captured tasks + the audit event;
 *   - any invalid task rolls the WHOLE case back (no partial persistence);
 *   - replaying the same (company, idempotency_key) returns the ORIGINAL result, creating nothing;
 *   - two IDENTICAL CONCURRENT submissions produce exactly one logical case/task set;
 *   - the AI cannot smuggle a non-`captured` task status through this boundary;
 *   - hostile roles (authenticated, anon, no-claims service_role) are refused 42501.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 12);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, cA: any, cB: any;
let co: string, actor: string;

const CASE = (corr: string) =>
  JSON.stringify({
    correlation_id: corr,
    source_event_id: "manual",
    ai_run_id: null,
    confirmed_facts: ["fact"],
    inferred_facts: [],
    evidence_refs: [],
    uncertainty: null,
    missing_info: [],
    confidence: "0.9",
    required_authority: "none",
    decisions: [],
    requires_human: false,
  });
const TASKS = JSON.stringify([
  { title: "Follow up supplier", note: "n1", requires_evidence: false },
  { title: "Check delivery", note: "n2", requires_evidence: true },
]);
const RPC = `select public.create_management_case_atomic($1,$2,$3::jsonb,$4::jsonb,$5,'manager.analyzed') as v`;

describe.skipIf(!enabled)("0068 atomic AI case persistence (live, two connections)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) }); await c.connect(); return c; };
    setup = await mk(); cA = await mk(); cB = await mk();
    for (const c of [setup, cA, cB]) await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await setup.query(`insert into companies (name, base_currency) values ('aicase','LKR') returning id`)).rows[0].id;
    actor = randomUUID();
    await setup.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [actor]);
    await setup.query(`insert into users (id, full_name, is_active) values ($1,'ai-actor',true) on conflict do nothing`, [actor]);
  });
  afterAll(async () => {
    for (const sql of [
      `delete from audit_events where company_id=$1`,
      `delete from tasks where company_id=$1`,
      `delete from management_cases where company_id=$1`,
      `delete from companies where id=$1`,
    ]) { try { await setup.query(sql, [co]); } catch { /* noop */ } }
    await Promise.all([cA?.end(), cB?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("creates the case, all tasks (forced `captured`), and the audit event in one call", async () => {
    const key = "k_" + rnd();
    const r = (await cA.query(RPC, [co, key, CASE("cor_a"), TASKS, actor])).rows[0].v;
    expect(r.duplicate).toBe(false);
    expect(r.created_tasks).toBe(2);
    const tasks = (await setup.query(`select title, status, management_case_id from tasks where management_case_id=$1 order by title`, [r.case_id])).rows;
    expect(tasks.length).toBe(2);
    for (const t of tasks) expect(t.status).toBe("captured");
    const cse = (await setup.query(`select created_tasks, idempotency_key from management_cases where id=$1`, [r.case_id])).rows[0];
    expect(cse.created_tasks).toBe(2);
    expect(cse.idempotency_key).toBe(key);
    const audit = (await setup.query(`select count(*)::int c from audit_events where company_id=$1 and action='manager.analyzed' and entity_id=$2`, [co, r.case_id])).rows[0].c;
    expect(audit).toBe(1);
  });

  it("replaying the same identity returns the ORIGINAL result and creates nothing", async () => {
    const key = "k_" + rnd();
    const first = (await cA.query(RPC, [co, key, CASE("cor_b"), TASKS, actor])).rows[0].v;
    const again = (await cA.query(RPC, [co, key, CASE("cor_b"), TASKS, actor])).rows[0].v;
    expect(again.duplicate).toBe(true);
    expect(again.case_id).toBe(first.case_id);
    expect(again.created_tasks).toBe(2);
    const cases = (await setup.query(`select count(*)::int c from management_cases where company_id=$1 and idempotency_key=$2`, [co, key])).rows[0].c;
    expect(cases).toBe(1);
    const tasks = (await setup.query(`select count(*)::int c from tasks where management_case_id=$1`, [first.case_id])).rows[0].c;
    expect(tasks).toBe(2);
  });

  it("two IDENTICAL CONCURRENT submissions → exactly one logical case/task set", async () => {
    const key = "k_" + rnd();
    await cA.query("begin");
    const rA = (await cA.query(RPC, [co, key, CASE("cor_c"), TASKS, actor])).rows[0].v; // holds the unique-index claim
    expect(rA.duplicate).toBe(false);
    await cB.query("begin");
    const pB = cB.query(RPC, [co, key, CASE("cor_c"), TASKS, actor]); // blocks on the speculative insert
    await cA.query("commit");
    const rB = (await pB).rows[0].v;
    await cB.query("commit");
    expect(rB.duplicate).toBe(true);
    expect(rB.case_id).toBe(rA.case_id);
    const cases = (await setup.query(`select count(*)::int c from management_cases where company_id=$1 and idempotency_key=$2`, [co, key])).rows[0].c;
    expect(cases).toBe(1);
    const tasks = (await setup.query(`select count(*)::int c from tasks where management_case_id=$1`, [rA.case_id])).rows[0].c;
    expect(tasks).toBe(2);
    const audit = (await setup.query(`select count(*)::int c from audit_events where company_id=$1 and entity_id=$2`, [co, rA.case_id])).rows[0].c;
    expect(audit).toBe(1);
  });

  it("an invalid task rolls back the ENTIRE case (no partial persistence)", async () => {
    const key = "k_" + rnd();
    const badTasks = JSON.stringify([{ title: "ok task" }, { title: "   " }]); // second title empty
    let code: string | undefined, msg = "";
    try { await cA.query(RPC, [co, key, CASE("cor_d"), badTasks, actor]); }
    catch (e) { code = (e as { code?: string }).code; msg = (e as Error).message; }
    expect(msg).toMatch(/empty title/i);
    expect(code).toBeDefined();
    const cases = (await setup.query(`select count(*)::int c from management_cases where company_id=$1 and idempotency_key=$2`, [co, key])).rows[0].c;
    expect(cases).toBe(0); // the case did NOT survive
    // and the identity is reusable after the failure (nothing half-claimed)
    const retry = (await cA.query(RPC, [co, key, CASE("cor_d"), JSON.stringify([{ title: "ok task" }]), actor])).rows[0].v;
    expect(retry.duplicate).toBe(false);
    expect(retry.created_tasks).toBe(1);
  });

  it("the AI cannot smuggle a non-captured status or more than 20 tasks", async () => {
    const key = "k_" + rnd();
    const sneaky = JSON.stringify([{ title: "escalate me", status: "completed" }]);
    const r = (await cA.query(RPC, [co, key, CASE("cor_e"), sneaky, actor])).rows[0].v;
    const st = (await setup.query(`select status from tasks where management_case_id=$1`, [r.case_id])).rows[0].status;
    expect(st).toBe("captured"); // requested status ignored
    const many = JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ title: `t${i}` })));
    let msg = "";
    try { await cA.query(RPC, [co, "k_" + rnd(), CASE("cor_f"), many, actor]); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/at most 20/i);
  });

  it("hostile roles are refused 42501: authenticated, anon, and a no-claims service_role", async () => {
    const { default: pg } = await import("pg" as string);
    const cC = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await cC.connect(); // never sets request.jwt.claims
    try {
      for (const role of ["authenticated", "anon"]) {
        await cC.query("begin");
        await cC.query(`set local role ${role}`);
        let code: string | undefined;
        try { await cC.query(RPC, [co, "k_" + rnd(), CASE("cor_g"), TASKS, actor]); }
        catch (e) { code = (e as { code?: string }).code; }
        await cC.query("rollback");
        expect(code, `${role} must be refused`).toBe("42501");
      }
      // raw service_role WITHOUT claims: EXECUTE is granted, but the in-function gate fails closed
      await cC.query("begin");
      await cC.query(`set local role service_role`);
      let code: string | undefined;
      try { await cC.query(RPC, [co, "k_" + rnd(), CASE("cor_h"), TASKS, actor]); }
      catch (e) { code = (e as { code?: string }).code; }
      await cC.query("rollback");
      expect(code).toBe("42501");
    } finally {
      await cC.end().catch(() => {});
    }
  });
});
