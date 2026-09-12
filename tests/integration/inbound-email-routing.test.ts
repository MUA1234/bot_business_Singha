/**
 * Migration 0071 — `companies.inbound_email_address`, the EMAIL routing key.
 *
 * `/api/webhooks/email` decides which company an inbound mail belongs to purely from the
 * address it was delivered TO. That makes this column a company-isolation boundary, not a
 * convenience field: if two companies could claim one address, or if `Sales@` and `sales@`
 * could belong to different companies, the webhook would attribute a customer's mail to the
 * wrong company — the cross-company leakage CLAUDE.md calls a CRITICAL security failure.
 *
 * The application lower-cases the recipient before lookup (`parseRecipient`), but the
 * database must not depend on the application getting that right, so both rules are enforced
 * here as constraints. These tests prove the constraints, not the intent.
 *
 * ZERO-PERSISTENCE: one transaction, rolled back in afterAll. Savepoints per statement so an
 * expected constraint violation does not poison the outer transaction.
 *
 * Skipped unless `DATABASE_URL` is set. Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

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

/** Create a company, optionally claiming an inbound address. */
async function company(name: string, address: string | null) {
  const { rows } = await q(
    `insert into companies (name, base_currency, inbound_email_address) values ($1,'LKR',$2) returning id`,
    [name, address],
  );
  return rows[0].id as string;
}

describe.skipIf(!enabled)("0071 inbound email routing key", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({
      connectionString: URL,
      ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false },
    });
    await client.connect();
    await client.query("begin");
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {}); // persist NOTHING
      await client.end().catch(() => {});
    }
  });

  it("one address belongs to exactly ONE company", async () => {
    await company("m0071_a", "orders@0071.test");
    // The whole point of the column: a second claimant would make routing ambiguous, and the
    // webhook's `maybeSingle()` lookup would start failing or, worse, pick one.
    await expect(company("m0071_b", "orders@0071.test")).rejects.toThrow(/unique|duplicate/i);
  });

  it("refuses a non-lower-cased address instead of silently creating a second namespace", async () => {
    // Routing lower-cases before lookup, so a stored `Sales@…` would simply never match —
    // mail would fail closed for ever with no obvious cause. Refuse it at write time.
    await expect(company("m0071_upper", "Sales@0071.test")).rejects.toThrow(/inbound_email_address_lower/);
    await expect(company("m0071_mixed", "sales@0071.TEST")).rejects.toThrow(/inbound_email_address_lower/);
  });

  it("leaves the many unconfigured companies alone — NULLs do not collide", async () => {
    // The index is partial for this reason: email ingestion is opt-in per company.
    await company("m0071_null_1", null);
    await company("m0071_null_2", null);
    const { rows } = await q(
      `select count(*)::int as n from companies where name like 'm0071_null_%' and inbound_email_address is null`,
    );
    expect(rows[0].n).toBe(2);
  });

  it("an address freed by one company can be claimed by another", async () => {
    // Otherwise re-pointing an address after a reorganisation would need manual surgery.
    const a = await company("m0071_move_a", "moving@0071.test");
    await q(`update companies set inbound_email_address = null where id = $1`, [a]);
    const b = await company("m0071_move_b", "moving@0071.test");
    const { rows } = await q(`select inbound_email_address from companies where id = $1`, [b]);
    expect(rows[0].inbound_email_address).toBe("moving@0071.test");
  });
});
