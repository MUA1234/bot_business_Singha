/**
 * AIM-003 — durable routing state, against a disposable local PostgreSQL.
 *
 * The defect: AI-captured tasks routed to nobody. `requires_human` was read only by a badge, the
 * follow-ups cron selects only tasks that already have an assignee, and the Analyze screen claimed
 * "routed for human approval" when no record existed. A UI string is not routing.
 *
 * The property under test: a routing STATE is durable, its destination is real, a model-proposed
 * assignee is untrusted input revalidated at the transaction boundary, and every transition is
 * audited — including refusals.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any, cA: any, cB: any, authed: any;
let coA: string, coB: string;
let alice: string, bob: string, outsider: string, inactive: string;

/**
 * Since migration 0078 there is no `route_task`: provenance comes from WHICH function is called, so
 * a machine decision goes through route_task_as_ai / route_task_as_system and cannot describe
 * itself as a person. These scenarios are all machine decisions.
 */
const AI = `select * from route_task_as_ai($1,$2,$3,$4,$5,null,null,$6,$7::jsonb,$8,$9,$10,$11)`;
const SYSTEM = `select * from route_task_as_system($1,$2,$3,$4,$5,null,$6,$7::jsonb,$8,$9,$10,$11)`;
const route = (c: any, o: Record<string, any>) =>
  c.query(o.actorSource === "ai" ? AI : SYSTEM, [
    o.company, o.task, o.state, o.reason ?? "test", o.component ?? "task-routing-test",
    o.capability ?? null, JSON.stringify(o.proposed ?? []), o.assignee ?? null, o.queue ?? null,
    o.approval ?? null, o.submitter ?? null,
  ]);

async function person(company: string, name: string, active = true): Promise<string> {
  const uid = randomUUID();
  await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [uid]);
  await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict do nothing`, [uid, name]);
  await db.query(
    `insert into profiles (id, company_id, username, full_name, department, is_admin, is_active)
     values ($1,$2,$3,$4,'operations',false,$5)`,
    [uid, company, name.toLowerCase() + "." + uid.slice(0, 6), name, active],
  );
  await db.query(`insert into memberships (company_id, user_id, status) values ($1,$2,$3)`,
    [company, uid, active ? "active" : "suspended"]);
  return uid;
}

async function task(company: string, title = "routable"): Promise<string> {
  const r = await db.query(
    `insert into tasks (company_id, title, status, priority, requires_evidence) values ($1,$2,'captured',3,false) returning id`,
    [company, title],
  );
  return r.rows[0].id;
}

if (enabled) {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const conn = async () => { const c = new (pg as any).Client({ connectionString: URL, ssl: mkSsl(URL) }); await c.connect(); return c; };
    db = await conn(); cA = await conn(); cB = await conn(); authed = await conn();
    for (const c of [db, cA, cB]) await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await authed.query(`select set_config('request.jwt.claims','{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111"}',false)`);
    coA = (await db.query(`insert into companies (name, base_currency) values ('route_A','LKR') returning id`)).rows[0].id;
    coB = (await db.query(`insert into companies (name, base_currency) values ('route_B','LKR') returning id`)).rows[0].id;
    alice = await person(coA, "Alice");
    bob = await person(coA, "Bob");
    outsider = await person(coB, "Outsider");
    inactive = await person(coA, "Inactive", false);
  });
  afterAll(async () => {
    for (const co of [coA, coB]) {
      for (const sql of [
        `delete from task_routing_events where company_id=$1`,
        `delete from task_routing where company_id=$1`,
        `delete from tasks where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from profiles where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [co]); } catch { /* noop */ } }
    }
    await Promise.all([cA?.end(), cB?.end(), authed?.end(), db?.end()].map((p: any) => p?.catch?.(() => {})));
  });
}

describe.skipIf(!enabled)("AIM-003 valid routing", () => {
  it("a valid person assignment is durable and audited", async () => {
    const t = await task(coA);
    const r = await route(db, { company: coA, task: t, state: "assigned", reason: "capability_match", assignee: alice, proposed: [alice] });
    expect(r.rows[0].routing_state).toBe("assigned");

    const row = await db.query(`select assignee_id, is_active, attempt_count from task_routing where task_id=$1 and is_active`, [t]);
    expect(row.rows[0].assignee_id).toBe(alice);
    expect(row.rows[0].attempt_count).toBe(1);

    const ev = await db.query(`select to_state, reason_code from task_routing_events where task_id=$1`, [t]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].to_state).toBe("assigned");
  });

  it("a queue routing records the queue, not a person", async () => {
    const t = await task(coA);
    const r = await route(db, { company: coA, task: t, state: "needs_routing", reason: "no_owner_yet", queue: "operations" });
    expect(r.rows[0].routing_state).toBe("needs_routing");
    const row = await db.query(`select assignee_id, queue_name from task_routing where task_id=$1 and is_active`, [t]);
    expect(row.rows[0].assignee_id).toBeNull();
    expect(row.rows[0].queue_name).toBe("operations");
  });
});

describe.skipIf(!enabled)("AIM-003 the AI cannot make anyone eligible", () => {
  it("a candidate from ANOTHER company is refused — no_eligible_assignee", async () => {
    const t = await task(coA);
    const r = await route(db, { company: coA, task: t, state: "assigned", assignee: outsider, proposed: [outsider] });
    expect(r.rows[0].routing_state).toBe("no_eligible_assignee");
    expect(r.rows[0].reason_code).toBe("not_active_member_of_company");
    const row = await db.query(`select assignee_id, proposed_assignees from task_routing where task_id=$1 and is_active`, [t]);
    expect(row.rows[0].assignee_id).toBeNull();
    // The refused proposal is still recorded — the attempt is auditable.
    expect(JSON.stringify(row.rows[0].proposed_assignees)).toContain(outsider);
  });

  it("a suspended/inactive candidate is refused", async () => {
    const t = await task(coA);
    const r = await route(db, { company: coA, task: t, state: "assigned", assignee: inactive });
    expect(r.rows[0].routing_state).toBe("no_eligible_assignee");
    expect(r.rows[0].reason_code).toBe("not_active_member_of_company");
  });

  it("a candidate lacking the required capability is refused", async () => {
    const t = await task(coA);
    const r = await route(db, { company: coA, task: t, state: "assigned", assignee: alice, capability: "finance.journal.post" });
    expect(r.rows[0].routing_state).toBe("no_eligible_assignee");
    expect(r.rows[0].reason_code).toBe("lacks_required_capability");
  });

  it("a separation-of-duties conflict is refused", async () => {
    const t = await task(coA);
    const r = await route(db, { company: coA, task: t, state: "assigned", assignee: alice, submitter: alice });
    expect(r.rows[0].routing_state).toBe("no_eligible_assignee");
    expect(r.rows[0].reason_code).toBe("separation_of_duties");
  });

  it("no proposed assignee at all degrades to needs_routing, not to a guess", async () => {
    const t = await task(coA);
    const r = await route(db, { company: coA, task: t, state: "assigned", assignee: null });
    expect(r.rows[0].routing_state).toBe("needs_routing");
    expect(r.rows[0].reason_code).toBe("no_assignee_proposed");
  });

  it("a candidate who becomes ineligible BETWEEN recommendation and commit is refused", async () => {
    const t = await task(coA);
    // Recommended while eligible…
    const eligible = await db.query(`select task_assignee_ineligible_reason($1,$2,null,null) r`, [coA, bob]);
    expect(eligible.rows[0].r).toBeNull();
    // …then suspended before the routing transaction commits.
    await db.query(`update memberships set status='suspended' where company_id=$1 and user_id=$2`, [coA, bob]);
    const r = await route(db, { company: coA, task: t, state: "assigned", assignee: bob, proposed: [bob] });
    expect(r.rows[0].routing_state).toBe("no_eligible_assignee");
    await db.query(`update memberships set status='active' where company_id=$1 and user_id=$2`, [coA, bob]);
  });

  it("awaiting_approval without an approval record degrades to manual_review", async () => {
    const t = await task(coA);
    const r = await route(db, { company: coA, task: t, state: "awaiting_approval", approval: null });
    expect(r.rows[0].routing_state).toBe("manual_review");
    expect(r.rows[0].reason_code).toBe("approval_required_but_no_approval_record");
  });
});

describe.skipIf(!enabled)("AIM-003 concurrency, supersession and isolation", () => {
  it("exactly one ACTIVE routing row survives two concurrent routers", async () => {
    const t = await task(coA);
    const [a, b] = await Promise.allSettled([
      route(cA, { company: coA, task: t, state: "assigned", assignee: alice, reason: "router_a" }),
      route(cB, { company: coA, task: t, state: "assigned", assignee: bob, reason: "router_b" }),
    ]);
    expect([a.status, b.status].filter((s) => s === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const active = await db.query(`select count(*)::int n from task_routing where task_id=$1 and is_active`, [t]);
    expect(active.rows[0].n).toBe(1);
  });

  it("reassignment supersedes the previous active routing and keeps its history", async () => {
    const t = await task(coA);
    await route(db, { company: coA, task: t, state: "assigned", assignee: alice, reason: "first" });
    await route(db, { company: coA, task: t, state: "assigned", assignee: bob, reason: "reassigned" });

    const active = await db.query(`select assignee_id from task_routing where task_id=$1 and is_active`, [t]);
    expect(active.rows).toHaveLength(1);
    expect(active.rows[0].assignee_id).toBe(bob);

    const all = await db.query(`select is_active, superseded_by from task_routing where task_id=$1 order by created_at`, [t]);
    expect(all.rows).toHaveLength(2);
    expect(all.rows[0].is_active).toBe(false);
    expect(all.rows[0].superseded_by).not.toBeNull();

    const ev = await db.query(`select from_state, to_state from task_routing_events where task_id=$1 order by created_at`, [t]);
    expect(ev.rows).toHaveLength(2);
    expect(ev.rows[1].from_state).toBe("assigned");
  });

  it("escalation is a state, and attempt_count carries forward", async () => {
    const t = await task(coA);
    await route(db, { company: coA, task: t, state: "needs_routing", reason: "no_owner" });
    const r = await route(db, { company: coA, task: t, state: "escalated", reason: "unanswered" });
    expect(r.rows[0].routing_state).toBe("escalated");
    const row = await db.query(`select attempt_count from task_routing where task_id=$1 and is_active`, [t]);
    expect(row.rows[0].attempt_count).toBe(2);
  });

  it("a task from another company cannot be routed under this company", async () => {
    const t = await task(coB);
    await expect(route(db, { company: coA, task: t, state: "needs_routing" })).rejects.toThrow();
  });

  it("completed and cancelled tasks cannot be routed", async () => {
    for (const st of ["completed", "cancelled"]) {
      const t = await task(coA);
      await db.query(`update tasks set status=$2 where id=$1`, [t, st]);
      await expect(route(db, { company: coA, task: t, state: "assigned", assignee: alice })).rejects.toThrow();
      const n = await db.query(`select count(*)::int n from task_routing where task_id=$1`, [t]);
      expect(n.rows[0].n).toBe(0); // a failed transition leaves NO partial routing
    }
  });

  it("a failed transition writes no misleading audit entry", async () => {
    const t = await task(coA);
    await db.query(`update tasks set status='cancelled' where id=$1`, [t]);
    await expect(route(db, { company: coA, task: t, state: "assigned", assignee: alice })).rejects.toThrow();
    const ev = await db.query(`select count(*)::int n from task_routing_events where task_id=$1`, [t]);
    expect(ev.rows[0].n).toBe(0);
  });
});

describe.skipIf(!enabled)("AIM-003 authorization and immutability", () => {
  it("routing is service-only", async () => {
    const t = await task(coA);
    await expect(route(authed, { company: coA, task: t, state: "needs_routing" })).rejects.toThrow();
  });

  it("routing history is append-only, even for the service role", async () => {
    const t = await task(coA);
    await route(db, { company: coA, task: t, state: "needs_routing", reason: "immutability" });
    await expect(db.query(`update task_routing_events set reason_code='rewritten' where task_id=$1`, [t])).rejects.toThrow();
    await expect(db.query(`delete from task_routing_events where task_id=$1`, [t])).rejects.toThrow();
  });

  it("neither routing table is writable by anon or authenticated", async () => {
    const r = await db.query(`
      select has_table_privilege('authenticated','public.task_routing','INSERT') a,
             has_table_privilege('authenticated','public.task_routing','UPDATE') b,
             has_table_privilege('anon','public.task_routing_events','INSERT') c,
             has_table_privilege('authenticated','public.task_routing','SELECT') d`);
    expect(r.rows[0].a).toBe(false);
    expect(r.rows[0].b).toBe(false);
    expect(r.rows[0].c).toBe(false);
    expect(r.rows[0].d).toBe(true); // reads stay available under RLS
  });

  it("a state that claims a destination must have one", async () => {
    // The constraint is what stops a row saying "assigned" with nobody assigned.
    const t = await task(coA);
    await expect(
      db.query(
        `insert into task_routing (company_id, task_id, routing_state, reason_code) values ($1,$2,'assigned','forged')`,
        [coA, t],
      ),
    ).rejects.toThrow();
  });
});
