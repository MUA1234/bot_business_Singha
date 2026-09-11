/**
 * Permanent gate for the identity drift found on production on 2026-09-11 — live, against real
 * Postgres, ZERO-PERSISTENCE (one transaction, rolled back; nothing is committed).
 *
 * The defect: migration 0010 backfilled `users`/`memberships`/`membership_roles` from `profiles`
 * once, at migration time, and the admin panel only ever wrote `profiles`. Five of eight live
 * employees therefore had no identity row at all: able to sign in (legacy `lib/auth.ts` reads
 * `profiles`), but invisible to `has_membership()`, `has_capability()` and `lib/access.ts` — and
 * denied outright the moment `RLS_READS`/`RLS_WRITES` become the enforcement path (D-019).
 *
 * Nothing in the schema forbids that state, so it can drift again silently. These tests assert
 * the invariant directly, against whatever data the database holds:
 *
 *   every profile has a users row · every profile has a membership in its own company ·
 *   every membership carries at least one role · an inactive profile is never actively a member
 *
 * Skipped unless `DATABASE_URL` is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

describe.skipIf(!enabled)("identity consistency — profiles vs the membership model", () => {
  beforeAll(async () => {
    const pg = await import("pg");
    client = new pg.default.Client({ connectionString: URL, ssl: false });
    await client.connect();
    await client.query("begin");
  });
  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      await client.end();
    }
  });

  it("every profile has a users row (the FK target memberships need)", async () => {
    const { rows } = await client.query(
      `select p.username from profiles p where not exists (select 1 from users u where u.id = p.id)`,
    );
    expect(rows.map((r: { username: string }) => r.username)).toEqual([]);
  });

  it("every profile has a membership in its OWN company", async () => {
    const { rows } = await client.query(
      `select p.username
         from profiles p
        where not exists (
          select 1 from memberships m where m.user_id = p.id and m.company_id = p.company_id
        )`,
    );
    expect(rows.map((r: { username: string }) => r.username)).toEqual([]);
  });

  it("every membership carries at least one role (a membership with none grants nothing)", async () => {
    const { rows } = await client.query(
      `select m.id
         from memberships m
        where not exists (select 1 from membership_roles mr where mr.membership_id = m.id)`,
    );
    expect(rows.map((r: { id: string }) => r.id)).toEqual([]);
  });

  it("an admin profile holds the system_administrator role", async () => {
    const { rows } = await client.query(
      `select p.username
         from profiles p
         join memberships m on m.user_id = p.id and m.company_id = p.company_id
        where p.is_admin
          and not exists (
            select 1 from membership_roles mr
             where mr.membership_id = m.id and mr.role_key = 'system_administrator'
          )`,
    );
    expect(rows.map((r: { username: string }) => r.username)).toEqual([]);
  });

  it("a deactivated profile never keeps an ACTIVE membership", async () => {
    // Otherwise the suspension reaches only the legacy model, and `has_membership()` still
    // grants the account access once RLS is the enforcement path.
    const { rows } = await client.query(
      `select p.username
         from profiles p
         join memberships m on m.user_id = p.id and m.company_id = p.company_id
        where p.is_active = false and m.status = 'active'`,
    );
    expect(rows.map((r: { username: string }) => r.username)).toEqual([]);
  });

  it("a membership_role never crosses companies", async () => {
    const { rows } = await client.query(
      `select mr.membership_id
         from membership_roles mr
         join memberships m on m.id = mr.membership_id
        where mr.company_id <> m.company_id`,
    );
    expect(rows).toEqual([]);
  });
});
