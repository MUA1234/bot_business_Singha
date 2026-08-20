/**
 * FOUND-003 — the RECEIVING account decides the company (migration 0074). Live PostgreSQL.
 *
 * The webhook used to stamp a hardcoded pilot company on every inbound message. These scenarios
 * prove the replacement resolves from configuration, refuses to guess, and that the documented
 * single-tenant bridge exists on exactly the two conditions it claims and disappears the moment
 * either one stops holding.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let coA: string, coB: string;

const resolve = async (channel: string, account: string) =>
  (await db.query(`select * from public.resolve_channel_company($1,$2)`, [channel, account])).rows[0];

describe.skipIf(!enabled)("0074 — receiving-account → company resolution (live)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    coA = (await db.query(`insert into companies (name, base_currency) values ('chanacctA','LKR') returning id`)).rows[0].id;
    coB = (await db.query(`insert into companies (name, base_currency) values ('chanacctB','LKR') returning id`)).rows[0].id;
  });
  afterAll(async () => {
    for (const c of [coA, coB]) {
      try { await db.query(`delete from channel_accounts where company_id=$1`, [c]); } catch { /* noop */ }
      try { await db.query(`delete from companies where id=$1`, [c]); } catch { /* noop */ }
    }
    await db?.end().catch(() => {});
  });

  it("an exactly-mapped account resolves to its company", async () => {
    const acct = `wa_${rnd()}`;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coA, acct]);
    const r = await resolve("whatsapp", acct);
    expect(r.match).toBe("exact");
    expect(r.company_id).toBe(coA);
  });

  it("matching is case-insensitive and whitespace-tolerant, but NOT digit-stripping", async () => {
    const acct = `WA_${rnd()}`;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`,
      [coA, acct.toLowerCase()]);
    expect((await resolve("whatsapp", `  ${acct}  `)).company_id).toBe(coA);
    // A dialled-number spelling of the same digits is a DIFFERENT identifier, not a match: the
    // provider account id is an opaque id, and treating the two as interchangeable would let a
    // typo in configuration silently route another company's traffic.
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp','94711234567')`, [coA]);
    expect((await resolve("whatsapp", "+94 71 123 4567")).match).toBe("unmapped");
  });

  it("ONE account cannot belong to two companies", async () => {
    const acct = `wa_${rnd()}`;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coA, acct]);
    await expect(
      db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coB, acct]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("a deactivated mapping frees the account and stops resolving", async () => {
    const acct = `wa_${rnd()}`;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coA, acct]);
    await db.query(`update channel_accounts set is_active=false where provider_account_id=$1`, [acct]);
    expect((await resolve("whatsapp", acct)).match).toBe("unmapped");
    // …and the account may then be given to another company.
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coB, acct]);
    expect((await resolve("whatsapp", acct)).company_id).toBe(coB);
  });

  it("an unknown account resolves to NOTHING while other mappings exist", async () => {
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coA, `wa_${rnd()}`]);
    const r = await resolve("whatsapp", `never_mapped_${rnd()}`);
    expect(r.match).toBe("unmapped");
    expect(r.company_id).toBeNull();
  });

  it("an empty or blank account id is refused without a lookup", async () => {
    for (const bad of ["", "   "]) {
      const r = await resolve("whatsapp", bad);
      expect(r.match).toBe("empty");
      expect(r.company_id).toBeNull();
    }
  });

  it("channels are separate namespaces", async () => {
    const acct = `shared_${rnd()}`;
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp',$2)`, [coA, acct]);
    await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'email',$2)`, [coB, acct]);
    expect((await resolve("whatsapp", acct)).company_id).toBe(coA);
    expect((await resolve("email", acct)).company_id).toBe(coB);
  });

  it("THE BRIDGE: with no mappings for the channel and exactly ONE company, it resolves — and the moment either condition breaks, it does not", async () => {
    await db.query("begin");
    try {
      // Condition A alone (no mappings) is NOT enough while several companies exist.
      await db.query(`delete from channel_accounts where channel='whatsapp'`);
      const many = (await db.query(`select count(*)::int c from companies`)).rows[0].c;
      expect(many).toBeGreaterThan(1);
      expect((await resolve("whatsapp", "unmapped_account")).match).toBe("unmapped");

      // Both conditions: exactly one company, and no mapping for the channel.
      //
      // Reaching "exactly one company" means removing every other company, and companies are
      // referenced by ~60 tables with RESTRICT. Referential integrity is not what is under test
      // here (other suites prove it), the database is disposable, and the whole block is rolled
      // back — so FK triggers are suspended for this transaction rather than hand-deleting the
      // world. If the connection may not do that, the test FAILS rather than quietly proving less.
      await db.query("set local session_replication_role = replica");
      await db.query(`delete from companies where id <> $1`, [coA]);
      const one = await resolve("whatsapp", "unmapped_account");
      expect(one.match).toBe("single_tenant_fallback");
      expect(one.company_id).toBe(coA);

      // Configure ANY mapping for the channel and the bridge closes immediately — an unmapped
      // account is then a configuration gap, not a default.
      await db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp','configured')`, [coA]);
      expect((await resolve("whatsapp", "unmapped_account")).match).toBe("unmapped");
      expect((await resolve("whatsapp", "configured")).match).toBe("exact");
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });

  it("the resolver is service-only: an authenticated caller is refused 42501", async () => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
      await expect(db.query(`select * from public.resolve_channel_company('whatsapp','x')`))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback");
      await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    }
  });

  it("the mapping table is not writable by an untrusted role", async () => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await expect(
        db.query(`insert into channel_accounts (company_id, channel, provider_account_id) values ($1,'whatsapp','hijack')`, [coA]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("rollback");
    }
  });
});
