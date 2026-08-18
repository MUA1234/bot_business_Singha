/**
 * Correction loop 1 — the 0072 and 0074 defects an independent adversarial review confirmed, each
 * reproduced on live PostgreSQL before being accepted, and each pinned here so it cannot return.
 *
 *   * the assignee capability re-check was a CONSTANT FALSE (a user id was passed where a company id
 *     was expected), so a routing that named a required capability could never reach `assigned`;
 *   * an AI or system actor could silently supersede a HUMAN assignment;
 *   * routing history was not append-only against TRUNCATE;
 *   * an `awaiting_approval` routing could name an approval record that does not exist;
 *   * channel-account write-uniqueness and read-matching used DIFFERENT keys, so two companies could
 *     claim one account and a mapping with stray whitespace silently ended all inbound intake;
 *   * a non-canonical channel string bypassed the "any mapping is configured" guard.
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
let co: string, coB: string, capable: string, plain: string;

/** An active member; `role` decides whether they hold `operations.inbound.review`. */
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

const route = (company: string, taskId: string, state: string, o: Record<string, unknown> = {}) =>
  db.query(
    `select * from public.route_task($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
    [company, taskId, state, o.reason ?? "test", o.capability ?? null, JSON.stringify(o.proposed ?? []),
     o.assignee ?? null, o.queue ?? null, o.approval ?? null, o.actor ?? null, o.actorSource ?? "system", o.submitter ?? null],
  ).then((r: any) => r.rows[0]);

describe.skipIf(!enabled)("correction loop 1 — confirmed 0072 / 0074 defects (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await db.query(`insert into companies (name, base_currency) values ('corrA','LKR') returning id`)).rows[0].id;
    coB = (await db.query(`insert into companies (name, base_currency) values ('corrB','LKR') returning id`)).rows[0].id;
    capable = await member(co, "owner_management");
    plain = await member(co, "staff_submitter");
  });
  afterAll(async () => {
    for (const c of [co, coB]) {
      for (const sql of [
        `delete from task_routing_events where company_id=$1`,
        `delete from task_routing where company_id=$1`,
        `delete from tasks where company_id=$1`,
        `delete from channel_accounts where company_id=$1`,
        `delete from membership_roles where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from profiles where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [c]); } catch { /* noop */ } }
    }
    await db?.end().catch(() => {});
  });

  // ── 0072: the capability re-check ───────────────────────────────────────────────────────────
  it("a CAPABLE assignee is accepted — the check used to be a constant false", async () => {
    expect((await db.query(`select public.actor_has_capability($1,$2,'operations.inbound.review') as t`, [capable, co])).rows[0].t).toBe(true);
    expect((await db.query(`select public.task_assignee_ineligible_reason($1,$2,'operations.inbound.review',null) as r`, [co, capable])).rows[0].r).toBeNull();

    const t = await task(co);
    // `actor` is required for a human decision since 0077: the guard that protects a person's
    // assignment keys on actor_source, so it may not be claimed without naming an active member.
    const r = await route(co, t, "assigned", {
      capability: "operations.inbound.review", assignee: capable, actorSource: "human", actor: capable,
    });
    expect(r.routing_state).toBe("assigned");
    const row = (await db.query(`select assignee_id from task_routing where task_id=$1 and is_active`, [t])).rows[0];
    expect(row.assignee_id).toBe(capable);
  });

  it("an assignee WITHOUT the capability is still refused, truthfully", async () => {
    expect((await db.query(`select public.task_assignee_ineligible_reason($1,$2,'operations.inbound.review',null) as r`, [co, plain])).rows[0].r)
      .toBe("lacks_required_capability");
    const t = await task(co);
    const r = await route(co, t, "assigned", { capability: "operations.inbound.review", assignee: plain });
    expect(r.routing_state).toBe("no_eligible_assignee");
    expect(r.reason_code).toBe("lacks_required_capability");
  });

  it("a capable member of ANOTHER company is not eligible here", async () => {
    const other = await member(coB, "owner_management");
    expect((await db.query(`select public.task_assignee_ineligible_reason($1,$2,'operations.inbound.review',null) as r`, [co, other])).rows[0].r)
      .toBe("not_active_member_of_company");
  });

  // ── 0072: a person's decision stands ────────────────────────────────────────────────────────
  it("an AI re-run cannot supersede a HUMAN assignment, and the refusal is recorded", async () => {
    const t = await task(co);
    await route(co, t, "assigned", { assignee: capable, actor: capable, actorSource: "human", reason: "manager_assigned" });
    const again = await route(co, t, "needs_routing", { actorSource: "ai", reason: "captured_no_assignee_recommender" });

    expect(again.routing_state).toBe("assigned");     // the caller is told what is ACTUALLY current
    expect(again.reason_code).toBe("manager_assigned");
    const active = (await db.query(`select routing_state, assignee_id, decided_by_source from task_routing where task_id=$1 and is_active`, [t])).rows;
    expect(active).toHaveLength(1);
    expect(active[0].routing_state).toBe("assigned");
    expect(active[0].assignee_id).toBe(capable);
    const refusal = (await db.query(
      `select count(*)::int c from task_routing_events where task_id=$1 and reason_code='automated_supersede_refused'`, [t])).rows[0].c;
    expect(refusal).toBe(1);
  });

  it("a HUMAN may still change a human decision", async () => {
    const t = await task(co);
    await route(co, t, "assigned", { assignee: capable, actor: capable, actorSource: "human" });
    const r = await route(co, t, "manual_review", { actorSource: "human", actor: capable, reason: "reconsidered" });
    expect(r.routing_state).toBe("manual_review");
  });

  it("an automated actor may still supersede an AUTOMATED decision", async () => {
    const t = await task(co);
    await route(co, t, "needs_routing", { actorSource: "ai" });
    const r = await route(co, t, "manual_review", { actorSource: "ai", reason: "escalated" });
    expect(r.routing_state).toBe("manual_review");
  });

  // ── 0072: history, and destinations that exist ──────────────────────────────────────────────
  it("routing history refuses TRUNCATE, not only UPDATE and DELETE", async () => {
    const t = await task(co);
    await route(co, t, "needs_routing", { actorSource: "ai" });
    // TWO layers, and both are asserted. The service role is refused by PRIVILEGE (the revoke),
    // which is why it never reaches the trigger; the table OWNER is refused by the TRIGGER, which is
    // the only defence that can apply to an owner. Before this, `truncate` emptied the table.
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      await expect(db.query(`truncate public.task_routing_events`)).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("rollback");
    }
    await db.query("begin");
    try {
      await expect(db.query(`truncate public.task_routing_events`)).rejects.toThrow(/append-only/);
    } finally {
      await db.query("rollback");
    }
    const n = (await db.query(`select count(*)::int c from task_routing_events where task_id=$1`, [t])).rows[0].c;
    expect(n).toBeGreaterThan(0);
  });

  it("an awaiting_approval routing cannot name an approval record that does not exist", async () => {
    const t = await task(co);
    await expect(route(co, t, "awaiting_approval", { approval: randomUUID(), actorSource: "ai" }))
      .rejects.toThrow(/task_routing_approval_fk|violates foreign key/);
  });

  // ── 0074: one key for writing and for matching ──────────────────────────────────────────────
  it("TWO companies cannot claim one account through letter case", async () => {
    const acct = `Mixed_${rnd()}`;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [co, acct]);
    await expect(
      db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coB, acct.toLowerCase()]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("a mapping entered with stray whitespace still resolves — it used to end all intake", async () => {
    const acct = ` Spaced_${rnd()} `;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,' WhatsApp ',$2)`, [co, acct]);
    const stored = (await db.query(`select channel, provider_account_id from channel_accounts where company_id=$1 and provider_account_id like 'spaced%'`, [co])).rows[0];
    expect(stored.provider_account_id).toBe(acct.trim().toLowerCase());
    expect(stored.channel).toBe("whatsapp");
    const r = (await db.query(`select * from public.resolve_channel_company('whatsapp',$1)`, [acct.trim()])).rows[0];
    expect(r.match).toBe("exact");
    expect(r.company_id).toBe(co);
  });

  it("a non-canonical CHANNEL cannot bypass the configured-mapping guard", async () => {
    const acct = `Chan_${rnd()}`;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [co, acct]);
    for (const spelling of ["whatsapp", "WhatsApp", "WHATSAPP"]) {
      const hit = (await db.query(`select * from public.resolve_channel_company($1,$2)`, [spelling, acct])).rows[0];
      expect(hit.match, spelling).toBe("exact");
      const miss = (await db.query(`select * from public.resolve_channel_company($1,'never_mapped_at_all')`, [spelling])).rows[0];
      // Several companies exist here, so an unmapped account fails closed for EVERY spelling.
      expect(miss.match, spelling).toBe("unmapped");
    }
  });

  it("a blank provider account id is refused at write time", async () => {
    await expect(
      db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp','   ')`, [co]),
    ).rejects.toThrow(/provider_account_id is required/);
  });
});
