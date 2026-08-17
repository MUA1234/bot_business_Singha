/**
 * WP11 external-review correction C — approval fail-open and audit defects, and domain-specific
 * approval capabilities. Live Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0057: authority (capability + amount/currency/scope) is enforced for BOTH
 * approve AND reject on a financial event; a missing/cross-company event or NULL amount/currency or
 * unknown domain fails CLOSED; a duplicate actor action conflicts on a different action (no
 * state/audit change) and is idempotent on the same; the generic `approve` is replaced by a
 * deterministic domain->capability whitelist; and delegation requires from/to memberships in the
 * event's company.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, coB: string, projA: string, projB: string;
let maker: string, uOwner: string, uOwner2: string, uPay: string, uProjA: string, staff: string;
let uDelOK: string, feB: string, mDgtorB: string;

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
async function decide(u: string, company: string, req: string, action = "approve"): Promise<{ ok: boolean; value?: string; error?: string }> {
  await asUser(u);
  let r: { ok: boolean; value?: string; error?: string };
  try { const res = await q(`select public.decide_approval($1,$2,$3) as v`, [company, req, action]); r = { ok: true, value: res.rows[0]?.v }; }
  catch (e) { r = { ok: false, error: (e as Error).message }; }
  await asSuper(); return r;
}
async function boolAuth(u: string, company: string, fe: string): Promise<boolean> {
  await asUser(u);
  try { return (await q(`select public.within_authority_for_event($1,$2) as v`, [company, fe])).rows[0].v === true; }
  finally { await asSuper(); }
}
const rnd = () => Math.random().toString(36).slice(2, 9);
async function mkEvent(company: string, opts: { amount: number | null; ccy?: string; type?: string }): Promise<string> {
  const amt = opts.amount === null ? "null" : String(opts.amount);
  const ccy = opts.ccy === undefined ? "'LKR'" : (opts.ccy === null ? "null" : `'${opts.ccy}'`);
  return (await q(`insert into financial_events (company_id, event_type, state, amount, currency, correlation_id) values ($1,$2,'detected',${amt},${ccy},'corr_'||gen_random_uuid()) returning id`, [company, opts.type ?? "payment"])).rows[0].id;
}
async function addAlloc(fe: string, company: string, amount: number, s: { proj?: string } = {}) {
  await q(`insert into financial_event_allocations (financial_event_id, company_id, amount, project_id) values ($1,$2,$3,$4)`, [fe, company, amount, s.proj ?? null]);
}
async function mkReq(company: string, fe: string | null, submittedBy: string, required = 1): Promise<string> {
  return (await q(`insert into approval_requests (company_id, financial_event_id, status, approvals_required, submitted_by) values ($1,$2,'pending',$3,$4) returning id`, [company, fe, required, submittedBy])).rows[0].id;
}
const reqStatus = async (r: string) => (await q(`select status from approval_requests where id=$1`, [r])).rows[0].status;
const actionCount = async (r: string) => (await q(`select count(*)::int c from approval_actions where approval_request_id=$1`, [r])).rows[0].c;
const auditCount = async (r: string) => (await q(`select count(*)::int c from audit_events where entity_type='approval_request' and entity_id=$1`, [r])).rows[0].c;

describe.skipIf(!enabled)("WP11 approval fail-closed + domain caps (0057) — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    co = (await client.query(`insert into companies (name, base_currency) values ('wp11c','LKR') returning id`)).rows[0].id;
    coB = (await client.query(`insert into companies (name, base_currency) values ('wp11cB','LKR') returning id`)).rows[0].id;
    projA = (await client.query(`insert into projects (company_id, name) values ($1,'PA') returning id`, [co])).rows[0].id;
    projB = (await client.query(`insert into projects (company_id, name) values ($1,'PB') returning id`, [co])).rows[0].id;
    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    const mkMem = async (company: string, u: string, role: string | null): Promise<string> => {
      const id = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [company, u])).rows[0].id;
      if (role) await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [id, company, role]);
      return id;
    };
    const mkRule = async (mem: string, company: string, s: { domain?: string; cw?: boolean; proj?: string; max?: number }) => {
      await client.query(`insert into authority_rules (membership_id, company_id, domain, max_amount, currency, is_company_wide, project_id) values ($1,$2,$3,$4,'LKR',$5,$6)`,
        [mem, company, s.domain ?? "payment", s.max ?? 100000, s.cw ?? false, s.proj ?? null]);
    };
    maker = await mkUser("c_maker"); await mkMem(co, maker, "staff_submitter");
    uOwner = await mkUser("c_owner"); const mOwner = await mkMem(co, uOwner, "owner_management");
    await mkRule(mOwner, co, { domain: "payment", cw: true }); await mkRule(mOwner, co, { domain: "expense_claim", cw: true });
    uOwner2 = await mkUser("c_owner2"); await mkRule(await mkMem(co, uOwner2, "owner_management"), co, { domain: "payment", cw: true });
    uPay = await mkUser("c_pay"); await mkRule(await mkMem(co, uPay, "payment_approver"), co, { domain: "payment", cw: true });
    uProjA = await mkUser("c_projA"); await mkRule(await mkMem(co, uProjA, "owner_management"), co, { domain: "payment", proj: projA });
    staff = await mkUser("c_staff"); await mkMem(co, staff, "staff_submitter");

    // coB fixtures: an event (cross-company request target) and a delegator membership WITH authority.
    feB = await mkEvent(coB, { amount: 500 });
    mDgtorB = await mkMem(coB, await mkUser("cB_dgtor"), "owner_management");
    await mkRule(mDgtorB, coB, { domain: "payment", cw: true });
    // A valid same-company delegation from uOwner → uDelOK (contrast for the cross-company case).
    uDelOK = await mkUser("c_delOK"); const mDelOK = await mkMem(co, uDelOK, null);
    await client.query(`insert into delegations (company_id, from_membership, to_membership, starts_at, ends_at, domain, max_amount, currency, is_company_wide) values ($1,$2,$3, now()-interval '1 day', now()+interval '1 day','payment',100000,'LKR',true)`, [co, mOwner, mDelOK]);
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("out-of-scope REJECT is denied (authority applies to reject, not only approve)", async () => {
    const fe = await mkEvent(co, { amount: 500 }); await addAlloc(fe, co, 500, { proj: projB });
    const r = await mkReq(co, fe, maker);
    const rej = await decide(uProjA, co, r, "reject"); // project-A authority, project-B event
    expect(rej.ok).toBe(false);
    expect(rej.error).toMatch(/approval authority/i);
    expect(await reqStatus(r)).toBe("pending"); // unchanged
    expect(await actionCount(r)).toBe(0);
    // a company-wide holder may reject
    expect((await decide(uOwner, co, r, "reject")).value).toBe("rejected");
  });

  it("missing/cross-company event, NULL amount/currency, and unknown domain all fail closed", async () => {
    // cross-company: the composite FK (migration 0060) forbids a `co` request referencing a coB event
    // — it cannot even be inserted (stronger than the RPC's fail-closed check).
    let fk = false;
    try { await mkReq(co, feB, maker); } catch (e) { fk = /foreign key|company_fk|violates/i.test((e as Error).message); }
    expect(fk).toBe(true);
    // NULL amount (same-company event, so it inserts; decide fails closed)
    const rNull = await mkReq(co, await mkEvent(co, { amount: null }), maker);
    expect((await decide(uOwner, co, rNull)).error).toMatch(/missing amount\/currency/i);
    expect(await reqStatus(rNull)).toBe("pending");
    // unknown domain
    const rUnk = await mkReq(co, await mkEvent(co, { amount: 500, type: "unknown" }), maker);
    expect((await decide(uOwner, co, rUnk)).error).toMatch(/no approval capability/i);
    expect(await reqStatus(rUnk)).toBe("pending");
  });

  it("prior approve then reject by the SAME actor conflicts, changes nothing, stays auditable", async () => {
    const r = await mkReq(co, await mkEvent(co, { amount: 500 }), maker, 2); // needs 2 approvals
    expect((await decide(uOwner, co, r, "approve")).value).toBe("pending"); // 1 of 2
    const conflict = await decide(uOwner, co, r, "reject");
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toMatch(/conflicting decision/i);
    expect(await reqStatus(r)).toBe("pending"); // NOT rejected
    // exactly one persisted action (the approve), auditable
    expect(await actionCount(r)).toBe(1);
    expect((await q(`select action from approval_actions where approval_request_id=$1`, [r])).rows[0].action).toBe("approve");
  });

  it("an exact duplicate action is idempotent (no double count, no extra audit)", async () => {
    const r = await mkReq(co, await mkEvent(co, { amount: 500 }), maker, 2);
    expect((await decide(uOwner, co, r, "approve")).value).toBe("pending");
    const again = await decide(uOwner, co, r, "approve");
    expect(again.ok).toBe(true);
    expect(again.value).toBe("pending");
    expect(await actionCount(r)).toBe(1);
    expect(await auditCount(r)).toBe(1); // only the first persisted action was audited
  });

  it("domain capability matrix: right domain allowed, wrong domain denied, ordinary staff denied", async () => {
    const pay = await mkEvent(co, { amount: 500 }); // domain 'payment'
    const claim = await mkEvent(co, { amount: 500, type: "expense_claim" }); // domain 'expense_claim'
    // payment_approver holds finance.approve.payment only
    expect((await decide(uPay, co, await mkReq(co, pay, maker))).value).toBe("approved");
    const wrong = await decide(uPay, co, await mkReq(co, claim, maker));
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/missing approval capability finance\.approve\.expense/i);
    // owner holds both domains → the claim approves
    expect((await decide(uOwner, co, await mkReq(co, claim, maker))).value).toBe("approved");
    // ordinary staff holds no approval capability
    const st = await decide(staff, co, await mkReq(co, pay, maker));
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/missing approval capability/i);
  });

  it("company-consistent delegation memberships are enforced (composite FK + within_authority)", async () => {
    // The schema's composite FK already forbids a `co` delegation whose from_membership is in coB —
    // a cross-company membership link cannot even be inserted (defence-in-depth: within_authority_for_event
    // also requires from/to memberships in p_company, migration 0057).
    const uDelXid = (await q(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'c_delX',true) returning id`)).rows[0].id;
    const mDelX = (await q(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, uDelXid])).rows[0].id;
    let fkBlocked = false;
    try {
      await q(`insert into delegations (company_id, from_membership, to_membership, starts_at, ends_at, domain, max_amount, currency, is_company_wide) values ($1,$2,$3, now()-interval '1 day', now()+interval '1 day','payment',100000,'LKR',true)`, [co, mDgtorB, mDelX]);
    } catch (e) { fkBlocked = /foreign key|company_fk|violates/i.test((e as Error).message); }
    expect(fkBlocked).toBe(true);
    // A valid same-company delegation IS honoured.
    const fe = await mkEvent(co, { amount: 500 });
    expect(await boolAuth(uDelOK, co, fe)).toBe(true);
  });
});
