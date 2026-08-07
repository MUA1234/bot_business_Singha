/**
 * WP C outbox atomic claim — live, TWO real connections. Proves claim_outbox_batch
 * (migration 0040) leases rows so two workers never send the same row, recovers an
 * expired lease (crashed worker), and never claims dead-lettered rows.
 *
 * Setup rows are committed then cleaned up; claim transactions are rolled back, so
 * nothing is actually sent. Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any, c1: any, c2: any;
let company: string;

describe.skipIf(!enabled)("outbox atomic claim — live, two connections", () => {
  beforeAll(async () => {
    if (process.env.PRODUCTION_DB_HOST && URL.includes(process.env.PRODUCTION_DB_HOST)) {
      throw new Error("refusing to run write/commit integration tests against the production database host");
    }
    const { default: pg } = await import("pg" as string);
    const mk = async () => {
      const c = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
      await c.connect();
      return c;
    };
    setup = await mk();
    company = (await setup.query(`insert into companies (name, base_currency) values ('wp_outbox','LKR') returning id`)).rows[0].id;
    for (let i = 0; i < 8; i++) {
      await setup.query(
        `insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status)
         values ($1,'whatsapp','9471000000${i}','msg ${i}', $2, 'pending')`,
        [company, `ob_${company}_${i}`],
      );
    }
    c1 = await mk();
    c2 = await mk();
  });

  afterAll(async () => {
    try { await c1?.query("rollback"); } catch { /* noop */ }
    try { await c2?.query("rollback"); } catch { /* noop */ }
    try { await setup.query(`delete from message_outbox where company_id=$1`, [company]); } catch { /* noop */ }
    try { await setup.query(`delete from companies where id=$1`, [company]); } catch { /* noop */ }
    await Promise.all([c1?.end(), c2?.end(), setup?.end()].map((p) => p?.catch?.(() => {})));
  });

  it("two concurrent claims get disjoint rows (no double-send)", async () => {
    await c1.query("begin");
    const a = await c1.query(`select id from claim_outbox_batch(5,'w1',120)`);
    await c2.query("begin");
    const b = await c2.query(`select id from claim_outbox_batch(5,'w2',120)`);
    const A: string[] = a.rows.map((r: { id: string }) => r.id);
    const B: string[] = b.rows.map((r: { id: string }) => r.id);
    expect(A.length).toBeGreaterThan(0);
    expect(A.filter((id) => B.includes(id))).toEqual([]); // disjoint
    await c1.query("rollback");
    await c2.query("rollback");
  });

  it("a claimed row is 'processing' under a named lease", async () => {
    await c1.query("begin");
    const r = await c1.query(`select status, lock_owner, lease_expires_at from claim_outbox_batch(1,'w_lease',120)`);
    expect(r.rows[0].status).toBe("processing");
    expect(r.rows[0].lock_owner).toBe("w_lease");
    expect(r.rows[0].lease_expires_at).not.toBeNull();
    await c1.query("rollback");
  });

  it("an expired lease is recovered by the next claim", async () => {
    const id = (await setup.query(`select id from message_outbox where company_id=$1 order by created_at limit 1`, [company])).rows[0].id;
    await setup.query(`update message_outbox set status='processing', locked_at=now()-interval '1 hour', lock_owner='crashed', lease_expires_at=now()-interval '1 minute' where id=$1`, [id]);
    await c1.query("begin");
    const claimed = await c1.query(`select id from claim_outbox_batch(50,'w_recover',120)`);
    expect(claimed.rows.map((r: { id: string }) => r.id)).toContain(id);
    await c1.query("rollback");
    await setup.query(`update message_outbox set status='pending', locked_at=null, lock_owner=null, lease_expires_at=null where id=$1`, [id]);
  });

  it("dead-lettered rows are never claimed", async () => {
    const id = (await setup.query(`select id from message_outbox where company_id=$1 order by created_at limit 1`, [company])).rows[0].id;
    await setup.query(`update message_outbox set status='dead', dead_at=now() where id=$1`, [id]);
    await c1.query("begin");
    const claimed = await c1.query(`select id from claim_outbox_batch(50,'w_dead',120)`);
    expect(claimed.rows.map((r: { id: string }) => r.id)).not.toContain(id);
    await c1.query("rollback");
    await setup.query(`update message_outbox set status='pending', dead_at=null where id=$1`, [id]);
  });
});
