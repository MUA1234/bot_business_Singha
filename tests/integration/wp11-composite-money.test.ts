/**
 * WP11 SECOND external-review correction — company-consistent composite constraints and fail-closed
 * money/approvals_required. Live Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0060: an approval_action cannot reference a cross-company approval_request
 * (composite FK); and decide_approval fails closed on a non-positive/non-finite amount and an invalid
 * approvals_required. Migration 0061: the financial-event currency is validated against the
 * `currencies` CATALOGUE (a well-formed-but-unseeded code like ZZZ is rejected), not a bare regex.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, coB: string, maker: string, uOwner: string, reqB: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
async function asUser(u: string) {
  await client.query("set local role authenticated");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: u, role: "authenticated" })]);
}
async function asSuper() { await client.query("reset role"); await client.query(`select set_config('request.jwt.claims','',true)`); }
async function decide(u: string, req: string): Promise<{ ok: boolean; error?: string }> {
  await asUser(u);
  let r: { ok: boolean; error?: string };
  try { await q(`select public.decide_approval($1,$2,'approve') as v`, [co, req]); r = { ok: true }; }
  catch (e) { r = { ok: false, error: (e as Error).message }; }
  await asSuper(); return r;
}
// mkEvent inserts amount/currency verbatim (SQL literals) so we can seed invalid values.
async function mkEvent(company: string, amountSql: string, ccy: string): Promise<string> {
  return (await q(`insert into financial_events (company_id, event_type, state, amount, currency, correlation_id) values ($1,'payment','detected',${amountSql},'${ccy}','corr_'||gen_random_uuid()) returning id`, [company])).rows[0].id;
}
async function mkReq(fe: string, required = 1): Promise<string> {
  return (await q(`insert into approval_requests (company_id, financial_event_id, status, approvals_required, submitted_by) values ($1,$2,'pending',$3,$4) returning id`, [co, fe, required, maker])).rows[0].id;
}

describe.skipIf(!enabled)("WP11 composite constraints + money/currency fail-closed (0060/0061) — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    co = (await client.query(`insert into companies (name, base_currency) values ('wp11m','LKR') returning id`)).rows[0].id;
    coB = (await client.query(`insert into companies (name, base_currency) values ('wp11mB','LKR') returning id`)).rows[0].id;
    maker = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'m_maker',true) returning id`)).rows[0].id;
    await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active')`, [co, maker]);
    uOwner = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'m_owner',true) returning id`)).rows[0].id;
    const mOwner = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, uOwner])).rows[0].id;
    await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [mOwner, co]);
    await client.query(`insert into authority_rules (membership_id, company_id, domain, max_amount, currency, is_company_wide) values ($1,$2,'payment',1000000,'LKR',true)`, [mOwner, co]);
    // A request in coB (target for the cross-company approval_action FK test).
    const mkB = (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'mB_maker',true) returning id`)).rows[0].id;
    const feBid = (await client.query(`insert into financial_events (company_id, event_type, state, amount, currency, correlation_id) values ($1,'payment','detected',500,'LKR','corr_'||gen_random_uuid()) returning id`, [coB])).rows[0].id;
    reqB = (await client.query(`insert into approval_requests (company_id, financial_event_id, status, approvals_required, submitted_by) values ($1,$2,'pending',1,$3) returning id`, [coB, feBid, mkB])).rows[0].id;
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("an approval_action cannot reference a cross-company approval_request (composite FK)", async () => {
    let fk = false;
    try {
      await q(`insert into approval_actions (approval_request_id, company_id, actor_user_id, action) values ($1,$2,$3,'approve')`, [reqB, co, uOwner]);
    } catch (e) { fk = /foreign key|request_company_fk|violates/i.test((e as Error).message); }
    expect(fk).toBe(true);
  });

  it("a non-positive amount fails closed", async () => {
    const r = await decide(uOwner, await mkReq(await mkEvent(co, "0", "LKR")));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/positive and finite/i);
  });

  it("a NaN amount fails closed", async () => {
    const r = await decide(uOwner, await mkReq(await mkEvent(co, "'NaN'::numeric", "LKR")));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/positive and finite/i);
  });

  it("a well-formed but unsupported currency (ZZZ) fails closed — validated against the catalogue, not a bare regex", async () => {
    // ZZZ passes any three-letter regex yet is not a seeded ISO code, so the OLD regex would have let
    // it through. The catalogue check (migration 0061) must reject it.
    const r = await decide(uOwner, await mkReq(await mkEvent(co, "500", "ZZZ")));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a supported currency/i);
  });

  it("a malformed currency (1XA) also fails closed against the catalogue", async () => {
    const r = await decide(uOwner, await mkReq(await mkEvent(co, "500", "1XA")));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a supported currency/i);
  });

  it("a seeded supported currency (LKR) passes the currency gate (reaches later authority checks)", async () => {
    // A supported currency must NOT trip the currency check; this request is otherwise valid and the
    // owner holds company-wide LKR payment authority, so decide_approval succeeds.
    const r = await decide(uOwner, await mkReq(await mkEvent(co, "500", "LKR")));
    expect(r.ok, r.error).toBe(true);
  });

  it("an invalid approvals_required fails closed", async () => {
    const r = await decide(uOwner, await mkReq(await mkEvent(co, "500", "LKR"), 0));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid approvals_required/i);
  });
});
