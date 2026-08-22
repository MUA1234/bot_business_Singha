/**
 * OF-018 — inbound-review service authority comes from EXECUTE grants, not request claims.
 *
 * Runs from real login roles so the test cannot accidentally prove a superuser's privileges.
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
const rnd = () => Math.random().toString(36).slice(2, 10);
const mkSsl = (url: string) => (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let companyId: string;
let reviewerId: string;
const suffix = rnd();
const roles = {
  service: `of018_service_${suffix}`,
  authenticated: `of018_authenticated_${suffix}`,
  anon: `of018_anon_${suffix}`,
};
const connections: any[] = [];

async function connectAs(role: string) {
  const { default: pg } = await import("pg" as string);
  const client = new pg.Client({
    connectionString: URL.replace(/\/\/[^@]*@/, `//${role}:probe@`),
    ssl: mkSsl(URL),
  });
  await client.connect();
  connections.push(client);
  return client;
}

describe.skipIf(!enabled)("OF-018 — inbound-review grants decide service authority", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    db = new pg.Client({ connectionString: URL, ssl: mkSsl(URL) });
    await db.connect();

    for (const role of Object.values(roles)) {
      await db.query(`drop role if exists ${role}`);
      await db.query(`create role ${role} login password 'probe'`);
    }
    await db.query(`grant service_role to ${roles.service}`);
    await db.query(`grant authenticated to ${roles.authenticated}`);
    await db.query(`grant anon to ${roles.anon}`);

    companyId = (await db.query(
      `insert into companies (name, base_currency) values ($1, 'LKR') returning id`,
      [`of018-${suffix}`],
    )).rows[0].id;
    reviewerId = randomUUID();
    await db.query(`insert into auth.users (id) values ($1)`, [reviewerId]);
    await db.query(`insert into users (id, full_name, is_active) values ($1, 'OF-018 reviewer', true)`, [reviewerId]);
    const membershipId = (await db.query(
      `insert into memberships (company_id, user_id, status) values ($1, $2, 'active') returning id`,
      [companyId, reviewerId],
    )).rows[0].id;
    await db.query(
      `insert into membership_roles (membership_id, company_id, role_key) values ($1, $2, 'owner_management')`,
      [membershipId, companyId],
    );
  });

  afterAll(async () => {
    for (const connection of connections) await connection.end().catch(() => {});
    for (const statement of [
      `delete from audit_events where company_id = $1`,
      `delete from inbound_reviews where company_id = $1`,
      `delete from membership_roles where company_id = $1`,
      `delete from memberships where company_id = $1`,
      `delete from companies where id = $1`,
    ]) {
      try { await db.query(statement, [companyId]); } catch { /* cleanup best effort */ }
    }
    try { await db.query(`delete from users where id = $1`, [reviewerId]); } catch { /* cleanup best effort */ }
    for (const role of Object.values(roles)) {
      try { await db.query(`drop role if exists ${role}`); } catch { /* cleanup best effort */ }
    }
    await db?.end().catch(() => {});
  });

  it("a service-granted login can record without claims and resolve with conflicting claim text", async () => {
    const service = await connectAs(roles.service);
    const recorded = (await service.query(
      `select * from public.record_inbound_review($1, 'whatsapp', $2, 'needs_human', null, null, null, null, null, null)`,
      [companyId, `wamid.of018.${rnd()}`],
    )).rows[0];
    expect(recorded.created).toBe(true);

    await service.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', false)`);
    const resolved = (await service.query(
      `select * from public.resolve_inbound_review($1, $2, $3, 'resolved', 'handled')`,
      [companyId, recorded.review_id, reviewerId],
    )).rows[0];
    expect(resolved).toMatchObject({ review_id: recorded.review_id, state: "resolved" });
  });

  it("anon and authenticated logins cannot gain either RPC by forging service_role claim text", async () => {
    for (const role of [roles.anon, roles.authenticated]) {
      const apiRole = await connectAs(role);
      await apiRole.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
      const recordError = await apiRole.query(
        `select * from public.record_inbound_review($1, 'whatsapp', 'of018-denied', 'needs_human', null, null, null, null, null, null)`,
        [companyId],
      ).then(() => null).catch((error: any) => error);
      const resolveError = await apiRole.query(
        `select * from public.resolve_inbound_review($1, $2, $3, 'dismissed', null)`,
        [companyId, randomUUID(), reviewerId],
      ).then(() => null).catch((error: any) => error);
      expect(recordError?.code, `${role} record`).toBe("42501");
      expect(resolveError?.code, `${role} resolve`).toBe("42501");
    }
  });
});