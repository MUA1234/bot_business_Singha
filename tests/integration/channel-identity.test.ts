/**
 * Migration 0070 — trusted channel identity resolution, against a disposable local PostgreSQL.
 *
 * The property under test: identity is decided by records the business holds, resolution is
 * company-scoped, and anything less than exactly one match fails closed. Synthetic data only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const mkSsl = (u: string) => (/localhost|127\.0\.0\.1/.test(u) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any, authed: any;
let coA: string, coB: string;

const resolve = (c: any, company: string, channel: string, raw: string) =>
  c.query(`select * from resolve_channel_identity($1,$2,$3)`, [company, channel, raw]);

if (enabled) {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    const mk = async () => { const c = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) }); await c.connect(); return c; };
    db = await mk(); authed = await mk();
    await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    await authed.query(`select set_config('request.jwt.claims', '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111"}', false)`);
    coA = (await db.query(`insert into companies (name, base_currency) values ('ident_A','LKR') returning id`)).rows[0].id;
    coB = (await db.query(`insert into companies (name, base_currency) values ('ident_B','LKR') returning id`)).rows[0].id;
  });
  afterAll(async () => {
    for (const co of [coA, coB]) {
      try { await db.query(`delete from channel_identities where company_id=$1`, [co]); } catch { /* noop */ }
      try { await db.query(`delete from companies where id=$1`, [co]); } catch { /* noop */ }
    }
    await Promise.all([authed?.end(), db?.end()].map((p: any) => p?.catch?.(() => {})));
  });
}

describe.skipIf(!enabled)("0070 channel identity resolution (live DB)", () => {
  it("normalises phone-like identities to digits and email to lower-case", async () => {
    const r = await db.query(
      `select normalize_channel_identity('whatsapp','+94 77 123 4567') a,
              normalize_channel_identity('email','  Staff@Example.COM ') b,
              normalize_channel_identity('whatsapp','') c`,
    );
    expect(r.rows[0].a).toBe("94771234567");
    expect(r.rows[0].b).toBe("staff@example.com");
    expect(r.rows[0].c).toBeNull();
  });

  it("resolves a staff number to staff, and the same digits in a different format", async () => {
    const staffId = randomUUID();
    await db.query(
      `insert into channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
       values ($1,'whatsapp','94771230001','staff',$2,'Synthetic Staff')`,
      [coA, staffId],
    );

    const exact = await resolve(db, coA, "whatsapp", "94771230001");
    expect(exact.rows[0].actor_type).toBe("staff");
    expect(exact.rows[0].actor_id).toBe(staffId);
    expect(exact.rows[0].match).toBe("exact");

    // Same person, written the way a phone shows it.
    const formatted = await resolve(db, coA, "whatsapp", "+94 77 123 0001");
    expect(formatted.rows[0].actor_type).toBe("staff");
    expect(formatted.rows[0].match).toBe("exact");

    // Local format — matched by national suffix, still uniquely.
    const local = await resolve(db, coA, "whatsapp", "0771230001");
    expect(local.rows[0].actor_type).toBe("staff");
    expect(local.rows[0].match).toBe("suffix");
  });

  it("an unknown number resolves to unknown, never to staff", async () => {
    const r = await resolve(db, coA, "whatsapp", "94999999999");
    expect(r.rows[0].actor_type).toBe("unknown");
    expect(r.rows[0].actor_id).toBeNull();
    expect(r.rows[0].match).toBe("no_match");
  });

  it("two parties sharing a national suffix resolve to AMBIGUOUS, not a guess", async () => {
    await db.query(
      `insert into channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
       values ($1,'whatsapp','94771230002','staff',$2,'Staff Two'),
              ($1,'whatsapp','11771230002','customer',$3,'Customer Two')`,
      [coA, randomUUID(), randomUUID()],
    );
    const r = await resolve(db, coA, "whatsapp", "0771230002");
    expect(r.rows[0].actor_type).toBe("ambiguous");
    expect(r.rows[0].actor_id).toBeNull();
    expect(r.rows[0].match).toBe("suffix_multiple");
  });

  it("identity NEVER resolves across companies", async () => {
    const staffId = randomUUID();
    await db.query(
      `insert into channel_identities (company_id, channel, identity, actor_type, actor_id)
       values ($1,'whatsapp','94771230003','staff',$2)`,
      [coA, staffId],
    );
    // Company A knows this number; company B must not.
    expect((await resolve(db, coA, "whatsapp", "94771230003")).rows[0].actor_type).toBe("staff");
    expect((await resolve(db, coB, "whatsapp", "94771230003")).rows[0].actor_type).toBe("unknown");
  });

  it("the same number may be a customer in one company and staff in another", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await db.query(
      `insert into channel_identities (company_id, channel, identity, actor_type, actor_id)
       values ($1,'whatsapp','94771230004','staff',$3), ($2,'whatsapp','94771230004','customer',$4)`,
      [coA, coB, a, b],
    );
    expect((await resolve(db, coA, "whatsapp", "94771230004")).rows[0].actor_type).toBe("staff");
    expect((await resolve(db, coB, "whatsapp", "94771230004")).rows[0].actor_type).toBe("customer");
  });

  it("one identity cannot be claimed by two parties in the same company", async () => {
    await db.query(
      `insert into channel_identities (company_id, channel, identity, actor_type, actor_id)
       values ($1,'whatsapp','94771230005','customer',$2)`,
      [coA, randomUUID()],
    );
    // A second party asserting the same number is refused by the unique index — this is what makes
    // "exactly one match" a guarantee rather than a hope.
    await expect(
      db.query(
        `insert into channel_identities (company_id, channel, identity, actor_type, actor_id)
         values ($1,'whatsapp','94771230005','staff',$2)`,
        [coA, randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it("a non-service caller is refused by the RPC's own in-function gate", async () => {
    // `authed` sets a JWT claim of `authenticated` while the connection itself remains superuser —
    // the harness convention in this suite. That exercises the IN-FUNCTION `caller_jwt_role()` gate,
    // which is the control that protects a caller arriving through PostgREST as service_role
    // without the right claims. Grant-based protection is asserted separately below, because a
    // superuser connection can never demonstrate a missing GRANT.
    await expect(resolve(authed, coA, "whatsapp", "94771230001")).rejects.toThrow();
  });

  it("neither function is EXECUTE-reachable by anon or authenticated", async () => {
    const r = await db.query(`
      select p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE') anon_ok,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_ok
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('resolve_channel_identity','normalize_channel_identity')
       order by p.proname`);
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.anon_ok, `${row.proname} reachable by anon`).toBe(false);
      expect(row.auth_ok, `${row.proname} reachable by authenticated`).toBe(false);
    }
  });

  it("an unscoped resolution is refused", async () => {
    await expect(db.query(`select * from resolve_channel_identity(null,'whatsapp','94771230001')`)).rejects.toThrow();
  });
});
