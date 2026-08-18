/**
 * AIM-002 wiring (migration 0073) — the AI analysis path creates tasks THROUGH the deduplication
 * boundary. Live PostgreSQL.
 *
 * 0071 built the identity and the create-or-return RPC; nothing called it. `create_management_case_atomic`
 * still inserted tasks directly, so the ONE path that creates tasks in production kept duplicating.
 * These scenarios prove the wiring, and — just as importantly — prove what it must NOT do: merge
 * distinct work, rewrite an existing task's history, or turn an oversized model title into a lost
 * analysis.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 12);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let co: string, coOther: string, actor: string;

const CASE = (corr: string) =>
  JSON.stringify({
    correlation_id: corr, source_event_id: "wa:conv", ai_run_id: null,
    confirmed_facts: [], inferred_facts: [], evidence_refs: [], uncertainty: null,
    missing_info: [], confidence: "0.9", required_authority: "none", decisions: [], requires_human: false,
  });

const RPC = `select public.create_management_case_atomic($1,$2,$3::jsonb,$4::jsonb,$5,'manager.thread_analyzed') as v`;

/** One proposed task, exactly as the production paths now shape it. */
const task = (title: string, id: Partial<Record<string, string | null>> = {}, note: string | null = null) => ({
  title, note, requires_evidence: false,
  source_type: "wa_thread",
  source_id: "conv-1",
  purpose: title.trim().toLowerCase().replace(/\s+/g, " "),
  target: null,
  window: "2026-08-18",
  ...id,
});

const run = (company: string, key: string, tasks: unknown[]) =>
  db.query(RPC, [company, key, CASE("cor_" + rnd()), JSON.stringify(tasks), actor]).then((r: any) => r.rows[0].v);

describe.skipIf(!enabled)("0073 — case tasks are created through the AIM-002 dedup boundary (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await db.query(`insert into companies (name, base_currency) values ('dedupwire','LKR') returning id`)).rows[0].id;
    coOther = (await db.query(`insert into companies (name, base_currency) values ('dedupwire2','LKR') returning id`)).rows[0].id;
    actor = randomUUID();
    await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [actor]);
    await db.query(`insert into users (id, full_name, is_active) values ($1,'wire-actor',true) on conflict do nothing`, [actor]);
  });
  afterAll(async () => {
    for (const c of [co, coOther]) {
      for (const sql of [
        `delete from audit_events where company_id=$1`,
        `delete from task_routing_events where company_id=$1`,
        `delete from task_routing where company_id=$1`,
        `delete from tasks where company_id=$1`,
        `delete from management_cases where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [c]); } catch { /* noop */ } }
    }
    await db?.end().catch(() => {});
  });

  it("THE DEFECT: a new case for the SAME conversation does not recreate the same task", async () => {
    // Two analyses of one thread. The transcript grew, so the case idempotency key differs and a
    // second case IS created — that part was never the bug. The task must not be created twice.
    const a = await run(co, "k_" + rnd(), [task("Chase delivery date")]);
    const b = await run(co, "k_" + rnd(), [task("Chase delivery date")]);
    expect(a.case_id).not.toBe(b.case_id);
    expect(a.created_tasks).toBe(1);
    expect(a.deduplicated_tasks).toBe(0);
    expect(b.created_tasks).toBe(0);
    expect(b.deduplicated_tasks).toBe(1);
    const n = (await db.query(
      `select count(*)::int c from tasks where company_id=$1 and task_purpose='chase delivery date'`, [co])).rows[0].c;
    expect(n).toBe(1);
  });

  it("normalisation: differing case and whitespace is the SAME work", async () => {
    await run(co, "k_" + rnd(), [task("Send  the QUOTE")]);
    const b = await run(co, "k_" + rnd(), [task("send the quote", { purpose: "send the quote" })]);
    expect(b.deduplicated_tasks).toBe(1);
    expect(b.created_tasks).toBe(0);
  });

  it("DISTINCT WORK IS NOT MERGED: another conversation with the same purpose is a new task", async () => {
    await run(co, "k_" + rnd(), [task("Confirm payment")]);
    const b = await run(co, "k_" + rnd(), [task("Confirm payment", { source_id: "conv-2" })]);
    expect(b.created_tasks).toBe(1);
    expect(b.deduplicated_tasks).toBe(0);
  });

  it("DISTINCT WORK IS NOT MERGED: a new occurrence window is new work", async () => {
    await run(co, "k_" + rnd(), [task("Daily site report")]);
    const b = await run(co, "k_" + rnd(), [task("Daily site report", { window: "2026-08-19" })]);
    expect(b.created_tasks).toBe(1);
  });

  it("DISTINCT WORK IS NOT MERGED: the same identity in another company is a different task", async () => {
    await run(co, "k_" + rnd(), [task("Cross company purpose")]);
    const b = await run(coOther, "k_" + rnd(), [task("Cross company purpose")]);
    expect(b.created_tasks).toBe(1);
    const n = (await db.query(
      `select count(*)::int c from tasks where task_purpose='cross company purpose'`)).rows[0].c;
    expect(n).toBe(2);
  });

  it("a deduplicated task keeps its ORIGINAL case link and description — history is not rewritten", async () => {
    const a = await run(co, "k_" + rnd(), [task("Order spare parts", {}, "first note")]);
    const b = await run(co, "k_" + rnd(), [task("Order spare parts", {}, "second, later note")]);
    expect(b.deduplicated_tasks).toBe(1);
    const t = (await db.query(
      `select description, management_case_id from tasks where company_id=$1 and task_purpose='order spare parts'`, [co])).rows;
    expect(t.length).toBe(1);
    expect(t[0].description).toBe("first note");
    expect(t[0].management_case_id).toBe(a.case_id);
  });

  it("two identical proposals inside ONE case create one task — not a rollback", async () => {
    const r = await run(co, "k_" + rnd(), [task("Duplicate within case"), task("Duplicate within case")]);
    expect(r.created_tasks).toBe(1);
    expect(r.deduplicated_tasks).toBe(1);
    const n = (await db.query(
      `select count(*)::int c from tasks where company_id=$1 and task_purpose='duplicate within case'`, [co])).rows[0].c;
    expect(n).toBe(1);
  });

  it("BACKWARD COMPATIBLE: a task with no identity keys is still created and never deduplicated", async () => {
    const t = { title: "Legacy shaped task", note: "n", requires_evidence: false };
    const a = await run(co, "k_" + rnd(), [t]);
    const b = await run(co, "k_" + rnd(), [t]);
    expect(a.created_tasks).toBe(1);
    expect(b.created_tasks).toBe(1);
    expect(b.deduplicated_tasks).toBe(0);
    const rows = (await db.query(
      `select identity_hash from tasks where company_id=$1 and title='Legacy shaped task'`, [co])).rows;
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.identity_hash).toBeNull();
  });

  it("an oversized identity component is TRUNCATED, not a rolled-back analysis", async () => {
    const long = "x".repeat(4000);
    const r = await run(co, "k_" + rnd(), [task("Long purpose task", { purpose: long, source_id: long })]);
    expect(r.created_tasks).toBe(1);
    const row = (await db.query(
      `select task_purpose, source_id from tasks where company_id=$1 and title='Long purpose task'`, [co])).rows[0];
    expect(row.task_purpose.length).toBe(256);
    expect(row.source_id.length).toBe(512);
  });

  it("the audit event and the case row both record what was deduplicated", async () => {
    await run(co, "k_" + rnd(), [task("Audited purpose")]);
    const key = "k_" + rnd();
    const b = await run(co, key, [task("Audited purpose")]);
    const cse = (await db.query(`select created_tasks, deduplicated_tasks from management_cases where id=$1`, [b.case_id])).rows[0];
    expect(cse.created_tasks).toBe(0);
    expect(cse.deduplicated_tasks).toBe(1);
    const ev = (await db.query(
      `select payload from audit_events where entity_id=$1 and action='manager.thread_analyzed'`, [b.case_id])).rows[0];
    expect(ev.payload.deduplicated_tasks).toBe(1);
    // The idempotent REPLAY path reports the same numbers rather than zero.
    const replay = await run(co, key, [task("Audited purpose")]);
    expect(replay.duplicate).toBe(true);
    expect(replay.case_id).toBe(b.case_id);
    expect(replay.deduplicated_tasks).toBe(1);
  });

  it("a cancelled task does not block the same work being raised again", async () => {
    await run(co, "k_" + rnd(), [task("Reraise after cancel")]);
    await db.query(`update tasks set status='cancelled' where company_id=$1 and task_purpose='reraise after cancel'`, [co]);
    const b = await run(co, "k_" + rnd(), [task("Reraise after cancel")]);
    expect(b.created_tasks).toBe(1);
  });

  it("the whole case still rolls back on an invalid task — atomicity is not weakened", async () => {
    const before = (await db.query(`select count(*)::int c from management_cases where company_id=$1`, [co])).rows[0].c;
    await expect(run(co, "k_" + rnd(), [task("Valid one"), { title: "   ", note: null }])).rejects.toThrow();
    const after = (await db.query(`select count(*)::int c from management_cases where company_id=$1`, [co])).rows[0].c;
    expect(after).toBe(before);
    const n = (await db.query(`select count(*)::int c from tasks where company_id=$1 and task_purpose='valid one'`, [co])).rows[0].c;
    expect(n).toBe(0);
  });

  it("the boundary is still service-only: an authenticated caller is refused 42501", async () => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: actor, role: "authenticated" })]);
      await expect(db.query(RPC, [co, "k_" + rnd(), CASE("x"), JSON.stringify([task("Nope")]), actor]))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });
});
