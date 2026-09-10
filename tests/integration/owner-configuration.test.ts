/**
 * R1 §5 / OF-004, OF-005 — owner configuration as an audited workflow.
 *
 * Mapping a receiving number to a company and giving someone the capability to work the review
 * queue previously required editing the database by hand. Both are security-relevant: the first
 * decides which company owns a message, the second decides who can read untrusted third-party text.
 *
 * What stays an OWNER GATE is the values and the activation — these scenarios prove the surface
 * never grants anything by itself, refuses to take over another company's account, and audits every
 * change in the same transaction.
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
let co: string, coB: string, admin: string, plain: string, subject: string, otherAdmin: string;

async function member(company: string, role: string): Promise<string> {
  const id = randomUUID();
  const u = `u${rnd()}`;
  await db.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [id]);
  await db.query(`insert into users (id, full_name, is_active) values ($1,$2,true) on conflict do nothing`, [id, u]);
  await db.query(`insert into profiles (id, company_id, username, full_name, department, is_active) values ($1,$2,$3,$3,'operations',true)`,
    [id, company, u]);
  const m = (await db.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [company, id])).rows[0].id;
  if (role) await db.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [m, company, role]);
  return id;
}

const upsert = (company: string, account: string, actor: string, channel = "whatsapp", label: string | null = null) =>
  db.query(`select * from public.admin_upsert_channel_account($1,$2,$3,$4,$5)`, [company, channel, account, label, actor])
    .then((r: any) => r.rows[0]);
const setActive = (company: string, id: string, active: boolean, actor: string) =>
  db.query(`select * from public.admin_set_channel_account_active($1,$2,$3,$4)`, [company, id, active, actor])
    .then((r: any) => r.rows[0]);

describe.skipIf(!enabled)("0080 — owner configuration surface (disposable local PostgreSQL)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    co = (await db.query(`insert into companies (name, base_currency) values ('cfgA','LKR') returning id`)).rows[0].id;
    coB = (await db.query(`insert into companies (name, base_currency) values ('cfgB','LKR') returning id`)).rows[0].id;
    admin = await member(co, "system_administrator");
    plain = await member(co, "staff_submitter");
    subject = await member(co, "staff_submitter");
    otherAdmin = await member(coB, "system_administrator");
  });
  afterAll(async () => {
    for (const c of [co, coB]) {
      for (const sql of [
        `delete from audit_events where company_id=$1`,
        `delete from channel_accounts where company_id=$1`,
        `delete from membership_roles where company_id=$1`,
        `delete from memberships where company_id=$1`,
        `delete from profiles where company_id=$1`,
        `delete from companies where id=$1`,
      ]) { try { await db.query(sql, [c]); } catch { /* noop */ } }
    }
    await db?.end().catch(() => {});
  });

  it("a new mapping is created INACTIVE — creating one changes nothing", async () => {
    const acct = `pn_${rnd()}`;
    const r = await upsert(co, acct, admin);
    expect(r.created).toBe(true);
    const row = (await db.query(`select is_active from channel_accounts where id=$1`, [r.account_id])).rows[0];
    expect(row.is_active).toBe(false);
    // …and resolution still does not attribute anything to this company through it.
    const res = (await db.query(`select * from public.resolve_channel_company('whatsapp',$1)`, [acct])).rows[0];
    expect(res.match).not.toBe("exact");
  });

  it("ACTIVATION is a separate, deliberate act — and then it resolves", async () => {
    const acct = `pn_${rnd()}`;
    const r = await upsert(co, acct, admin);
    const a = await setActive(co, r.account_id, true, admin);
    expect(a.is_active).toBe(true);
    const res = (await db.query(`select * from public.resolve_channel_company('whatsapp',$1)`, [acct])).rows[0];
    expect(res.match).toBe("exact");
    expect(res.company_id).toBe(co);
  });

  it("it REFUSES to take over an account another company already has active", async () => {
    const acct = `pn_${rnd()}`;
    const mine = await upsert(co, acct, admin);
    await setActive(co, mine.account_id, true, admin);
    const theirs = await upsert(coB, acct, otherAdmin);
    expect(theirs.conflict).toBe("claimed_by_another_company");
    expect(theirs.account_id).toBeNull();
  });

  it("the conflict is re-validated AT ACTIVATION, not only at creation", async () => {
    const acct = `pn_${rnd()}`;
    // B saves a mapping while the account is free…
    const theirs = await upsert(coB, acct, otherAdmin);
    expect(theirs.created).toBe(true);
    // …A activates it first…
    const mine = await upsert(co, acct, admin);
    await setActive(co, mine.account_id, true, admin);
    // …and B's activation is refused rather than silently taking it over.
    const attempt = await setActive(coB, theirs.account_id, true, otherAdmin);
    expect(attempt.conflict).toBe("claimed_by_another_company");
    expect((await db.query(`select is_active from channel_accounts where id=$1`, [theirs.account_id])).rows[0].is_active).toBe(false);
  });

  it("a member WITHOUT the capability cannot map or activate anything", async () => {
    const acct = `pn_${rnd()}`;
    await expect(upsert(co, acct, plain)).rejects.toThrow(/admin\.organisation\.manage/);
    const mine = await upsert(co, acct, admin);
    await expect(setActive(co, mine.account_id, true, plain)).rejects.toThrow(/admin\.organisation\.manage/);
  });

  it("an admin of ANOTHER company cannot touch this company's mapping", async () => {
    const mine = await upsert(co, `pn_${rnd()}`, admin);
    await expect(setActive(co, mine.account_id, true, otherAdmin)).rejects.toThrow(/admin\.organisation\.manage/);
  });

  it("every change is AUDITED in the same transaction", async () => {
    const acct = `pn_${rnd()}`;
    const r = await upsert(co, acct, admin);
    await setActive(co, r.account_id, true, admin);
    await setActive(co, r.account_id, false, admin);
    const actions = (await db.query(
      `select action from audit_events where company_id=$1 and entity_id=$2 order by created_at`, [co, r.account_id])).rows
      .map((x: any) => x.action);
    expect(actions).toEqual(["channel_account.created", "channel_account.activated", "channel_account.deactivated"]);
  });

  it("a reviewer role is granted by someone else — never by the person themselves", async () => {
    await expect(db.query(`select * from public.admin_set_membership_role($1,$2,'finance_reviewer',true,$3)`, [co, admin, admin]))
      .rejects.toThrow(/may not grant themselves/);
    const r = (await db.query(`select * from public.admin_set_membership_role($1,$2,'finance_reviewer',true,$3)`, [co, subject, admin])).rows[0];
    expect(r.granted).toBe(true);
    expect((await db.query(`select public.actor_has_capability($1,$2,'operations.inbound.review') as t`, [subject, co])).rows[0].t).toBe(true);
  });

  it("only an ALLOWLISTED role may be granted through this surface", async () => {
    await expect(db.query(`select * from public.admin_set_membership_role($1,$2,'system_administrator',true,$3)`, [co, subject, admin]))
      .rejects.toThrow(/not grantable through this surface/);
  });

  it("granting requires admin.identity.manage, and is audited", async () => {
    await expect(db.query(`select * from public.admin_set_membership_role($1,$2,'finance_reviewer',true,$3)`, [co, subject, plain]))
      .rejects.toThrow(/admin\.identity\.manage/);
    await db.query(`select * from public.admin_set_membership_role($1,$2,'finance_reviewer',false,$3)`, [co, subject, admin]);
    const actions = (await db.query(
      `select action from audit_events where company_id=$1 and action like 'membership_role.%' order by created_at`, [co])).rows
      .map((x: any) => x.action);
    expect(actions).toContain("membership_role.granted");
    expect(actions).toContain("membership_role.revoked");
  });

  it("setup status reports what is configured and what is still required, per company", async () => {
    const s = (await db.query(`select * from public.inbound_setup_status($1)`, [co])).rows[0];
    expect(Number(s.active_accounts)).toBeGreaterThan(0);
    expect(s.single_tenant_bridge_in_use).toBe(false); // mappings exist, so the bridge is closed
    await expect(db.query(`select * from public.inbound_setup_status(null)`)).rejects.toThrow(/p_company is required/);
  });

  it("the whole surface is service-only", async () => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
      const cases: { sql: string; params: string[] }[] = [
        { sql: `select * from public.admin_upsert_channel_account($1,'whatsapp','x',null,$2)`, params: [co, admin] },
        { sql: `select * from public.admin_set_membership_role($1,$2,'finance_reviewer',true,$2)`, params: [co, admin] },
        { sql: `select * from public.inbound_setup_status($1)`, params: [co] },
      ];
      for (const c of cases) {
        await db.query("savepoint s");
        await expect(db.query(c.sql, c.params)).rejects.toMatchObject({ code: "42501" });
        await db.query("rollback to savepoint s");
      }
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });
});
