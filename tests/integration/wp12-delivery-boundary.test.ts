/**
 * WP12 FINAL review — the delivery-transition DB boundary (migrations 0064 → 0065) and the exact-payload
 * recovery guard. Live Postgres, ZERO-PERSISTENCE, using REAL PostgreSQL roles (authenticated /
 * service_role / a bespoke CUSTOM role), not the database owner.
 *
 * Correction 1 (0064) — the privileged DELIVERY transitions (ready→queued, queued→sent, ready→sent) are
 * RPC-ONLY. A direct table UPDATE by an authenticated user (WITH an active `owner_management`
 * membership that genuinely grants `sales.quotation.manage`, so the quotations RLS UPDATE policy
 * PERMITS the write and the trigger is actually reached) — or by `service_role` (which bypasses RLS) —
 * is refused by the lifecycle trigger with SQLSTATE 42501 and an "RPC-only" message. The transition can
 * happen only INSIDE the SECURITY DEFINER delivery RPCs, where `current_user` is the function owner.
 * The failure is proven to be the trigger, not an RLS zero-match, by showing the SAME user's legal
 * non-privileged transition succeeds (rowCount 1).
 *
 * Correction 2 (0064) — the `ready` + existing-outbox-row recovery inside `enqueue_quotation_outbox`
 * requires the existing row's EXACT delivery identity + payload (company, source type, source id, key,
 * channel, recipient, body, message purpose) to match, else it returns `inconsistent` and leaves the
 * quotation `ready` (never queue/drain a stale row).
 *
 * Correction (0065) — finding 2: close the direct-INSERT lifecycle bypass. A non-trusted writer may
 * create a quotation ONLY in the valid initial state (status='draft', sent_at null); a direct INSERT of
 * any delivery/terminal status (or a non-null sent_at) is refused with SQLSTATE 42501 for authenticated,
 * service_role, AND a bespoke CUSTOM role. The trusted-writer signal is a POSITIVE owner allowlist derived
 * from the delivery functions' OWNER — NOT a role-name denylist — so a NEW custom role (whose name is not
 * anon/authenticated/service_role) is ALSO refused both the fabricating INSERT and the privileged UPDATE,
 * which a denylist would have let through. `sent_at` may be mutated only in the trusted (owner) context.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 12);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let co: string, capUser: string;
// A bespoke custom role that INHERITS `authenticated`'s grants (so it can reach the table + RLS
// functions) but whose NAME is not in any denylist — the adversary the positive owner check must stop.
let customRole: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try { const r = await client.query(sql, params); await client.query("release savepoint s"); return r; }
  catch (e) { await client.query("rollback to savepoint s"); throw e; }
}
// Run a statement under a real API role (savepoint-isolated; the role + jwt reset on rollback).
// "custom" is the bespoke role: it carries capUser's JWT (so it passes the has_capability RLS policies
// exactly like `authenticated`) but its DB `current_user` is the custom role name — the case a role-name
// denylist would miss and the positive owner check must still refuse.
async function runAs(role: "auth" | "service" | "custom", sql: string, params: unknown[] = []): Promise<{ ok: boolean; code?: string; message?: string; rowCount?: number }> {
  await client.query("savepoint r");
  try {
    if (role === "service") {
      await client.query("set local role service_role");
      await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    } else {
      // authenticated OR the custom role — both act as capUser (a genuine capability holder).
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
// Direct INSERT of a quotation as `role`, at `status`, with optional non-null sent_at (ISO string).
async function insertQuotationAs(role: "auth" | "service" | "custom", status: string, sentAt: string | null = null) {
  return runAs(role, `insert into quotations (company_id, quote_number, currency, status, total, public_token, sent_at) values ($1,$2,'LKR',$3,'100',$4,$5)`,
    [co, "SQ-" + rnd(), status, "tok_" + rnd(), sentAt]);
}
async function seedQuotation(status: string, total = "100", currency = "LKR") {
  const conv = (await q(`insert into wa_conversations (company_id, customer_wa_id, status) values ($1,$2,'quoting') returning id`, [co, "9471" + rnd()])).rows[0].id;
  const ord = (await q(`insert into orders (company_id, conversation_id, customer_phone, status) values ($1,$2,'9471','new') returning id`, [co, conv])).rows[0].id;
  const quo = (await q(`insert into quotations (company_id, order_id, quote_number, currency, status, total, public_token) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [co, ord, "SQ-" + rnd(), currency, status, total, "tok_" + rnd()])).rows[0].id;
  return { conv, ord, quo };
}
const statusOf = async (quo: string) => (await q(`select status from quotations where id=$1`, [quo])).rows[0].status;
const rowsFor = async (key: string) => (await q(`select count(*)::int c from message_outbox where idempotency_key=$1`, [key])).rows[0].c;
const ENQ = `select public.enqueue_quotation_outbox($1,$2,$3,$4,$5,$6,$7,'whatsapp','quotation') as v`;

describe.skipIf(!enabled)("0064/0065 delivery-transition + INSERT boundary + exact-payload recovery (live, real roles incl. a custom role)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    co = (await client.query(`insert into companies (name, base_currency) values ('boundary','LKR') returning id`)).rows[0].id;
    // An authenticated user who genuinely passes the quotations RLS UPDATE policy (`has_capability`
    // via an active owner_management membership) AND the SELECT-visibility policy (legacy
    // `my_company()`/`my_department()` from `profiles`) — so a blocked privileged transition is proven
    // to be the RPC-only trigger, not an RLS zero-row filter. The same uuid is auth.uid() everywhere.
    capUser = randomUUID();
    await client.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [capUser]);
    await client.query(`insert into users (id, full_name, is_active) values ($1,'cap user',true)`, [capUser]);
    await client.query(`insert into profiles (id, company_id, username, department, is_admin, is_active) values ($1,$2,$3,'sales',false,true)`, [capUser, co, "cap_" + capUser.slice(0, 8)]);
    const mem = (await client.query(`insert into memberships (company_id, user_id, status) values ($1,$2,'active') returning id`, [co, capUser])).rows[0].id;
    await client.query(`insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,'owner_management')`, [mem, co]);
    // A bespoke custom role: inherits `authenticated`'s grants (table DML + RLS-helper EXECUTE) so it can
    // genuinely reach the quotations table and the trigger, but its name is NOT anon/authenticated/
    // service_role. Created inside the test transaction → rolled back in afterAll (no cluster leak).
    customRole = "cust_" + rnd();
    await client.query(`create role ${customRole} nologin`);
    await client.query(`grant authenticated to ${customRole}`);
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  // ── control: RLS genuinely permits this user, so a blocked privileged transition is the TRIGGER ──
  it("control: the capability user CAN perform a legal non-privileged transition (RLS permits → rowCount 1)", async () => {
    const { quo } = await seedQuotation("draft");
    const r = await runAs("auth", `update quotations set status='ready' where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok, r.message).toBe(true);
    expect(r.rowCount).toBe(1); // RLS matched and permitted — not a silent zero-row filter
    expect(await statusOf(quo)).toBe("ready");
  });

  // ── correction 1: privileged delivery transitions are RPC-only ──
  it("authenticated direct ready→queued is REFUSED by the RPC-only trigger (42501), not an RLS zero-match", async () => {
    const { quo } = await seedQuotation("ready");
    const r = await runAs("auth", `update quotations set status='queued' where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(r.message).toMatch(/RPC-only/);
    expect(await statusOf(quo)).toBe("ready"); // unchanged
  });

  it("authenticated direct ready→sent is REFUSED (42501, RPC-only)", async () => {
    const { quo } = await seedQuotation("ready");
    const r = await runAs("auth", `update quotations set status='sent' where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(r.message).toMatch(/RPC-only/);
  });

  it("direct SERVICE-ROLE ready→queued is REFUSED (42501, RPC-only) — service_role bypasses RLS but not the trigger", async () => {
    const { quo } = await seedQuotation("ready");
    const r = await runAs("service", `update quotations set status='queued' where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(r.message).toMatch(/RPC-only/);
  });

  it("direct SERVICE-ROLE ready→sent is REFUSED (42501, RPC-only)", async () => {
    const { quo } = await seedQuotation("ready");
    const r = await runAs("service", `update quotations set status='sent' where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(r.message).toMatch(/RPC-only/);
  });

  it("enqueue_quotation_outbox AS SERVICE ROLE succeeds: exactly one row + queued (transition allowed inside the RPC)", async () => {
    const { quo } = await seedQuotation("ready", "100");
    const key = "k_" + rnd();
    const r = await runAs("service", ENQ, [co, quo, "9471", "body", key, "100", "LKR"]);
    expect(r.ok, r.message).toBe(true);
    expect(await rowsFor(key)).toBe(1);
    expect(await statusOf(quo)).toBe("queued");
  });

  it("fenced complete_outbox_and_advance advances queued→sent (allowed inside the RPC)", async () => {
    const { quo } = await seedQuotation("queued", "100");
    const key = "k_" + rnd();
    const ob = (await q(`insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, lock_owner, locked_at, lease_expires_at, source_type, source_id, message_purpose) values ($1,'whatsapp','9471','b',$2,'processing','w1',now(),now()+interval '2 minutes','quotation',$3,'quotation') returning id`, [co, key, quo])).rows[0].id;
    const r = await runAs("service", `select public.complete_outbox_and_advance($1,'w1','wamid.OK') as v`, [ob]);
    expect(r.ok, r.message).toBe(true);
    expect(await statusOf(quo)).toBe("sent");
  });

  it("reconcile_quotation_from_outbox advances queued→sent only when a matching SENT quotation-outbox row exists", async () => {
    // matching sent row → reconciles
    const a = await seedQuotation("queued", "100");
    const keyA = "k_" + rnd();
    const obA = (await q(`insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, provider_message_id, source_type, source_id, message_purpose) values ($1,'whatsapp','9471','b',$2,'sent','wamid.A','quotation',$3,'quotation') returning id`, [co, keyA, a.quo])).rows[0].id;
    const rA = await runAs("service", `select public.reconcile_quotation_from_outbox($1) as v`, [obA]);
    expect(rA.ok, rA.message).toBe(true);
    expect(await statusOf(a.quo)).toBe("sent");

    // outbox not sent → reconcile returns false, quotation stays queued
    const b = await seedQuotation("queued", "100");
    const keyB = "k_" + rnd();
    const obB = (await q(`insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, source_type, source_id, message_purpose) values ($1,'whatsapp','9471','b',$2,'pending','quotation',$3,'quotation') returning id`, [co, keyB, b.quo])).rows[0].id;
    await runAs("service", `select public.reconcile_quotation_from_outbox($1) as v`, [obB]);
    expect(await statusOf(b.quo)).toBe("queued");
  });

  it("direct queued→accepted / queued→rejected remain blocked (illegal lifecycle) for the capability user", async () => {
    const { quo } = await seedQuotation("queued");
    for (const bad of ["accepted", "rejected"]) {
      const r = await runAs("auth", `update quotations set status=$3 where id=$1 and company_id=$2`, [quo, co, bad]);
      expect(r.ok, bad).toBe(false);
      expect(r.message, bad).toMatch(/illegal quotation status transition|lifecycle/i);
    }
  });

  it("sent→accepted / sent→rejected remain allowed through the authorised (capability) path", async () => {
    for (const good of ["accepted", "rejected"]) {
      const { quo } = await seedQuotation("sent");
      const r = await runAs("auth", `update quotations set status=$3 where id=$1 and company_id=$2`, [quo, co, good]);
      expect(r.ok, r.message).toBe(true);
      expect(r.rowCount, good).toBe(1);
      expect(await statusOf(quo)).toBe(good);
    }
  });

  it("pre-queue re-pricing transitions remain functional for the capability user (ready→awaiting_price→ready)", async () => {
    const { quo } = await seedQuotation("ready");
    expect((await runAs("auth", `update quotations set status='awaiting_price' where id=$1 and company_id=$2`, [quo, co])).ok).toBe(true);
    expect((await runAs("auth", `update quotations set status='ready' where id=$1 and company_id=$2`, [quo, co])).ok).toBe(true);
    expect(await statusOf(quo)).toBe("ready");
  });

  // ── finding 2 (0065): the direct-INSERT lifecycle boundary — non-trusted writers create only drafts ──
  it.each(["auth", "service", "custom"] as const)("%s: direct INSERT of a DRAFT quotation (sent_at null) is allowed", async (role) => {
    const r = await insertQuotationAs(role, "draft");
    expect(r.ok, r.message).toBe(true);
    expect(r.rowCount).toBe(1);
  });

  // Every non-draft initial status is refused for every non-owner writer — including a custom role a
  // role-name denylist would not have covered. (`queued`/`sent`/`accepted`/`rejected` are the fabrication
  // targets; `ready` proves the boundary is "draft only", not merely "not a delivery state".)
  it.each([
    ["auth", "ready"], ["auth", "queued"], ["auth", "sent"], ["auth", "accepted"], ["auth", "rejected"],
    ["service", "ready"], ["service", "queued"], ["service", "sent"], ["service", "accepted"], ["service", "rejected"],
    ["custom", "ready"], ["custom", "queued"], ["custom", "sent"], ["custom", "accepted"], ["custom", "rejected"],
  ] as const)("%s: direct INSERT of status=%s is REFUSED at the initial-state boundary (42501)", async (role, status) => {
    const r = await insertQuotationAs(role, status);
    expect(r.ok).toBe(false);
    expect(r.code, r.message).toBe("42501");
    expect(r.message).toMatch(/initial state|draft/i);
  });

  it.each(["auth", "service", "custom"] as const)("%s: direct INSERT of a draft with a non-null sent_at is REFUSED (42501)", async (role) => {
    const r = await insertQuotationAs(role, "draft", new Date(Date.now() - 1000).toISOString());
    expect(r.ok).toBe(false);
    expect(r.code, r.message).toBe("42501");
  });

  // The custom role is the denylist adversary: its name is not anon/authenticated/service_role, so the
  // 0064 denylist would have let these privileged transitions THROUGH. The 0065 positive owner check
  // refuses them because current_user (the custom role) is not the delivery-function owner.
  it("custom role: direct ready→queued is REFUSED by the positive owner check (42501, RPC-only)", async () => {
    const { quo } = await seedQuotation("ready");
    const r = await runAs("custom", `update quotations set status='queued' where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(r.message).toMatch(/RPC-only/);
    expect(await statusOf(quo)).toBe("ready");
  });

  it("custom role: direct ready→sent is REFUSED (42501, RPC-only)", async () => {
    const { quo } = await seedQuotation("ready");
    const r = await runAs("custom", `update quotations set status='sent' where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(r.message).toMatch(/RPC-only/);
  });

  it("custom role: direct queued→sent is REFUSED (42501, RPC-only)", async () => {
    const { quo } = await seedQuotation("queued");
    const r = await runAs("custom", `update quotations set status='sent' where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(r.message).toMatch(/RPC-only/);
  });

  it("custom role: legal non-privileged transitions still work (draft→ready, sent→accepted)", async () => {
    const d = await seedQuotation("draft");
    expect((await runAs("custom", `update quotations set status='ready' where id=$1 and company_id=$2`, [d.quo, co])).ok).toBe(true);
    expect(await statusOf(d.quo)).toBe("ready");
    const s = await seedQuotation("sent");
    const r = await runAs("custom", `update quotations set status='accepted' where id=$1 and company_id=$2`, [s.quo, co]);
    expect(r.ok, r.message).toBe(true);
    expect(await statusOf(s.quo)).toBe("accepted");
  });

  // sent_at is delivery-completion metadata: only the trusted (owner) RPC context may set/change it.
  it.each(["auth", "custom"] as const)("%s: mutating sent_at directly (no status change) is REFUSED (42501)", async (role) => {
    const { quo } = await seedQuotation("ready");
    const r = await runAs(role, `update quotations set sent_at=now() where id=$1 and company_id=$2`, [quo, co]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
    expect(r.message).toMatch(/sent_at/);
    expect(await statusOf(quo)).toBe("ready");
  });

  // ── correction 2: exact-payload recovery on the ready + existing-row path ──
  async function readyWithExistingRow(rowOverrides: { channel?: string; recipient?: string; body?: string; purpose?: string }) {
    const { quo } = await seedQuotation("ready", "120");
    const key = "k_" + rnd();
    await q(`insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, source_type, source_id, message_purpose)
             values ($1,$2,$3,$4,$5,'pending','quotation',$6,$7)`,
      [co, rowOverrides.channel ?? "whatsapp", rowOverrides.recipient ?? "9471", rowOverrides.body ?? "body-120", key, quo, rowOverrides.purpose ?? "quotation"]);
    return { quo, key };
  }

  it("ready + existing row with a STALE body/total → inconsistent, quotation stays ready, no second row", async () => {
    const { quo } = await seedQuotation("ready", "120");
    const key = "k_" + rnd();
    // a pre-existing pending row carrying the OLD body/total (100); the quotation was later repriced to 120
    await q(`insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, source_type, source_id, message_purpose) values ($1,'whatsapp','9471','body-100',$2,'pending','quotation',$3,'quotation')`, [co, key, quo]);
    const r = await q(`select public.enqueue_quotation_outbox($1,$2,'9471','body-120',$3,'120','LKR','whatsapp','quotation') as v`, [co, quo, key]);
    expect(r.rows[0].v).toBe("inconsistent"); // stale row must not be recovered
    expect(await statusOf(quo)).toBe("ready");
    expect(await rowsFor(key)).toBe(1); // no second row
  });

  it.each([
    ["wrong recipient", { recipient: "9999" }],
    ["wrong channel", { channel: "email" }],
    ["wrong message purpose", { purpose: "reminder" }],
  ])("ready + existing row with %s → inconsistent (mismatched payload is not a valid duplicate)", async (_label, overrides) => {
    const { quo, key } = await readyWithExistingRow(overrides as any);
    const r = await q(`select public.enqueue_quotation_outbox($1,$2,'9471','body-120',$3,'120','LKR','whatsapp','quotation') as v`, [co, quo, key]);
    expect(r.rows[0].v).toBe("inconsistent");
    expect(await statusOf(quo)).toBe("ready");
    expect(await rowsFor(key)).toBe(1);
  });

  it("ready + EXACT existing payload → duplicate, one row only, recovers to queued", async () => {
    const { quo, key } = await readyWithExistingRow({ body: "body-120" });
    const r = await q(`select public.enqueue_quotation_outbox($1,$2,'9471','body-120',$3,'120','LKR','whatsapp','quotation') as v`, [co, quo, key]);
    expect(r.rows[0].v).toBe("duplicate");
    expect(await statusOf(quo)).toBe("queued");
    expect(await rowsFor(key)).toBe(1);
  });

  it("stale total/currency checks still fire before the existing-row path", async () => {
    const { quo, key } = await readyWithExistingRow({ body: "body-120" });
    // expected total 999 != locked 120 → stale (not inconsistent, not duplicate)
    expect((await q(`select public.enqueue_quotation_outbox($1,$2,'9471','body-120',$3,'999','LKR','whatsapp','quotation') as v`, [co, quo, key])).rows[0].v).toBe("stale");
    expect(await statusOf(quo)).toBe("ready");
  });
});
