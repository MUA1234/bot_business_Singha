/**
 * WP12 EIGHTH (final) review — migration 0066. Live Postgres, ZERO-PERSISTENCE, REAL roles
 * (authenticated / service_role / a bespoke custom role), plus a GENUINE two-connection claim-vs-delete
 * and claim-vs-mutate race.
 *
 * (1) Signature-exact trusted-owner check — `_is_quotation_delivery_owner()` resolves the owner from the
 *     EXACT 9-arg `enqueue_quotation_outbox` identity. A fake overload `enqueue_quotation_outbox(int)`
 *     owned by a DIFFERENT role cannot flip the decision or open any INSERT/UPDATE/DELETE guard.
 * (2) DELETE boundary — a non-trusted writer cannot delete a queued/terminal quotation, nor one with ANY
 *     outbox delivery history; a draft with no outbox stays deletable; the owner keeps a maintenance override.
 * (3) Frozen snapshot — once queued/terminal, a non-trusted writer may change nothing except a pure
 *     sent→accepted/rejected decision; quotation_items of a frozen quotation are immutable too.
 * (4) Two-connection race — after conn A (worker, service_role) claims and commits an outbox row as
 *     `processing`, conn B cannot delete the quotation or mutate its payload / public token / totals /
 *     items; the worker can still complete queued→sent.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 12);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, capUser: string, customRole: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
// Run a statement as a real API role. "custom" carries capUser's JWT but a distinct current_user.
async function runAs(role: "auth" | "service" | "custom", sql: string, params: unknown[] = []): Promise<{ ok: boolean; code?: string; message?: string; rowCount?: number }> {
  await client.query("savepoint r");
  try {
    if (role === "service") {
      await client.query("set local role service_role");
      await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    } else {
      await client.query(`set local role ${role === "custom" ? customRole : "authenticated"}`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: capUser, role: "authenticated" })]);
    }
    const res = await client.query(sql, params);
    await client.query("reset role");
    await client.query("release savepoint r");
    return { ok: true, rowCount: res.rowCount ?? undefined };
  } catch (e) {
    await client.query("rollback to savepoint r");
    return { ok: false, code: (e as { code?: string }).code, message: (e as Error).message };
  }
}
async function seedQuotation(status: string, total = "100", qn = "SQ-" + rnd()) {
  const conv = (await q(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [co, "9471" + rnd()])).rows[0].id;
  const ord = (await q(`insert into orders (company_id, conversation_id, customer_phone, status) values ($1,$2,'9471','new') returning id`, [co, conv])).rows[0].id;
  const quo = (await q(`insert into quotations (company_id, order_id, quote_number, currency, status, total, public_token) values ($1,$2,$3,'LKR',$4,$5,$6) returning id`,
    [co, ord, qn, status, total, "tok_" + rnd()])).rows[0].id;
  return { ord, quo };
}
async function addOutbox(quo: string, status = "pending", key = "k_" + rnd()) {
  return (await q(`insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, source_type, source_id, message_purpose)
                   values ($1,'whatsapp','9471','b',$2,$3,'quotation',$4,'quotation') returning id`, [co, key, status, quo])).rows[0].id;
}
const statusOf = async (quo: string) => (await q(`select status from quotations where id=$1`, [quo])).rows[0].status;
const existsQuo = async (quo: string) => (await q(`select count(*)::int c from quotations where id=$1`, [quo])).rows[0].c === 1;

describe.skipIf(!enabled)("0066 snapshot + delete + exact-owner boundary (live, real roles)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await client.connect();
    await client.query("begin");
    co = (await client.query(`insert into companies (name, base_currency) values ('snap66','LKR') returning id`)).rows[0].id;
    capUser = randomUUID();
    await client.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [capUser]);
    await client.query(`insert into users (id, full_name, is_active) values ($1,'cap user',true)`, [capUser]);
    await client.query(`insert into profiles (id, company_id, username, department, is_admin, is_active) values ($1,$2,$3,'sales',false,true)`, [capUser, co, "cap_" + capUser.slice(0, 8)]);
    const mem = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, capUser])).rows[0].id;
    await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [mem, co]);
    customRole = "cust_" + rnd();
    await client.query(`create role ${customRole} nologin`);
    await client.query(`grant authenticated to ${customRole}`);
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  // ── (1) signature-exact owner check + overload inertness ──
  it("the owner check is signature-exact: a fake enqueue_quotation_outbox(int) overload cannot flip it", async () => {
    // owner (this connection) is trusted; service_role and the custom role are not
    expect((await q(`select public._is_quotation_delivery_owner() as v`)).rows[0].v).toBe(true);
    expect((await runAs("service", `select 1`)).ok).toBe(true); // sanity: role switch works
    // create a DIFFERENT-signature overload owned by the custom role
    await q(`create function public.enqueue_quotation_outbox(int) returns int language sql as 'select 1'`);
    await q(`alter function public.enqueue_quotation_outbox(int) owner to ${customRole}`);
    // the 9-arg identity still resolves to the real owner → decision unchanged
    expect((await q(`select public._is_quotation_delivery_owner() as v`)).rows[0].v).toBe(true);
    // and the custom role (which now OWNS the overload) is still NOT trusted
    await client.query("savepoint ov");
    await client.query(`set local role ${customRole}`);
    const asCustom = (await client.query(`select public._is_quotation_delivery_owner() as v`)).rows[0].v;
    await client.query("reset role");
    await client.query("release savepoint ov");
    expect(asCustom).toBe(false);
    // and the overload cannot open the INSERT guard for the custom role
    const r = await runAs("custom", `insert into quotations (company_id, quote_number, currency, status, total, public_token) values ($1,$2,'LKR','queued','100',$3)`,
      [co, "SQ-" + rnd(), "tok_" + rnd()]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    await q(`drop function public.enqueue_quotation_outbox(int)`); // clean up the overload
  });

  // ── (2) DELETE boundary ──
  it.each(["auth", "service", "custom"] as const)("%s cannot DELETE a queued quotation (42501)", async (role) => {
    const { quo } = await seedQuotation("queued");
    const r = await runAs(role, `delete from quotations where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code, r.message).toBe("42501");
    expect(await existsQuo(quo)).toBe(true);
  });

  it.each(["sent", "accepted", "rejected"] as const)("service cannot DELETE a %s (terminal) quotation (42501)", async (st) => {
    const { quo } = await seedQuotation(st);
    const r = await runAs("service", `delete from quotations where id=$1`, [quo]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
  });

  it.each(["auth", "service", "custom"] as const)("%s cannot DELETE a quotation with outbox history even if not yet queued (42501)", async (role) => {
    const { quo } = await seedQuotation("ready"); // a stale/legacy outbox row while still ready
    await addOutbox(quo, "pending");
    const r = await runAs(role, `delete from quotations where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code, r.message).toBe("42501");
    expect(await existsQuo(quo)).toBe(true);
  });

  it("a draft/awaiting_price quotation with NO outbox history remains deletable by the capability user", async () => {
    for (const st of ["draft", "awaiting_price"]) {
      const { quo } = await seedQuotation(st);
      const r = await runAs("auth", `delete from quotations where id=$1 and company_id=$2`, [quo, co]);
      expect(r.ok, `${st}: ${r.message}`).toBe(true);
      expect(r.rowCount).toBe(1);
      expect(await existsQuo(quo)).toBe(false);
    }
  });

  it("CASCADE regression pin: the capability user deletes a draft AND an awaiting_price quotation WITH items — parent and children both go", async () => {
    // The ON DELETE CASCADE child deletes run in the security context of the quotation_items table
    // OWNER (PostgreSQL RI semantics), which is the trusted delivery owner, so the fail-closed
    // freeze guard's NULL branch is never reached for an authorised parent delete. Migration 0067
    // asserts that ownership invariant fail-closed; this test pins the end-to-end behaviour — if the
    // invariant ever broke, the cascade would 42501 here.
    for (const st of ["draft", "awaiting_price"]) {
      const { quo } = await seedQuotation(st);
      await q(`insert into quotation_items (quotation_id, company_id, description, quantity, currency) values ($1,$2,'c1',1,'LKR')`, [quo, co]);
      await q(`insert into quotation_items (quotation_id, company_id, description, quantity, unit_price, currency, line_total, status) values ($1,$2,'c2',2,'5','LKR','10','priced')`, [quo, co]);
      const r = await runAs("auth", `delete from quotations where id=$1 and company_id=$2`, [quo, co]);
      expect(r.ok, `${st} with items: ${r.message}`).toBe(true);
      expect(r.rowCount).toBe(1);
      expect(await existsQuo(quo)).toBe(false);
      const kids = (await q(`select count(*)::int c from quotation_items where quotation_id=$1`, [quo])).rows[0].c;
      expect(kids, `${st}: children must cascade`).toBe(0);
    }
  });

  it("the trusted owner may delete a queued quotation (maintenance override)", async () => {
    const { quo } = await seedQuotation("queued");
    await q(`delete from quotations where id=$1`, [quo]); // owner context — no throw
    expect(await existsQuo(quo)).toBe(false);
  });

  // ── (3) frozen snapshot (UPDATE) ──
  it.each([
    ["notes", `notes='changed'`],
    ["total", `total='999'`],
    ["public_token", `public_token='tok_hijack'`],
    ["quote_number", `quote_number='SQ-HIJACK'`],
    ["currency", `currency='USD'`],
  ])("a queued quotation is frozen: authenticated cannot change %s (42501)", async (_label, setClause) => {
    const { quo } = await seedQuotation("queued", "120");
    const r = await runAs("auth", `update quotations set ${setClause} where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code, r.message).toBe("42501");
    expect(r.message).toMatch(/frozen|snapshot immutability/i);
  });

  it("the custom role also cannot mutate a frozen queued quotation's payload (42501)", async () => {
    const { quo } = await seedQuotation("queued", "120");
    const r = await runAs("custom", `update quotations set total='777' where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
  });

  it("sent→accepted / sent→rejected (status only) remains allowed for the capability user", async () => {
    for (const decision of ["accepted", "rejected"]) {
      const { quo } = await seedQuotation("sent");
      const r = await runAs("auth", `update quotations set status=$3 where id=$1 and company_id=$2`, [quo, co, decision]);
      expect(r.ok, r.message).toBe(true);
      expect(await statusOf(quo)).toBe(decision);
    }
  });

  it("a sent→accepted decision that ALSO changes a payload field is refused (42501)", async () => {
    const { quo } = await seedQuotation("sent");
    const r = await runAs("auth", `update quotations set status='accepted', notes='sneak' where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(await statusOf(quo)).toBe("sent"); // unchanged
  });

  it("direct sent_at fabrication on a frozen quotation stays blocked (42501)", async () => {
    const { quo } = await seedQuotation("queued");
    const r = await runAs("auth", `update quotations set sent_at=now() where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(r.message).toMatch(/sent_at/);
  });

  it("pre-queue editing/repricing remains functional (draft→awaiting_price→ready, totals, notes)", async () => {
    const { quo } = await seedQuotation("draft", "100");
    expect((await runAs("auth", `update quotations set status='ready', total='150', notes='priced' where id=$1 and company_id=$2`, [quo, co])).ok).toBe(true);
    expect((await runAs("auth", `update quotations set total='175' where id=$1 and company_id=$2`, [quo, co])).ok, "column-only reprice on ready").toBe(true);
    expect(await statusOf(quo)).toBe("ready");
  });

  // ── (3b) quotation_items frozen ──
  it("quotation_items cannot be INSERTed into a queued quotation by a non-trusted writer (42501)", async () => {
    const { quo } = await seedQuotation("queued");
    for (const role of ["auth", "custom"] as const) {
      const r = await runAs(role, `insert into quotation_items (quotation_id, company_id, description, quantity, currency) values ($1,$2,'x',1,'LKR')`, [quo, co]);
      expect(r.ok, role).toBe(false);
      expect(r.code, role).toBe("42501");
    }
  });

  it("quotation_items of a queued quotation cannot be UPDATEd or DELETEd by a non-trusted writer (42501)", async () => {
    const { quo } = await seedQuotation("ready");
    const item = (await q(`insert into quotation_items (quotation_id, company_id, description, quantity, currency) values ($1,$2,'seed',1,'LKR') returning id`, [quo, co])).rows[0].id;
    await q(`update quotations set status='queued' where id=$1`, [quo]); // freeze after the item exists (owner)
    const u = await runAs("auth", `update quotation_items set description='edited' where id=$1`, [item]);
    expect(u.ok).toBe(false); expect(u.code).toBe("42501");
    const d = await runAs("auth", `delete from quotation_items where id=$1`, [item]);
    expect(d.ok).toBe(false); expect(d.code).toBe("42501");
  });

  it("quotation_items remain editable while the quotation is pre-queue (draft)", async () => {
    const { quo } = await seedQuotation("draft");
    const ins = await runAs("auth", `insert into quotation_items (quotation_id, company_id, description, quantity, currency) values ($1,$2,'x',1,'LKR')`, [quo, co]);
    expect(ins.ok, ins.message).toBe(true);
    const item = (await q(`select id from quotation_items where quotation_id=$1 limit 1`, [quo])).rows[0].id;
    expect((await runAs("auth", `update quotation_items set unit_price='50', line_total='50', status='priced' where id=$1`, [item])).ok).toBe(true);
    expect((await runAs("auth", `delete from quotation_items where id=$1`, [item])).ok).toBe(true);
  });

  // ── search_path / pg_temp hardening: a temp table named pg_proc / message_outbox cannot forge the
  // owner check or hide real outbox history (the guards qualify pg_catalog.* / public.* and pin pg_temp
  // last). Without the fix, a temp `pg_proc` declaring the caller as owner would flip the owner check. ──
  it("pg_temp relation shadowing cannot forge the owner check or hide outbox history", async () => {
    const { quo } = await seedQuotation("ready");
    await addOutbox(quo, "pending"); // a REAL outbox row (seeded as owner, before the shadow)
    await client.query("savepoint shp");
    await client.query(`set local role authenticated`);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: capUser, role: "authenticated" })]);
    // plant hostile temp tables that shadow the catalog / the app table for UNQUALIFIED references
    await client.query(`create temp table pg_proc (proowner oid)`);
    await client.query(`insert into pg_proc(proowner) values (current_user::regrole::oid)`);
    await client.query(`create temp table message_outbox (company_id uuid, source_type text, source_id uuid)`); // empty → would hide history if unqualified
    const ownerV = (await client.query(`select public._is_quotation_delivery_owner() as v`)).rows[0].v;
    let delCode: string | undefined;
    try { await client.query(`delete from quotations where id=$1 and company_id=$2`, [quo, co]); }
    catch (e) { delCode = (e as { code?: string }).code; }
    // the expected 42501 aborts the tx; `rollback to savepoint shp` clears the abort AND reverts the
    // set-local-role + the hostile temp tables in one step (a bare `reset role` would fail with 25P02).
    await client.query(`rollback to savepoint shp`);
    expect(ownerV).toBe(false);       // owner check resisted the fake pg_proc
    expect(delCode).toBe("42501");    // real outbox history still seen via public.message_outbox → delete refused
  });

  // ── message_outbox content freeze: the DELIVERED message is immutable to service_role; delivery-state
  // stays worker-mutable; the claimed row cannot be deleted (would strand the quotation). ──
  it("message_outbox content (body/recipient/source) is frozen to service_role; delivery-state stays mutable; DELETE blocked", async () => {
    const { quo } = await seedQuotation("queued");
    const obId = await addOutbox(quo, "pending");
    expect((await runAs("service", `update message_outbox set body='hijacked price, pay +1-555' where id=$1`, [obId])).code).toBe("42501");
    expect((await runAs("service", `update message_outbox set recipient='15550000000' where id=$1`, [obId])).code).toBe("42501");
    expect((await runAs("service", `update message_outbox set source_id=gen_random_uuid() where id=$1`, [obId])).code).toBe("42501");
    // delivery-state (the worker's fenced path) is allowed
    const state = await runAs("service", `update message_outbox set status='failed', attempts=1, last_error='transient' where id=$1`, [obId]);
    expect(state.ok, state.message).toBe(true);
    // deleting the claimed row is refused (anti-stranding)
    expect((await runAs("service", `delete from message_outbox where id=$1`, [obId])).code).toBe("42501");
  });

  // ── TRUNCATE bypass: service_role holds TRUNCATE and it skips row-level triggers. The bare form is
  // independently FK-protected (0A000) on FK-target tables; the CASCADE form — the only one that would
  // otherwise wipe a table — is refused by the statement-level guard with 42501. A blocked TRUNCATE rolls
  // back, so it never wipes the shared transaction. ──
  it("a non-trusted role cannot TRUNCATE quotations / quotation_items / message_outbox (42501), bypassing the row triggers", async () => {
    expect((await runAs("service", `truncate quotations cascade`)).code).toBe("42501");
    expect((await runAs("service", `truncate quotation_items cascade`)).code).toBe("42501");
    expect((await runAs("service", `truncate message_outbox cascade`)).code).toBe("42501");
  });
});

// ── (4) GENUINE two-connection claim-then-delete / claim-then-mutate race ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, cA: any, cB: any;
let rco: string;

describe.skipIf(!enabled)("0066 two-connection claim-vs-delete/mutate race (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) }); await c.connect(); return c; };
    setup = await mk(); cA = await mk(); cB = await mk();
    await setup.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    // The real Supabase service client presents role=service_role in the JWT; set it session-level on the
    // worker connections so `caller_jwt_role()` sees it (the self-gating status helper relies on it).
    for (const c of [cA, cB]) await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    rco = (await setup.query(`insert into companies (name, base_currency) values ('race66','LKR') returning id`)).rows[0].id;
  });
  afterAll(async () => {
    for (const c of [cA, cB]) { try { await c?.query("rollback"); } catch { /* noop */ } }
    for (const sql of [`delete from message_outbox where company_id=$1`, `delete from quotation_items where company_id=$1`,
                       `delete from quotations where company_id=$1`, `delete from orders where company_id=$1`,
                       `delete from wa_conversations where company_id=$1`, `delete from companies where id=$1`]) {
      try { await setup.query(sql, [rco]); } catch { /* noop */ }
    }
    await Promise.all([cA?.end(), cB?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  async function seedQueuedWithClaim() {
    // as owner (setup): a ready quotation, then enqueue → queued + pending outbox row
    const conv = (await setup.query(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [rco, "9471" + rnd()])).rows[0].id;
    const ord = (await setup.query(`insert into orders (company_id, conversation_id, customer_phone, status) values ($1,$2,'9471','new') returning id`, [rco, conv])).rows[0].id;
    const quo = (await setup.query(`insert into quotations (company_id, order_id, quote_number, currency, status, total, public_token) values ($1,$2,$3,'LKR','ready','100',$4) returning id`,
      [rco, ord, "SQ-" + rnd(), "tok_" + rnd()])).rows[0].id;
    // One priced item matching the total — 0067's enqueue guard requires the live item sum to equal the
    // expected total unconditionally.
    await setup.query(`insert into quotation_items (quotation_id, company_id, description, quantity, unit_price, currency, line_total, status) values ($1,$2,'item',1,'100','LKR','100','priced')`, [quo, rco]);
    const key = "k_" + rnd();
    const enq = await setup.query(`select public.enqueue_quotation_outbox($1,$2,'9471','body',$3,'100','LKR','whatsapp','quotation') as v`, [rco, quo, key]);
    if (enq.rows[0].v !== "enqueued") throw new Error("seed enqueue: " + enq.rows[0].v);
    return { quo, key };
  }

  it("after conn A (service_role worker) claims + commits, conn B cannot delete the quotation, but A can still complete queued→sent", async () => {
    const { quo, key } = await seedQueuedWithClaim();
    // conn A: worker claims the row and COMMITS it as processing
    await cA.query("begin");
    await cA.query("set role service_role");
    const claimed = await cA.query(`select id from public.claim_outbox_batch(50,'workerA',120)`);
    await cA.query("commit");
    await cA.query("reset role");
    const obId = (await setup.query(`select id, status, lock_owner from message_outbox where idempotency_key=$1`, [key])).rows[0];
    expect(obId.status).toBe("processing");
    expect(claimed.rows.map((r: { id: string }) => r.id)).toContain(obId.id);

    // conn B: a DIFFERENT connection, service_role, tries to delete the (now claimed) quotation → refused
    await cB.query("begin");
    await cB.query("set role service_role");
    let delCode: string | undefined;
    try { await cB.query(`delete from quotations where id=$1`, [quo]); }
    catch (e) { delCode = (e as { code?: string }).code; }
    await cB.query("rollback");
    await cB.query("reset role");
    expect(delCode).toBe("42501");
    expect((await setup.query(`select count(*)::int c from quotations where id=$1`, [quo])).rows[0].c).toBe(1);

    // the worker (conn A) can still complete the claimed row → queued→sent
    await cA.query("begin");
    await cA.query("set role service_role");
    const done = await cA.query(`select public.complete_outbox_and_advance($1,'workerA','wamid.OK') as v`, [obId.id]);
    await cA.query("commit");
    await cA.query("reset role");
    expect(done.rows[0].v).toBe(true);
    expect((await setup.query(`select status from quotations where id=$1`, [quo])).rows[0].status).toBe("sent");
  });

  it("after conn A claims + commits, conn B cannot mutate the quotation payload, public token, totals, or its items", async () => {
    const { quo } = await seedQueuedWithClaim();
    // seed an item as owner while ready? it's already queued now; seed via owner override
    const item = (await setup.query(`insert into quotation_items (quotation_id, company_id, description, quantity, currency) values ($1,$2,'seed',1,'LKR') returning id`, [quo, rco])).rows[0].id;

    await cA.query("begin"); await cA.query("set role service_role");
    await cA.query(`select public.claim_outbox_batch(50,'workerA2',120)`);
    await cA.query("commit"); await cA.query("reset role");

    await cB.query("begin"); await cB.query("set role service_role");
    const attempts: Array<[string, unknown[]]> = [
      [`update quotations set total='999' where id=$1`, [quo]],
      [`update quotations set public_token='tok_hijack' where id=$1`, [quo]],
      [`update quotations set notes='sneak' where id=$1`, [quo]],
      [`update quotation_items set description='edited' where id=$1`, [item]],
      [`delete from quotation_items where id=$1`, [item]],
    ];
    const codes: string[] = [];
    for (const [sql, params] of attempts) {
      await cB.query("savepoint m");
      try { await cB.query(sql, params); codes.push("ALLOWED"); await cB.query("release savepoint m"); }
      catch (e) { codes.push((e as { code?: string }).code ?? "ERR"); await cB.query("rollback to savepoint m"); }
    }
    await cB.query("rollback"); await cB.query("reset role");
    expect(codes).toEqual(["42501", "42501", "42501", "42501", "42501"]);
    // payload intact
    const row = (await setup.query(`select total, public_token, notes from quotations where id=$1`, [quo])).rows[0];
    expect(row.total).toBe("100.00");
    expect(row.public_token).not.toBe("tok_hijack");
  });
});
