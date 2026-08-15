/**
 * WP11 — complete approval authority: organisational scope, strict currency, and delegation
 * bounds. Live Postgres, ZERO-PERSISTENCE.
 *
 * Proves migration 0054: within_authority_for_event(company, financial_event) enforces, for
 * auth.uid(): active membership; domain; STRICT event currency (a NULL rule/delegation currency is
 * not a wildcard); the WHOLE-event amount vs the ceiling (splitting across allocations cannot
 * bypass it); every allocation within an authorised scope (division/project/site/cost-centre);
 * explicit company-wide authority when the event has no allocations (never inferred from NULL
 * scope); and a delegation bounded by its validity window, amount, currency AND by being a subset
 * of the delegator's own currency-matched, sufficient, active authority. decide_approval authorises
 * a financial event through this function; maker-checker and lifecycle are unchanged.
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string;
let divA: string, divB: string, projA: string, projB: string, siteA: string, siteB: string, ccA: string, ccB: string;
let maker: string;
let uCW: string, uProjA: string, uDivA: string, uSiteA: string, uCCA: string, uCeil: string, uUnscoped: string, uNone: string;
let uDelOK: string, uDelCcy: string, uDelScopeB: string, uDelCeilHi: string, uDelExpired: string, uDelSuspFrom: string, uDelSuspTo: string;

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
async function boolAuth(u: string, fe: string): Promise<boolean> {
  await asUser(u);
  try { const r = await q(`select public.within_authority_for_event($1,$2) as v`, [co, fe]); return r.rows[0].v === true; }
  finally { await asSuper(); }
}
// The OLD (0046) currency-blind delegation check, retained for non-event callers — used here as a
// regression witness that the new function closes Problem #2.
async function boolOld(u: string, domain: string, amount: number, ccy: string): Promise<boolean> {
  await asUser(u);
  try { const r = await q(`select public.within_authority($1,$2,$3,$4) as v`, [co, domain, amount, ccy]); return r.rows[0].v === true; }
  finally { await asSuper(); }
}
async function decide(u: string, req: string, action = "approve"): Promise<{ ok: boolean; value?: string; error?: string }> {
  await asUser(u);
  let r: { ok: boolean; value?: string; error?: string };
  try { const res = await q(`select public.decide_approval($1,$2,$3) as v`, [co, req, action]); r = { ok: true, value: res.rows[0]?.v }; }
  catch (e) { r = { ok: false, error: (e as Error).message }; }
  await asSuper(); return r;
}
async function mkEvent(amount: number, ccy: string): Promise<string> {
  return (await q(`insert into financial_events (company_id, event_type, state, amount, currency, correlation_id) values ($1,'payment','detected',${amount},'${ccy}','corr_'||gen_random_uuid()) returning id`, [co])).rows[0].id;
}
async function addAlloc(fe: string, amount: number, s: { div?: string; proj?: string; site?: string; cc?: string } = {}) {
  await q(`insert into financial_event_allocations (financial_event_id, company_id, amount, division_id, project_id, site_id, cost_centre_id) values ($1,$2,$3,$4,$5,$6,$7)`,
    [fe, co, amount, s.div ?? null, s.proj ?? null, s.site ?? null, s.cc ?? null]);
}
async function mkReq(fe: string, submittedBy = maker, required = 1): Promise<string> {
  return (await q(`insert into approval_requests (company_id, financial_event_id, status, approvals_required, submitted_by) values ($1,$2,'pending',$3,$4) returning id`, [co, fe, required, submittedBy])).rows[0].id;
}

describe.skipIf(!enabled)("WP11 approval scope/currency/delegation — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    co = (await client.query(`insert into companies (name, base_currency) values ('wp11','LKR') returning id`)).rows[0].id;
    const mkScope = async (table: string, name: string) => (await client.query(`insert into ${table} (company_id, name) values ($1,$2) returning id`, [co, name])).rows[0].id;
    divA = await mkScope("divisions", "DivA"); divB = await mkScope("divisions", "DivB");
    projA = await mkScope("projects", "ProjA"); projB = await mkScope("projects", "ProjB");
    siteA = await mkScope("sites", "SiteA"); siteB = await mkScope("sites", "SiteB");
    ccA = await mkScope("cost_centres", "CcA"); ccB = await mkScope("cost_centres", "CcB");

    const mkUser = async (n: string) => (await client.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),$1,true) returning id`, [n])).rows[0].id;
    const mkMem = async (u: string, role: string | null, status = "active"): Promise<string> => {
      const id = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,$3) returning id`, [co, u, status])).rows[0].id;
      if (role) await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)`, [id, co, role]);
      return id;
    };
    // A rule scoped for `who`; `scope` gives is_company_wide + the scope columns.
    const mkRule = async (mem: string, s: { cw?: boolean; div?: string; proj?: string; site?: string; cc?: string; max?: number; ccy?: string }) => {
      await client.query(
        `insert into authority_rules (membership_id, company_id, domain, max_amount, currency, is_company_wide, division_id, project_id, site_id, cost_centre_id)
         values ($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9)`,
        [mem, co, s.max ?? 100000, s.ccy ?? "LKR", s.cw ?? false, s.div ?? null, s.proj ?? null, s.site ?? null, s.cc ?? null]);
    };

    maker = await mkUser("wp11_maker"); await mkMem(maker, "staff_submitter");

    uCW = await mkUser("wp11_cw"); await mkRule(await mkMem(uCW, "owner_management"), { cw: true });
    uProjA = await mkUser("wp11_projA"); await mkRule(await mkMem(uProjA, "owner_management"), { proj: projA });
    uDivA = await mkUser("wp11_divA"); await mkRule(await mkMem(uDivA, "owner_management"), { div: divA });
    uSiteA = await mkUser("wp11_siteA"); await mkRule(await mkMem(uSiteA, "owner_management"), { site: siteA });
    uCCA = await mkUser("wp11_ccA"); await mkRule(await mkMem(uCCA, "owner_management"), { cc: ccA });
    uCeil = await mkUser("wp11_ceil"); await mkRule(await mkMem(uCeil, "owner_management"), { cw: true, max: 1000 });
    uUnscoped = await mkUser("wp11_unscoped"); await mkRule(await mkMem(uUnscoped, "owner_management"), { cw: false }); // max 100000, LKR, NO scope, NOT company-wide
    uNone = await mkUser("wp11_none"); await mkMem(uNone, "owner_management"); // holds 'approve' but NO authority rule

    // Delegator: project-A authority, ceiling 1000, LKR (NOT company-wide).
    const uDgtor = await mkUser("wp11_dgtor"); const mDgtor = await mkMem(uDgtor, "owner_management");
    await mkRule(mDgtor, { proj: projA, max: 1000 });
    const mkDeleg = async (toMem: string, s: { proj?: string; div?: string; ccy?: string; max?: number; from?: string; expired?: boolean; cw?: boolean }) => {
      const win = s.expired ? `now()-interval '10 day', now()-interval '5 day'` : `now()-interval '1 day', now()+interval '1 day'`;
      await client.query(
        `insert into delegations (company_id, from_membership, to_membership, starts_at, ends_at, domain, max_amount, currency, is_company_wide, division_id, project_id)
         values ($1,$2,$3, ${win}, 'payment', $4, $5, $6, $7, $8)`,
        [co, s.from ?? mDgtor, toMem, s.max ?? 1000, s.ccy ?? "LKR", s.cw ?? false, s.div ?? null, s.proj ?? null]);
    };
    uDelOK = await mkUser("wp11_delOK"); await mkDeleg(await mkMem(uDelOK, null), { proj: projA });
    uDelCcy = await mkUser("wp11_delCcy"); await mkDeleg(await mkMem(uDelCcy, null), { proj: projA, ccy: "USD" }); // delegator lacks USD
    uDelScopeB = await mkUser("wp11_delScopeB"); await mkDeleg(await mkMem(uDelScopeB, null), { proj: projB }); // delegator only has projA
    uDelCeilHi = await mkUser("wp11_delCeilHi"); await mkDeleg(await mkMem(uDelCeilHi, null), { proj: projA, max: 5000 }); // delegator ceiling 1000
    uDelExpired = await mkUser("wp11_delExp"); await mkDeleg(await mkMem(uDelExpired, null), { proj: projA, expired: true });
    // Suspended delegator: project-A authority but membership suspended → cannot confer.
    const uDgtorSusp = await mkUser("wp11_dgtorSusp"); const mDgtorSusp = await mkMem(uDgtorSusp, "owner_management", "suspended");
    await mkRule(mDgtorSusp, { proj: projA, max: 1000 });
    uDelSuspFrom = await mkUser("wp11_delSuspFrom"); await mkDeleg(await mkMem(uDelSuspFrom, null), { proj: projA, from: mDgtorSusp });
    // Suspended delegate: active delegation but the delegate's own membership is suspended.
    uDelSuspTo = await mkUser("wp11_delSuspTo"); await mkDeleg(await mkMem(uDelSuspTo, null, "suspended"), { proj: projA });
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("no authority rule, and unscoped non-company-wide authority, are both denied", async () => {
    const fe = await mkEvent(500, "LKR"); // no allocations
    expect(await boolAuth(uNone, fe)).toBe(false);      // no rule at all
    expect(await boolAuth(uUnscoped, fe)).toBe(false);   // NULL scope + is_company_wide=false → nothing
  });

  it("explicit company-wide authority approves a no-allocation event within domain/amount/currency", async () => {
    expect(await boolAuth(uCW, await mkEvent(999, "LKR"))).toBe(true);
  });

  it("each organisational scope dimension is enforced (A can approve A, not B)", async () => {
    // project
    const feProjA = await mkEvent(500, "LKR"); await addAlloc(feProjA, 500, { proj: projA });
    const feProjB = await mkEvent(500, "LKR"); await addAlloc(feProjB, 500, { proj: projB });
    expect(await boolAuth(uProjA, feProjA)).toBe(true);
    expect(await boolAuth(uProjA, feProjB)).toBe(false);
    // division
    const feDivA = await mkEvent(500, "LKR"); await addAlloc(feDivA, 500, { div: divA });
    const feDivB = await mkEvent(500, "LKR"); await addAlloc(feDivB, 500, { div: divB });
    expect(await boolAuth(uDivA, feDivA)).toBe(true);
    expect(await boolAuth(uDivA, feDivB)).toBe(false);
    // site
    const feSiteA = await mkEvent(500, "LKR"); await addAlloc(feSiteA, 500, { site: siteA });
    const feSiteB = await mkEvent(500, "LKR"); await addAlloc(feSiteB, 500, { site: siteB });
    expect(await boolAuth(uSiteA, feSiteA)).toBe(true);
    expect(await boolAuth(uSiteA, feSiteB)).toBe(false);
    // cost centre
    const feCCA = await mkEvent(500, "LKR"); await addAlloc(feCCA, 500, { cc: ccA });
    const feCCB = await mkEvent(500, "LKR"); await addAlloc(feCCB, 500, { cc: ccB });
    expect(await boolAuth(uCCA, feCCA)).toBe(true);
    expect(await boolAuth(uCCA, feCCB)).toBe(false);
  });

  it("a mixed-scope event is denied if ANY allocation is outside authority", async () => {
    const fe = await mkEvent(1000, "LKR");
    await addAlloc(fe, 600, { proj: projA }); // inside uProjA's scope
    await addAlloc(fe, 400, { proj: projB }); // outside → whole event denied
    expect(await boolAuth(uProjA, fe)).toBe(false);
    // company-wide covers both
    expect(await boolAuth(uCW, fe)).toBe(true);
  });

  it("splitting an event across allocations cannot bypass the whole-event ceiling", async () => {
    const big = await mkEvent(1500, "LKR"); // exceeds uCeil's 1000 ceiling
    await addAlloc(big, 800, {}); await addAlloc(big, 700, {}); // company-wide allocations, each < 1000
    expect(await boolAuth(uCeil, big)).toBe(false); // ceiling compares to the WHOLE 1500
    const ok = await mkEvent(900, "LKR"); await addAlloc(ok, 900, {});
    expect(await boolAuth(uCeil, ok)).toBe(true);
  });

  it("currency is strict: LKR authority cannot approve a USD event", async () => {
    expect(await boolAuth(uCW, await mkEvent(500, "USD"))).toBe(false); // uCW is LKR
    expect(await boolAuth(uCW, await mkEvent(500, "LKR"))).toBe(true);
  });

  it("delegation is bounded by the delegator's currency, scope and the lower of the two ceilings", async () => {
    // valid: project A, LKR, within both ceilings (1000)
    const feA = await mkEvent(800, "LKR"); await addAlloc(feA, 800, { proj: projA });
    expect(await boolAuth(uDelOK, feA)).toBe(true);
    // currency the delegator lacks (delegation USD, delegator only LKR)
    const feUSD = await mkEvent(800, "USD"); await addAlloc(feUSD, 800, { proj: projA });
    // Problem #2 witness: the OLD within_authority accepted this (delegator currency never checked);
    // the new event-aware function denies it.
    expect(await boolOld(uDelCcy, "payment", 800, "USD")).toBe(true);   // the bug
    expect(await boolAuth(uDelCcy, feUSD)).toBe(false);                  // fixed
    // scope the delegator lacks (delegation project B, delegator only project A)
    const feB = await mkEvent(800, "LKR"); await addAlloc(feB, 800, { proj: projB });
    expect(await boolAuth(uDelScopeB, feB)).toBe(false);
    // exceeds the LOWER ceiling: delegation 5000 but delegator only 1000, event 1500
    const feHi = await mkEvent(1500, "LKR"); await addAlloc(feHi, 1500, { proj: projA });
    expect(await boolAuth(uDelCeilHi, feHi)).toBe(false);
    // …but the same delegate can approve within the delegator's 1000 ceiling
    const feLo = await mkEvent(900, "LKR"); await addAlloc(feLo, 900, { proj: projA });
    expect(await boolAuth(uDelCeilHi, feLo)).toBe(true);
  });

  it("expired delegation, suspended delegator and suspended delegate are denied", async () => {
    const fe = await mkEvent(800, "LKR"); await addAlloc(fe, 800, { proj: projA });
    expect(await boolAuth(uDelExpired, fe)).toBe(false);
    expect(await boolAuth(uDelSuspFrom, fe)).toBe(false); // delegator membership suspended
    expect(await boolAuth(uDelSuspTo, fe)).toBe(false);   // delegate membership suspended
  });

  it("decide_approval end-to-end: company-wide approves; an out-of-scope allocation denies; maker-checker holds", async () => {
    // company-wide approves a scoped event
    const fe1 = await mkEvent(500, "LKR"); await addAlloc(fe1, 500, { proj: projB });
    expect((await decide(uCW, await mkReq(fe1))).value).toBe("approved");
    // project-A approver cannot approve a project-B allocation
    const fe2 = await mkEvent(500, "LKR"); await addAlloc(fe2, 500, { proj: projB });
    const d2 = await decide(uProjA, await mkReq(fe2));
    expect(d2.ok).toBe(false);
    expect(d2.error).toMatch(/approval authority/i);
    // maker cannot approve their own request (even with company-wide authority)
    const fe3 = await mkEvent(500, "LKR");
    const r3 = await mkReq(fe3, uCW); // submitted BY uCW
    const d3 = await decide(uCW, r3);
    expect(d3.ok).toBe(false);
    expect(d3.error).toMatch(/separation of duties|maker cannot approve/i);
  });
});

// ── Concurrency: two concurrent final approvals serialise on the request FOR UPDATE lock ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, c1: any, c2: any;
let cco: string, cReq: string, cApprover: string;

describe.skipIf(!enabled)("WP11 approval concurrency — live, two connections", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } }); await c.connect(); return c; };
    setup = await mk();
    cco = (await setup.query(`insert into companies (name, base_currency) values ('wp11c','LKR') returning id`)).rows[0].id;
    const maker2 = (await setup.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'c_maker',true) returning id`)).rows[0].id;
    await setup.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active')`, [cco, maker2]);
    cApprover = (await setup.query(`insert into users (id, full_name, is_active) values (gen_random_uuid(),'c_appr',true) returning id`)).rows[0].id;
    const mAppr = (await setup.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [cco, cApprover])).rows[0].id;
    await setup.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [mAppr, cco]);
    await setup.query(`insert into authority_rules (membership_id, company_id, domain, max_amount, currency, is_company_wide) values ($1,$2,'payment',100000,'LKR',true)`, [mAppr, cco]);
    const fe = (await setup.query(`insert into financial_events (company_id, event_type, state, amount, currency, correlation_id) values ($1,'payment','detected',500,'LKR','corr_'||gen_random_uuid()) returning id`, [cco])).rows[0].id;
    cReq = (await setup.query(`insert into approval_requests (company_id, financial_event_id, status, approvals_required, submitted_by) values ($1,$2,'pending',1,$3) returning id`, [cco, fe, maker2])).rows[0].id;
    c1 = await mk(); c2 = await mk();
  });
  afterAll(async () => {
    try { await c1?.query("rollback"); } catch { /* noop */ }
    try { await c2?.query("rollback"); } catch { /* noop */ }
    for (const sql of [`delete from approval_actions where company_id=$1`, `delete from audit_events where company_id=$1`, `delete from approval_requests where company_id=$1`, `delete from financial_events where company_id=$1`, `delete from authority_rules where company_id=$1`, `delete from membership_roles where company_id=$1`, `delete from memberships where company_id=$1`, `delete from companies where id=$1`]) {
      try { await setup.query(sql, [cco]); } catch { /* noop */ }
    }
    await Promise.all([c1?.end(), c2?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("a second concurrent final approval BLOCKS on the request FOR UPDATE lock", async () => {
    const claims = JSON.stringify({ sub: cApprover, role: "authenticated" });
    const sql = `select public.decide_approval($1,$2,'approve')`;
    await c1.query("begin");
    await c1.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await c1.query(sql, [cco, cReq]); // approves + holds the request lock (uncommitted)
    await c2.query("begin");
    await c2.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await c2.query("set local statement_timeout = '1500ms'");
    let blocked = false;
    try { await c2.query(sql, [cco, cReq]); } catch (e) { blocked = /statement timeout|canceling statement/i.test((e as Error).message); }
    await c1.query("rollback").catch(() => {});
    await c2.query("rollback").catch(() => {});
    expect(blocked).toBe(true);
  });
});
