/**
 * WP6 supplier bank-detail maker-checker (migration 0045) — live, ZERO-PERSISTENCE.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let coA: string, coB: string, supA: string, supB: string, uMaker: string, uChecker: string, uBoth: string, uStaff: string;

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
async function callAs(u: string, sql: string, params: unknown[] = []): Promise<{ ok: boolean; value?: string; error?: string }> {
  await asUser(u); let r: { ok: boolean; value?: string; error?: string };
  try { const res = await q(sql, params); r = { ok: true, value: res.rows[0]?.v }; } catch (e) { r = { ok: false, error: (e as Error).message }; }
  await asSuper(); return r;
}
async function request(u: string, co: string, sup: string): Promise<{ ok: boolean; value?: string; error?: string }> {
  return callAs(u, `select public.request_supplier_bank_change('${co}','${sup}','New Name','9999','${u}') as v`);
}
async function decide(u: string, co: string, change: string, d: string) {
  return callAs(u, `select public.decide_supplier_bank_change('${co}','${change}','${d}','${u}',null)`);
}

describe.skipIf(!enabled)("WP6 bank-detail maker-checker — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    const mkCo = async (n: string) => (await client.query(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [n])).rows[0].id;
    coA = await mkCo("bmc_A"); coB = await mkCo("bmc_B");
    supA = (await client.query(`insert into suppliers (company_id, name, status, bank_account_number) values ($1,'SupA','active','1111') returning id`, [coA])).rows[0].id;
    supB = (await client.query(`insert into suppliers (company_id, name, status) values ($1,'SupB','active') returning id`, [coB])).rows[0].id;
    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    uMaker = await mkUser("bmc_maker"); uChecker = await mkUser("bmc_checker"); uBoth = await mkUser("bmc_both"); uStaff = await mkUser("bmc_staff");
    const mkMem = async (u: string, roles: string[]) => {
      const id = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [coA, u])).rows[0].id;
      for (const r of roles) await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [id, coA, r]);
    };
    await mkMem(uMaker, ["payment_initiator"]);   // finance.bank_details.request
    await mkMem(uChecker, ["payment_approver"]);  // finance.bank_details.approve
    await mkMem(uBoth, ["payment_initiator", "payment_approver"]);
    await mkMem(uStaff, ["staff_submitter"]);
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("maker can request; cannot approve, directly edit or delete the request", async () => {
    const req = await request(uMaker, coA, supA);
    expect(req.ok).toBe(true);
    const change = req.value!;
    // maker lacks approve capability
    const appr = await decide(uMaker, coA, change, "approved");
    expect(appr.ok).toBe(false);
    expect(appr.error).toMatch(/finance\.bank_details\.approve/i);
    // direct UPDATE / DELETE of the maker-checker row is impossible (RPC-only)
    const upd = await callAs(uMaker, `update supplier_bank_detail_changes set status='approved' where id=$1`, [change]);
    const del = await callAs(uMaker, `delete from supplier_bank_detail_changes where id=$1`, [change]);
    expect(upd.ok).toBe(false);
    expect(del.ok).toBe(false);
  });

  it("a requester cannot approve their own change (separation of duties)", async () => {
    const req = await request(uBoth, coA, supA);        // uBoth has both caps
    const sod = await decide(uBoth, coA, req.value!, "approved");
    expect(sod.ok).toBe(false);
    expect(sod.error).toMatch(/separation of duties|requester cannot approve/i);
  });

  it("a different checker approves and the supplier is updated; re-decide is rejected", async () => {
    const req = await request(uMaker, coA, supA);
    const ok = await decide(uChecker, coA, req.value!, "approved");
    expect(ok.ok).toBe(true);
    const sup = await q(`select bank_account_number from suppliers where id=$1`, [supA]);
    expect(sup.rows[0].bank_account_number).toBe("9999");
    const again = await decide(uChecker, coA, req.value!, "approved");
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/not pending/i);
  });

  it("unauthorized staff cannot approve; cross-company request is rejected", async () => {
    const req = await request(uMaker, coA, supA);
    const staff = await decide(uStaff, coA, req.value!, "approved");
    expect(staff.ok).toBe(false);
    expect(staff.error).toMatch(/finance\.bank_details\.approve/i);
    // uMaker (company A) cannot request against a company B supplier.
    const cross = await request(uMaker, coA, supB);
    expect(cross.ok).toBe(false);
    expect(cross.error).toMatch(/supplier not found/i);
  });
});
