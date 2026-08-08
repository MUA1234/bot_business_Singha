/**
 * WP7 deny-by-default authority + transactional approval RPC (migration 0046) — live,
 * ZERO-PERSISTENCE.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, uMaker: string, uUnlimited: string, uCeiling: string, uNone: string;

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
async function decide(u: string, req: string, action = "approve"): Promise<{ ok: boolean; value?: string; error?: string }> {
  await asUser(u); let r: { ok: boolean; value?: string; error?: string };
  try { const res = await q(`select public.decide_approval('${co}','${req}','${action}') as v`); r = { ok: true, value: res.rows[0]?.v }; }
  catch (e) { r = { ok: false, error: (e as Error).message }; }
  await asSuper(); return r;
}
async function mkRequest(amount: number, ccy: string, submittedBy: string): Promise<string> {
  const fe = (await q(`insert into financial_events (company_id, event_type, state, amount, currency, correlation_id) values ($1,'payment','detected',${amount},'${ccy}','corr_'||gen_random_uuid()) returning id`, [co])).rows[0].id;
  return (await q(`insert into approval_requests (company_id, financial_event_id, status, approvals_required, submitted_by) values ($1,$2,'pending',1,$3) returning id`, [co, fe, submittedBy])).rows[0].id;
}

describe.skipIf(!enabled)("WP7 approval authority — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    co = (await client.query(`insert into companies (name, base_currency) values ('appr','LKR') returning id`)).rows[0].id;
    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    uMaker = await mkUser("ap_maker"); uUnlimited = await mkUser("ap_unl"); uCeiling = await mkUser("ap_ceil"); uNone = await mkUser("ap_none");
    const mkMem = async (u: string, role: string): Promise<string> => {
      const id = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, u])).rows[0].id;
      await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [id, co, role]);
      return id;
    };
    await mkMem(uMaker, "staff_submitter");
    const mUnl = await mkMem(uUnlimited, "owner_management"); // has 'approve'
    const mCeil = await mkMem(uCeiling, "owner_management");
    await mkMem(uNone, "owner_management");
    await client.query(`insert into authority_rules (membership_id, company_id, domain, is_unlimited) values ($1,$2,'payment',true)`, [mUnl, co]);
    await client.query(`insert into authority_rules (membership_id, company_id, domain, max_amount, currency) values ($1,$2,'payment',1000,'LKR')`, [mCeil, co]);
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("no authority rule → approval denied", async () => {
    const r = await mkRequest(500, "LKR", uMaker);
    const res = await decide(uNone, r);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeds your approval authority/i);
  });

  it("explicit unlimited authority → approved", async () => {
    const r = await mkRequest(999999, "LKR", uMaker);
    const res = await decide(uUnlimited, r);
    expect(res.ok).toBe(true);
    expect(res.value).toBe("approved");
    // re-decide a completed request is rejected (lifecycle)
    const again = await decide(uUnlimited, r);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/not pending/i);
  });

  it("amount above ceiling → denied; within ceiling → approved", async () => {
    expect((await decide(uCeiling, await mkRequest(5000, "LKR", uMaker))).ok).toBe(false);
    expect((await decide(uCeiling, await mkRequest(500, "LKR", uMaker))).value).toBe("approved");
  });

  it("wrong currency → denied", async () => {
    const r = await mkRequest(500, "USD", uMaker); // ceiling rule is LKR only
    const res = await decide(uCeiling, r);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeds your approval authority/i);
  });

  it("maker cannot approve their own request", async () => {
    const r = await mkRequest(500, "LKR", uUnlimited); // submitted by the unlimited approver
    const res = await decide(uUnlimited, r);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/separation of duties|cannot approve their own/i);
  });
});
