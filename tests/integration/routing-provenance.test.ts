/**
 * R1 §2 / OF-007 — a routing decision's provenance is DERIVED, never asserted (migration 0078).
 *
 * The exploit: `route_task` took `p_actor_source` and `p_actor`, so any service-role caller could
 * manufacture a human decision by passing `'human'` and a real member's id — which made the guard
 * protecting a person's assignment a formality. 0077 required the named member to be active, which
 * raised the price of the forgery without removing it.
 *
 * These scenarios prove the forgery is refused in every form it could take, and that the honest
 * paths still work. Deterministic scenarios against a disposable local PostgreSQL.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let co: string, coB: string, manager: string, plain: string, otherCoManager: string;
const BESPOKE = `bespoke_${rnd()}`;

async function member(company: string, role: "owner_management" | "staff_submitter"): Promise<string> {
  const id = randomUUID();
  const u = `u${rnd()}`;
  await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [id]);
  await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict do nothing`, [id, u]);
  await db.query(
    `insert into profiles (id, company_id, username, full_name, department, is_active) values ($1,$2,$3,$3,'operations',true)`,
    [id, company, u]);
  const m = (await db.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [company, id])).rows[0].id;
  await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [m, company, role]);
  return id;
}
const task = async (company: string) =>
  (await db.query(`insert into tasks (company_id, title, status) values ($1,$2,'captured') returning id`, [company, `t_${rnd()}`])).rows[0].id;

/**
 * Run a statement inside a savepoint as a given role/identity.
 *
 * ALWAYS rolls the savepoint back — success included — so one scenario's role, claims or writes can
 * never leak into the next, and a refusal cannot leave the enclosing transaction aborted.
 */
async function as(role: string, sub: string | null, sql: string, params: unknown[] = []) {
  await db.query("savepoint p");
  try {
    await db.query(`set local role ${role}`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(sub ? { sub, role } : { role })]);
    const res = await db.query(sql, params);
    await db.query("rollback to savepoint p");
    return { ok: true as const, rows: res.rows as any[] };
  } catch (e) {
    await db.query("rollback to savepoint p");
    return { ok: false as const, rows: [] as any[], code: (e as { code?: string }).code, message: (e as Error).message };
  }
}

/**
 * A scenario that must COMMIT its effect for a later assertion: run the body inside a savepoint as
 * the given identity, then read the result back as the service context in the same transaction.
 */
async function asKeeping<T>(role: string, sub: string | null, body: () => Promise<T>): Promise<T> {
  await db.query("savepoint k");
  try {
    await db.query(`set local role ${role}`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(sub ? { sub, role } : { role })]);
    const out = await body();
    await db.query("release savepoint k");
    return out;
  } catch (e) {
    await db.query("rollback to savepoint k");
    throw e;
  } finally {
    // `set local role` is transaction-scoped, so it must be undone explicitly after a RELEASE.
    await db.query("reset role").catch(() => {});
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`).catch(() => {});
  }
}

describe.skipIf(!enabled)("0078 — routing provenance cannot be asserted by a caller (disposable local PostgreSQL)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await db.query(`insert into companies (name, base_currency) values ('provA','LKR') returning id`)).rows[0].id;
    coB = (await db.query(`insert into companies (name, base_currency) values ('provB','LKR') returning id`)).rows[0].id;
    manager = await member(co, "owner_management");
    plain = await member(co, "staff_submitter");
    otherCoManager = await member(coB, "owner_management");
    // A role nobody anticipated: the guard is a POSITIVE owner allowlist, so this must fail too.
    await db.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${BESPOKE}') then create role ${BESPOKE}; end if; end $$;`);
    await db.query(`grant usage on schema public to ${BESPOKE}`);
    await db.query(`grant insert, update, select on public.task_routing to ${BESPOKE}`);
    await db.query(`grant insert on public.task_routing_events to ${BESPOKE}`);
    // Deliberately GENEROUS: without EXECUTE here, a bespoke role is refused by "permission denied
    // for function _is_task_routing_owner" — a different mechanism from the one under test, and the
    // test would pass while proving nothing about the owner allowlist. Granting it makes the
    // refusal below the boundary's own.
    await db.query(`grant execute on function public._is_task_routing_owner() to ${BESPOKE}`);
    // One transaction for the whole file: `as()` uses savepoints, which require a transaction
    // block, and everything above is rolled back at the end.
    await db.query("begin");
  });
  afterAll(async () => {
    try { await db.query("rollback"); } catch { /* noop */ }
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`).catch(() => {});
    for (const c of [co, coB]) {
      for (const sql of [
        `delete from task_routing_events where company_id=$1`,
        `delete from task_routing where company_id=$1`,
        `delete from tasks where company_id=$1`,
        `delete from membership_roles where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from profiles where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [c]); } catch { /* noop */ } }
    }
    try {
      await db.query(`revoke all on public.task_routing from ${BESPOKE}`);
      await db.query(`revoke all on public.task_routing_events from ${BESPOKE}`);
      await db.query(`revoke all on function public._is_task_routing_owner() from ${BESPOKE}`);
      await db.query(`revoke usage on schema public from ${BESPOKE}`);
      await db.query(`drop role if exists ${BESPOKE}`);
    } catch { /* noop */ }
    await db?.end().catch(() => {});
  });

  // ── the forgery, in every form ─────────────────────────────────────────────────────────────
  it("THE OLD EXPLOIT IS GONE: the caller-supplied-provenance route_task no longer exists", async () => {
    const t = await task(co);
    const r = await as("service_role", null,
      `select * from public.route_task($1,$2,'assigned','forged',null,'[]'::jsonb,$3,null,null,$3,'human',null)`, [co, t, manager]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42883"); // undefined_function — removed, not merely guarded
  });

  it("the service context has NO EXECUTE on the human path", async () => {
    const t = await task(co);
    const r = await as("service_role", null,
      `select * from public.route_task_as_human($1,$2,'assigned','forged',null,'[]'::jsonb,$3)`, [co, t, manager]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
  });

  it("the shared implementation is unreachable even from the service context", async () => {
    const t = await task(co);
    const r = await as("service_role", null,
      `select * from public._route_task_internal($1,$2,'assigned','forged',null,'[]'::jsonb,$3,null,null,$3,'human',null,null,null,null)`,
      [co, t, manager]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
  });

  it("a direct INSERT of a human decision is refused — service_role, authenticated, anon and a bespoke role alike", async () => {
    const t = await task(co);
    const insert = `insert into task_routing (company_id, task_id, routing_state, reason_code, assignee_id, decided_by, decided_by_source)
                    values ($1,$2,'assigned','forged',$3,$3,'human')`;
    for (const [role, sub] of [["service_role", null], ["authenticated", manager], ["anon", null], [BESPOKE, null]] as const) {
      const r = await as(role, sub, insert, [co, t, manager]);
      expect(r.ok, `${role} could insert a forged human routing row`).toBe(false);
      expect(["42501", "42P01"], `${role}: ${r.message}`).toContain(r.code ?? "");
      // The refusal must come from the ROUTING BOUNDARY, not from a missing grant elsewhere.
      if (role === BESPOKE) {
        expect(r.message, "the bespoke role was refused by the wrong mechanism").toMatch(/routing boundary/i);
      }
    }
  });

  it("routing HISTORY cannot be forged either", async () => {
    const t = await task(co);
    for (const [role, sub] of [["service_role", null], [BESPOKE, null]] as const) {
      const r = await as(role, sub,
        `insert into task_routing_events (company_id, task_id, from_state, to_state, reason_code, actor_id, actor_source)
         values ($1,$2,null,'assigned','forged',$3,'human')`, [co, t, manager]);
      expect(r.ok, role).toBe(false);
      expect(r.code).toBe("42501");
    }
  });

  it("provenance is IMMUTABLE once written", async () => {
    const t = await task(co);
    await db.query(`select * from public.route_task_as_ai($1,$2,'needs_routing','captured','capture-routing')`, [co, t]);
    const r = await as("service_role", null,
      `update task_routing set decided_by_source='human', decided_by=$3 where task_id=$2 and company_id=$1 and is_active`,
      [co, t, manager]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("23001"); // restrict_violation
  });

  // ── the machine path cannot borrow a person ────────────────────────────────────────────────
  it("route_task_as_ai records the COMPONENT and never a person", async () => {
    const t = await task(co);
    await db.query(`select * from public.route_task_as_ai($1,$2,'needs_routing','captured','capture-routing','gpt-x','capture-routing/v1')`, [co, t]);
    const row = (await db.query(
      `select decided_by, decided_by_source, decided_by_component, decided_by_model, decided_by_policy_version
         from task_routing where task_id=$1 and is_active`, [t])).rows[0];
    expect(row.decided_by).toBeNull();
    expect(row.decided_by_source).toBe("ai");
    expect(row.decided_by_component).toBe("capture-routing");
    expect(row.decided_by_model).toBe("gpt-x");
    expect(row.decided_by_policy_version).toBe("capture-routing/v1");
  });

  it("a machine decision must NAME the component that made it", async () => {
    const t = await task(co);
    // Through the savepoint helper: an expected failure on the bare connection would abort the
    // file's enclosing transaction and every later scenario with it.
    const r = await as("service_role", null, `select * from public.route_task_as_ai($1,$2,'needs_routing','x','   ')`, [co, t]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/must name the component/);
  });

  // ── the honest human path ──────────────────────────────────────────────────────────────────
  it("an authenticated manager CAN make a human decision, and it is attributed to them", async () => {
    const t = await task(co);
    const res = await asKeeping("authenticated", manager, async () =>
      (await db.query(
        `select * from public.route_task_as_human($1,$2,'assigned','manager_assigned',null,'[]'::jsonb,$3)`, [co, t, manager])).rows[0]);

    expect(res.routing_state).toBe("assigned");
    const row = (await db.query(
      `select decided_by, decided_by_source, decided_by_component, assignee_id from task_routing where task_id=$1 and is_active`, [t])).rows[0];
    expect(row.decided_by).toBe(manager);          // from auth.uid(), not from a parameter
    expect(row.decided_by_source).toBe("human");
    expect(row.decided_by_component).toBeNull();   // a person is not a component
    expect(row.assignee_id).toBe(manager);
  });

  it("and an automated re-run cannot undo it", async () => {
    const t = await task(co);
    await asKeeping("authenticated", manager, () =>
      db.query(`select * from public.route_task_as_human($1,$2,'assigned','manager_assigned',null,'[]'::jsonb,$3)`, [co, t, manager]));

    const after = (await db.query(
      `select * from public.route_task_as_ai($1,$2,'needs_routing','captured','capture-routing')`, [co, t])).rows[0];
    expect(after.routing_state).toBe("assigned");
    const refusal = (await db.query(
      `select count(*)::int c from task_routing_events where task_id=$1 and reason_code='automated_supersede_refused'`, [t])).rows[0].c;
    expect(refusal).toBe(1);
  });

  it("a session with no authenticated identity cannot make a human decision", async () => {
    const t = await task(co);
    const r = await as("authenticated", null,
      `select * from public.route_task_as_human($1,$2,'needs_routing','x')`, [co, t]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/authenticated session/);
  });

  it("an authenticated member WITHOUT the capability is refused", async () => {
    const t = await task(co);
    const r = await as("authenticated", plain,
      `select * from public.route_task_as_human($1,$2,'needs_routing','x')`, [co, t]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/operations\.task\.manage/);
  });

  it("a manager of ANOTHER company is refused, even with a valid session", async () => {
    const t = await task(co);
    const r = await as("authenticated", otherCoManager,
      `select * from public.route_task_as_human($1,$2,'needs_routing','x')`, [co, t]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no active membership/);
  });

  it("a SUSPENDED membership is refused at decision time, not at grant time", async () => {
    const t = await task(co);
    await db.query(`update memberships set status='suspended' where user_id=$1 and company_id=$2`, [manager, co]);
    const r = await as("authenticated", manager,
      `select * from public.route_task_as_human($1,$2,'needs_routing','x')`, [co, t]);
    await db.query(`update memberships set status='active' where user_id=$1 and company_id=$2`, [manager, co]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no active membership/);
  });

  it("an INACTIVE profile is refused even with an active membership", async () => {
    const t = await task(co);
    await db.query(`update profiles set is_active=false where id=$1`, [manager]);
    const r = await as("authenticated", manager,
      `select * from public.route_task_as_human($1,$2,'needs_routing','x')`, [co, t]);
    await db.query(`update profiles set is_active=true where id=$1`, [manager]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no active profile/);
  });
});
