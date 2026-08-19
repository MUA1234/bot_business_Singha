/**
 * WP12 NINTH review — the quotation-item vs atomic-enqueue race (migration 0067). GENUINE two-connection
 * PostgreSQL tests, REAL roles. The parent quotation row is the SINGLE linearization lock: the item-freeze
 * guard takes it FOR UPDATE, and `enqueue_quotation_outbox` deliberately takes NO item-row locks (the
 * target item row is locked by Postgres BEFORE its row trigger fires, so child-row locking inside enqueue
 * would form a parent→child vs child→parent AB-BA deadlock — one lock object cannot form a cycle).
 *
 * The invariant: no committed outcome may contain a queued outbox snapshot that disagrees with the
 * committed quotation items/totals.
 *   - If the item mutation commits FIRST, `enqueue_quotation_outbox` observes the new authoritative item
 *     sum under the parent lock and returns `stale` (it never sends the old body). That includes deleting
 *     ALL items (sum 0 ≠ a non-zero expected total — no item-count exemption) and slipping in an
 *     UNPRICED item (refused outright).
 *   - If enqueue commits FIRST, the concurrent item mutation waits on the parent lock (taken by the
 *     item-freeze guard FOR UPDATE) and then fails 42501 because the quotation is `queued`.
 *   - A caller the guard cannot classify (raw service_role with NO PostgREST JWT claims — BYPASSRLS, so
 *     RLS is no backstop) is refused item writes outright: the freeze guard FAILS CLOSED on NULL.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 12);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });
const ENQ = `select public.enqueue_quotation_outbox($1,$2,'9471','body',$3,$4,'LKR','whatsapp','quotation') as v`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, cA: any, cB: any;
let co: string, coB: string, capUser: string;
const customRole = `wp12_custom_${rnd()}`;

// Seed (as owner) a `ready` quotation whose total equals the sum of its priced item line_totals.
async function seedReadyWithItems(company: string, total: string, lineTotals: string[]) {
  const conv = (await setup.query(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [company, "9471" + rnd()])).rows[0].id;
  const ord = (await setup.query(`insert into orders (company_id, conversation_id, customer_phone, status) values ($1,$2,'9471','new') returning id`, [company, conv])).rows[0].id;
  const quo = (await setup.query(`insert into quotations (company_id, order_id, quote_number, currency, status, total, public_token) values ($1,$2,$3,'LKR','ready',$4,$5) returning id`,
    [company, ord, "SQ-" + rnd(), total, "tok_" + rnd()])).rows[0].id;
  const itemIds: string[] = [];
  for (const lt of lineTotals) {
    const id = (await setup.query(`insert into quotation_items (quotation_id, company_id, description, quantity, unit_price, currency, line_total, status) values ($1,$2,'item',1,$3,'LKR',$3,'priced') returning id`, [quo, company, lt])).rows[0].id;
    itemIds.push(id);
  }
  return { quo, itemIds };
}
const statusOf = async (quo: string) => (await setup.query(`select status from quotations where id=$1`, [quo])).rows[0].status;
const rowsFor = async (key: string) => (await setup.query(`select count(*)::int c from message_outbox where idempotency_key=$1`, [key])).rows[0].c;
// cB acts as the capability user (authenticated) for direct item writes.
async function asCap(sql: string, params: unknown[] = []) {
  await cB.query("set role authenticated");
  await cB.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: capUser, role: "authenticated" })]);
  return cB.query(sql, params);
}

describe.skipIf(!enabled)("0067 enqueue vs item-mutation race (live, two connections)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) }); await c.connect(); return c; };
    setup = await mk(); cA = await mk(); cB = await mk();
    // A bespoke role that can WRITE the table but holds neither the capability nor the service
    // grant — the caller "fail closed" is really about after migration 0084.
    // BYPASSRLS deliberately: without it the role sees no rows, the trigger never fires, and the
    // UPDATE "succeeds" against zero rows — which would prove nothing. This mirrors exactly what the
    // original service_role session had, so the ONLY difference under test is the grant.
    await setup.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='${customRole}') then create role ${customRole} bypassrls; end if; end $$`);
    await setup.query(`grant authenticated to ${customRole}`);
    await setup.query(`grant usage on schema public to ${customRole}`);
    await setup.query(`grant select, insert, update, delete on public.quotation_items to ${customRole}`);
    await setup.query(`grant select on public.quotations to ${customRole}`);
    await setup.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    co = (await setup.query(`insert into companies (name, base_currency) values ('itemrace','LKR') returning id`)).rows[0].id;
    coB = (await setup.query(`insert into companies (name, base_currency) values ('itemraceB','LKR') returning id`)).rows[0].id;
    capUser = randomUUID();
    await setup.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [capUser]);
    await setup.query(`insert into users (id, full_name, is_active) values ($1,'cap',true)`, [capUser]);
    await setup.query(`insert into profiles (id, company_id, username, department, is_admin, is_active) values ($1,$2,$3,'sales',false,true)`, [capUser, co, "cap_" + capUser.slice(0, 8)]);
    const mem = (await setup.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, capUser])).rows[0].id;
    await setup.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [mem, co]);
  });
  afterAll(async () => {
    for (const c of [cA, cB]) { try { await c?.query("rollback"); } catch { /* noop */ } try { await c?.query("reset role"); } catch { /* noop */ } }
    for (const cid of [co, coB]) for (const sql of [`delete from message_outbox where company_id=$1`, `delete from quotation_items where company_id=$1`, `delete from quotations where company_id=$1`, `delete from orders where company_id=$1`, `delete from wa_conversations where company_id=$1`]) {
      try { await setup.query(sql, [cid]); } catch { /* noop */ }
    }
    try { await setup.query(`delete from membership_roles where company_id=$1`, [co]); } catch { /* noop */ }
    try { await setup.query(`delete from memberships where company_id=$1`, [co]); } catch { /* noop */ }
    for (const cid of [co, coB]) { try { await setup.query(`delete from companies where id=$1`, [cid]); } catch { /* noop */ } }
    for (const sql of [`revoke authenticated from ${customRole}`,
                       `revoke all on public.quotation_items from ${customRole}`,
                       `revoke all on public.quotations from ${customRole}`,
                       `revoke usage on schema public from ${customRole}`,
                       `drop role if exists ${customRole}`]) {
      try { await setup.query(sql); } catch { /* noop */ }
    }
    await Promise.all([cA?.end(), cB?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("item mutation commits FIRST → enqueue returns `stale`, no outbox row, quotation stays `ready`", async () => {
    const { quo, itemIds } = await seedReadyWithItems(co, "100", ["40", "60"]);
    const key = "k_" + rnd();
    // B changes an item (40 → 70): items now sum 130; quotations.total still 100 (no refresh)
    await cB.query("begin");
    await asCap(`update quotation_items set line_total='70', unit_price='70' where id=$1 and company_id=$2`, [itemIds[0], co]);
    await cB.query("commit"); await cB.query("reset role");
    // A enqueues with the OLD expected total (100) → the authoritative item sum (130) diverges → stale
    const r = await cA.query(ENQ, [co, quo, key, "100"]);
    expect(r.rows[0].v).toBe("stale");
    expect(await rowsFor(key)).toBe(0);
    expect(await statusOf(quo)).toBe("ready");
  });

  it("enqueue commits FIRST → the concurrent item mutation waits then fails 42501; one outbox row + `queued`", async () => {
    const { quo, itemIds } = await seedReadyWithItems(co, "100", ["40", "60"]);
    const key = "k_" + rnd();
    await cA.query("begin");
    const rA = await cA.query(ENQ, [co, quo, key, "100"]); // enqueues; holds parent + item locks
    expect(rA.rows[0].v).toBe("enqueued");
    // B tries to change an item; its freeze guard does SELECT parent FOR UPDATE → BLOCKS on A's lock
    await cB.query("begin");
    const pB = asCap(`update quotation_items set line_total='70', unit_price='70' where id=$1 and company_id=$2`, [itemIds[0], co]);
    await cA.query("commit"); // quotation → queued
    let code: string | undefined;
    try { await pB; } catch (e) { code = (e as { code?: string }).code; }
    await cB.query("rollback").catch(() => {}); await cB.query("reset role").catch(() => {});
    expect(code).toBe("42501"); // parent became queued while B waited → frozen
    expect(await rowsFor(key)).toBe(1);
    expect(await statusOf(quo)).toBe("queued");
    // and the item was NOT changed
    expect((await setup.query(`select line_total from quotation_items where id=$1`, [itemIds[0]])).rows[0].line_total).toBe("40.00");
  });

  it("no deadlock: enqueue holding the parent lock while an item mutation blocks then resolves cleanly", async () => {
    const { quo, itemIds } = await seedReadyWithItems(co, "50", ["50"]);
    const key = "k_" + rnd();
    await cA.query("begin");
    expect((await cA.query(ENQ, [co, quo, key, "50"])).rows[0].v).toBe("enqueued");
    await cB.query("begin");
    const pB = asCap(`update quotation_items set line_total='55', unit_price='55' where id=$1 and company_id=$2`, [itemIds[0], co]);
    await cA.query("commit");
    let deadlock = false, code: string | undefined;
    try { await pB; } catch (e) { code = (e as { code?: string }).code; deadlock = code === "40P01"; }
    await cB.query("rollback").catch(() => {}); await cB.query("reset role").catch(() => {});
    expect(deadlock).toBe(false); // no 40P01
    expect(code).toBe("42501");
  });

  it("no deadlock in the AB-BA window: enqueue completes even while another tx already holds an item-row lock", async () => {
    // This is the interleaving that DID deadlock when enqueue locked child rows: B holds an item-row lock
    // (as a plain SELECT ... FOR UPDATE — no trigger fires, no parent lock taken), then A enqueues. A
    // must NOT request item-row locks (single-lock design) — it completes despite B's held row lock; B's
    // subsequent trigger-guarded UPDATE then serializes on the parent lock and is refused (queued).
    const { quo, itemIds } = await seedReadyWithItems(co, "80", ["80"]);
    const key = "k_" + rnd();
    await cB.query("begin");
    const lockRes = await asCap(`select id from quotation_items where id=$1 and company_id=$2 for update`, [itemIds[0], co]);
    expect(lockRes.rowCount).toBe(1); // premise: B genuinely holds the child-row lock (not RLS-filtered)
    // A's enqueue would BLOCK (then deadlock on B's next statement) under child-row locking. It must complete.
    const rA = await cA.query(ENQ, [co, quo, key, "80"]); // autocommit → parent lock released at completion
    expect(rA.rows[0].v).toBe("enqueued");
    // B now mutates the item it still holds a row lock on → freeze guard takes the parent lock → queued → 42501
    let code: string | undefined;
    try { await asCap(`update quotation_items set line_total='90', unit_price='90' where id=$1 and company_id=$2`, [itemIds[0], co]); }
    catch (e) { code = (e as { code?: string }).code; }
    await cB.query("rollback").catch(() => {}); await cB.query("reset role").catch(() => {});
    expect(code).toBe("42501");
    expect(await rowsFor(key)).toBe(1);
    expect(await statusOf(quo)).toBe("queued");
    expect((await setup.query(`select line_total from quotation_items where id=$1`, [itemIds[0]])).rows[0].line_total).toBe("80.00");
  });

  it("delete-to-zero is closed: removing ALL items of a ready quotation makes enqueue return `stale` (no item-count exemption)", async () => {
    const { quo } = await seedReadyWithItems(co, "100", ["40", "60"]);
    const key = "k_" + rnd();
    // B (capability holder) deletes EVERY item and commits; quotations.total is untouched (still 100).
    await cB.query("begin");
    await asCap(`delete from quotation_items where quotation_id=$1 and company_id=$2`, [quo, co]);
    await cB.query("commit"); await cB.query("reset role");
    expect((await setup.query(`select count(*)::int c from quotation_items where quotation_id=$1`, [quo])).rows[0].c).toBe(0);
    // A enqueues with the stored total (100): live item sum is 0 → MUST be stale (a 100-total message
    // backed by zero items must never queue).
    const r = await cA.query(ENQ, [co, quo, key, "100"]);
    expect(r.rows[0].v).toBe("stale");
    expect(await rowsFor(key)).toBe(0);
    expect(await statusOf(quo)).toBe("ready");
  });

  it("an UNPRICED item slipped in after the refresh blocks enqueue (`stale`), even when the priced sum still matches", async () => {
    const { quo } = await seedReadyWithItems(co, "100", ["100"]);
    const key = "k_" + rnd();
    // B inserts an unpriced item (NULL unit_price/line_total — the state refreshQuotationStatus would
    // have held out of `ready`). SUM(line_total) ignores NULL, so the sum alone would still match.
    await cB.query("begin");
    await asCap(`insert into quotation_items (quotation_id, company_id, description, quantity, currency, status) values ($1,$2,'late',1,'LKR','needs_confirmation')`, [quo, co]);
    await cB.query("commit"); await cB.query("reset role");
    const r = await cA.query(ENQ, [co, quo, key, "100"]);
    expect(r.rows[0].v).toBe("stale"); // unpriced item present → refuse; it must re-enter the pricing flow
    expect(await rowsFor(key)).toBe(0);
    expect(await statusOf(quo)).toBe("ready");
  });

  it("a PRICED item with a NULL line_total blocks enqueue (`stale`): SUM skips NULL, so total 0 would otherwise ride", async () => {
    // status='priced' + non-null unit_price + NULL line_total — SUM(line_total)=0 equals the stored
    // total 0, so the pre-correction sum-only check would have enqueued a 0-total message for a priced item.
    const conv = (await setup.query(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [co, "9471" + rnd()])).rows[0].id;
    const ord = (await setup.query(`insert into orders (company_id, conversation_id, customer_phone, status) values ($1,$2,'9471','new') returning id`, [co, conv])).rows[0].id;
    const quo = (await setup.query(`insert into quotations (company_id, order_id, quote_number, currency, status, total, public_token) values ($1,$2,$3,'LKR','ready','0',$4) returning id`, [co, ord, "SQ-" + rnd(), "tok_" + rnd()])).rows[0].id;
    await setup.query(`insert into quotation_items (quotation_id, company_id, description, quantity, unit_price, currency, status) values ($1,$2,'nullline',1,'10','LKR','priced')`, [quo, co]);
    const key = "k_" + rnd();
    const r = await cA.query(ENQ, [co, quo, key, "0"]);
    expect(r.rows[0].v).toBe("stale"); // incomplete snapshot line (NULL line_total) → refuse
    expect(await rowsFor(key)).toBe(0);
    expect(await statusOf(quo)).toBe("ready");
  });

  it("a priced item in a DIFFERENT currency blocks enqueue (`stale`) even when the numeric sum matches", async () => {
    // LKR quotation, USD item whose line_total numerically equals the stored total — the public
    // quotation would render 'LKR 100.00' for a USD-priced line; it must never send.
    const conv = (await setup.query(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [co, "9471" + rnd()])).rows[0].id;
    const ord = (await setup.query(`insert into orders (company_id, conversation_id, customer_phone, status) values ($1,$2,'9471','new') returning id`, [co, conv])).rows[0].id;
    const quo = (await setup.query(`insert into quotations (company_id, order_id, quote_number, currency, status, total, public_token) values ($1,$2,$3,'LKR','ready','100',$4) returning id`, [co, ord, "SQ-" + rnd(), "tok_" + rnd()])).rows[0].id;
    await setup.query(`insert into quotation_items (quotation_id, company_id, description, quantity, unit_price, currency, line_total, status) values ($1,$2,'usd',1,'100','USD','100','priced')`, [quo, co]);
    const key = "k_" + rnd();
    const r = await cA.query(ENQ, [co, quo, key, "100"]);
    expect(r.rows[0].v).toBe("stale"); // currency-mismatched line → refuse (no conversion, no float)
    expect(await rowsFor(key)).toBe(0);
    expect(await statusOf(quo)).toBe("ready");
    // and the valid same-currency shape still enqueues (control)
    const { quo: quoOk } = await seedReadyWithItems(co, "100", ["100"]);
    const keyOk = "k_" + rnd();
    expect((await cA.query(ENQ, [co, quoOk, keyOk, "100"])).rows[0].v).toBe("enqueued");
    expect(await rowsFor(keyOk)).toBe(1);
    expect(await statusOf(quoOk)).toBe("queued");
  });

  it("FAIL CLOSED: the QUEUED freeze holds for the service worker, and an UNCLASSIFIABLE caller is refused outright", async () => {
    // SEMANTIC CHANGE, migration 0084 (FOUND-006), stated rather than absorbed.
    //
    // This case used to assert that a raw `service_role` session with NO JWT claims was refused
    // even PRE-queue, because the guard classified callers by the JWT CLAIM and a claimless session
    // could not be classified. 0084 replaced that with the database GRANT: a session holding the
    // `service_role` role IS the service worker whatever its request metadata says — which is the
    // point of the change, since request text is not privilege. So the service worker may now edit
    // a pre-queue item, exactly as it does when its claims are present.
    //
    // What must still hold, and does: the QUEUED freeze, and a refusal for a caller holding neither
    // the capability nor the grant.
    const { quo, itemIds } = await seedReadyWithItems(co, "30", ["30"]);
    const { default: pg } = await import("pg" as string);
    const cC = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await cC.connect(); // fresh connection: request.jwt.claims has never been set
    try {
      await cC.query("set role service_role");
      // PRE-QUEUE: allowed now, because the grant is the authorization.
      await cC.query(`update quotation_items set line_total='31' where id=$1 and company_id=$2`, [itemIds[0], co]);
      await cC.query(`update quotation_items set line_total='30' where id=$1 and company_id=$2`, [itemIds[0], co]);

      const key = "k_" + rnd();
      expect((await setup.query(ENQ, [co, quo, key, "30"])).rows[0].v).toBe("enqueued"); // owner ctx → queued

      // POST-QUEUE: the snapshot freeze still refuses the service worker itself. A queued quotation
      // is frozen for everyone but the trusted delivery owner.
      let postQueue: string | undefined;
      try { await cC.query(`update quotation_items set line_total='99' where id=$1 and company_id=$2`, [itemIds[0], co]); }
      catch (e) { postQueue = (e as { code?: string }).code; }
      expect(postQueue).toBe("42501");
      let delCode: string | undefined;
      try { await cC.query(`delete from quotation_items where id=$1 and company_id=$2`, [itemIds[0], co]); }
      catch (e) { delCode = (e as { code?: string }).code; }
      expect(delCode).toBe("42501");
      expect((await setup.query(`select line_total from quotation_items where id=$1`, [itemIds[0]])).rows[0].line_total).toBe("30.00");
    } finally {
      await cC.end().catch(() => {});
    }

    // AND the genuinely unclassifiable caller — neither capability nor grant — is refused even
    // pre-queue. That is where "fail closed" now lives.
    //
    // The role INHERITS `authenticated` deliberately. A bespoke role with no membership dies in the
    // ACL on `quotation_status_for_capable` — same SQLSTATE, so the assertion passed while never
    // reaching the guard at all (F-05). Inheriting `authenticated` lets it execute the capability
    // path, which then returns null for a caller with no capability, which is the branch under test.
    const { quo: quo2, itemIds: items2 } = await seedReadyWithItems(co, "40", ["40"]);
    await setup.query("begin");
    try {
      await setup.query(`set local role ${customRole}`);
      let code: string | undefined;
      let msg = "";
      try { await setup.query(`update quotation_items set line_total='41' where id=$1 and company_id=$2`, [items2[0], co]); }
      catch (e) { code = (e as { code?: string }).code; msg = (e as Error).message; }
      expect(code).toBe("42501");
      // The GUARD's refusal, not an ACL denial on the way to it.
      expect(msg).toMatch(/holds neither sales\.quotation\.manage/);
    } finally { await setup.query("rollback"); }
    expect(quo2).toBeTruthy();
  });

  it("two concurrent finalisers on an itemised quotation → exactly one logical outbox row (enqueued + duplicate)", async () => {
    const { quo } = await seedReadyWithItems(co, "100", ["100"]);
    const key = "k_" + rnd();
    await cA.query("begin");
    expect((await cA.query(ENQ, [co, quo, key, "100"])).rows[0].v).toBe("enqueued");
    await cB.query("begin");
    const p2 = cB.query(ENQ, [co, quo, key, "100"]); // service-context caller (no set role) blocks on the lock
    await cA.query("commit");
    const r2 = await p2;
    expect(r2.rows[0].v).toBe("duplicate");
    await cB.query("commit").catch(() => {});
    expect(await rowsFor(key)).toBe(1);
    expect(await statusOf(quo)).toBe("queued");
  });

  it("terminal-vs-enqueue race remains green: a concurrent sent transition wins → enqueue `terminal`, zero rows", async () => {
    const { quo } = await seedReadyWithItems(co, "100", ["100"]);
    const key = "k_" + rnd();
    await cA.query("begin");
    await cA.query(`update quotations set status='sent', sent_at=now() where id=$1 and status='ready'`, [quo]); // owner ctx (trusted)
    await cB.query("begin");
    const p2 = cB.query(ENQ, [co, quo, key, "100"]);
    await cA.query("commit");
    expect((await p2).rows[0].v).toBe("terminal");
    await cB.query("commit").catch(() => {});
    expect(await rowsFor(key)).toBe(0);
    expect(await statusOf(quo)).toBe("sent");
  });

  it("cross-company enqueue is still `inconsistent`; same-company itemised enqueue still works", async () => {
    const { quo: quoB } = await seedReadyWithItems(coB, "100", ["100"]);
    const key = "k_" + rnd();
    expect((await cA.query(ENQ, [co, quoB, key, "100"])).rows[0].v).toBe("inconsistent"); // wrong company
    expect(await rowsFor(key)).toBe(0);
    const { quo } = await seedReadyWithItems(co, "100", ["60", "40"]);
    const key2 = "k_" + rnd();
    expect((await cA.query(ENQ, [co, quo, key2, "100"])).rows[0].v).toBe("enqueued"); // matches item sum
    expect(await statusOf(quo)).toBe("queued");
  });

  it("pre-queue item editing stays functional (draft); post-queue items stay immutable (queued)", async () => {
    // draft: item edit allowed
    const conv = (await setup.query(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [co, "9471" + rnd()])).rows[0].id;
    const ord = (await setup.query(`insert into orders (company_id, conversation_id, customer_phone, status) values ($1,$2,'9471','new') returning id`, [co, conv])).rows[0].id;
    const quoD = (await setup.query(`insert into quotations (company_id, order_id, quote_number, currency, status, total, public_token) values ($1,$2,$3,'LKR','draft','0',$4) returning id`, [co, ord, "SQ-" + rnd(), "tok_" + rnd()])).rows[0].id;
    const itemD = (await setup.query(`insert into quotation_items (quotation_id, company_id, description, quantity, currency) values ($1,$2,'d',1,'LKR') returning id`, [quoD, co])).rows[0].id;
    await cB.query("begin");
    await expect(asCap(`update quotation_items set unit_price='10', line_total='10', status='priced' where id=$1 and company_id=$2`, [itemD, co])).resolves.toBeDefined();
    await cB.query("commit"); await cB.query("reset role");

    // queued: item edit refused
    const { quo, itemIds } = await seedReadyWithItems(co, "20", ["20"]);
    const key = "k_" + rnd();
    expect((await setup.query(ENQ, [co, quo, key, "20"])).rows[0].v).toBe("enqueued"); // owner ctx → queued
    await cB.query("begin");
    let code: string | undefined;
    try { await asCap(`update quotation_items set line_total='99' where id=$1 and company_id=$2`, [itemIds[0], co]); }
    catch (e) { code = (e as { code?: string }).code; }
    await cB.query("rollback").catch(() => {}); await cB.query("reset role").catch(() => {});
    expect(code).toBe("42501");
  });
});
