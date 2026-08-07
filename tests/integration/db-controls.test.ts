/**
 * WP1.6 / WP2 database-enforced controls — live, against real Postgres, ZERO-PERSISTENCE
 * (single transaction + savepoints + ROLLBACK; nothing is committed). Proves the DB
 * itself enforces:
 *   - caller-idempotency: a duplicate (company, scope, key) is rejected (§WP2.2)
 *   - composite company FKs: a child cannot reference a parent in another company (§WP1.6)
 *
 * Skipped unless `DATABASE_URL` is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let companyA: string, companyB: string;

async function q(sql: string, params: unknown[] = []) {
  await client.query("savepoint s");
  try {
    const r = await client.query(sql, params);
    await client.query("release savepoint s");
    return r;
  } catch (e) {
    await client.query("rollback to savepoint s");
    throw e;
  }
}
async function expectReject(sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    await q(sql, params);
    return false;
  } catch {
    return true;
  }
}

describe.skipIf(!enabled)("DB-enforced controls — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    const co = async (n: string) => (await client.query(`insert into companies (name, base_currency) values ($1,'LKR') returning id`, [n])).rows[0].id;
    companyA = await co("wp_ctl_A");
    companyB = await co("wp_ctl_B");
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("idempotency_keys: a duplicate (company, scope, key) is rejected (§WP2.2)", async () => {
    await q(`insert into idempotency_keys (company_id, scope, key) values ($1,'settle','k1')`, [companyA]);
    const dup = await expectReject(`insert into idempotency_keys (company_id, scope, key) values ($1,'settle','k1')`, [companyA]);
    expect(dup).toBe(true);
    // same key under a different company or scope is allowed (not a global lock)
    await q(`insert into idempotency_keys (company_id, scope, key) values ($1,'settle','k1')`, [companyB]);
    await q(`insert into idempotency_keys (company_id, scope, key) values ($1,'reverse','k1')`, [companyA]);
  });

  it("composite company FK: a task dependency cannot cross companies (§WP1.6)", async () => {
    const mkTask = async (co: string, title: string) =>
      (await client.query(`insert into tasks (company_id, title, status) values ($1,$2,'captured') returning id`, [co, title])).rows[0].id;
    const taskA1 = await mkTask(companyA, "A1");
    const taskA2 = await mkTask(companyA, "A2");
    const taskB1 = await mkTask(companyB, "B1");

    // Same-company dependency is fine.
    await q(`insert into task_dependencies (task_id, depends_on_task_id, company_id) values ($1,$2,$3)`, [taskA1, taskA2, companyA]);

    // Cross-company: A1 (company A) depends on B1 (company B), tagged company A →
    // the composite FK on (depends_on_task_id, company_id) has no matching parent.
    const crossed = await expectReject(
      `insert into task_dependencies (task_id, depends_on_task_id, company_id) values ($1,$2,$3)`,
      [taskA1, taskB1, companyA],
    );
    expect(crossed).toBe(true);
  });

  it("management_cases accepts a durable case row (§WP5.1 schema live)", async () => {
    const r = await q(
      `insert into management_cases (company_id, correlation_id, source_event_id, confirmed_facts, confidence, requires_human)
       values ($1,'cor_t','manual','["x"]'::jsonb, 0.5, true) returning id`,
      [companyA],
    );
    expect(r.rows[0].id).toBeTruthy();
  });
});
