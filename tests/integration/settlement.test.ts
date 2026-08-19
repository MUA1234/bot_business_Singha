/**
 * WP2 settlement + reversal controls — live against real Postgres, ZERO-PERSISTENCE
 * (transaction + savepoints + ROLLBACK). Exercises `settle_customer_invoice` and
 * `reverse_journal` (migration 0016) and proves the DB enforces:
 *   - settle within outstanding advances amount_settled/status
 *   - overpayment and non-positive amounts are rejected (§WP2 "overpayment / negative")
 *   - a fully-settled invoice rejects further settlement (no over-settle)
 *   - only a posted journal can be reversed; the mirror posts and the original flips
 *
 * Skipped unless `DATABASE_URL` is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { authClaims, seedCapableActor, TEST_ACTOR } from "./helpers/capable-actor";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let company: string, poster: string, customer: string;
let invSeq = 0;

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
async function mkInvoice(total: number): Promise<string> {
  invSeq += 1;
  return (
    await client.query(
      `insert into customer_invoices (company_id, customer_id, invoice_number, currency, issue_date, total_amount, amount_settled, status)
       values ($1,$2,$3,'LKR','2026-07-01',$4,0,'issued') returning id`,
      [company, customer, `INV-T${invSeq}`, total],
    )
  ).rows[0].id;
}
async function settle(invoice: string, amount: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await q(`select public.settle_customer_invoice($1,$2,$3,'1000','1100',$4,'2026-07-15')`, [company, invoice, amount, poster]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
const L = (code: string, debit: number, credit: number) => ({ account_code: code, debit: String(debit), credit: String(credit), description: "x" });

describe.skipIf(!enabled)("settlement + reversal — live, zero-persistence", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    // Posting/settlement RPCs run on the service path; present a service_role JWT (WP17/0049).
    await client.query(`select set_config('request.jwt.claims', '${authClaims()}', true)`);
    company = (await client.query(`insert into companies (name, base_currency) values ('wp_set','LKR') returning id`)).rows[0].id;
    await seedCapableActor(client, company);
    poster = TEST_ACTOR;   // FOUND-006/0086: the acting human is the JWT subject
    customer = (await client.query(`insert into customers (company_id, name) values ($1,'Cust') returning id`, [company])).rows[0].id;
    await client.query(`insert into chart_of_accounts (company_id, code, name, type) values ($1,'1000','Cash','asset'),($1,'1100','AR','asset'),($1,'4000','Sales','income')`, [company]);
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("settles within outstanding and advances amount_settled + status", async () => {
    const inv = await mkInvoice(100);
    expect((await settle(inv, 40)).ok).toBe(true);
    const row = await q(`select amount_settled, status from customer_invoices where id=$1`, [inv]);
    expect(Number(row.rows[0].amount_settled)).toBe(40);
    expect(row.rows[0].status).toBe("part_paid");
  });

  it("marks paid on full settlement", async () => {
    const inv = await mkInvoice(100);
    expect((await settle(inv, 100)).ok).toBe(true);
    const row = await q(`select status from customer_invoices where id=$1`, [inv]);
    expect(row.rows[0].status).toBe("paid");
  });

  it("rejects overpayment", async () => {
    const inv = await mkInvoice(100);
    const res = await settle(inv, 150);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeds outstanding/i);
  });

  it("rejects a non-positive amount", async () => {
    const inv = await mkInvoice(100);
    expect((await settle(inv, 0)).ok).toBe(false);
    expect((await settle(inv, -5)).ok).toBe(false);
  });

  it("rejects further settlement once fully paid (no over-settle)", async () => {
    const inv = await mkInvoice(100);
    expect((await settle(inv, 100)).ok).toBe(true);
    const res = await settle(inv, 1);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeds outstanding/i);
  });

  it("reverses a posted journal and flips the original; a non-posted journal cannot be reversed", async () => {
    const j = (await q(`select public.post_manual_journal($1,'2026-07-15','LKR','j',$2,$3::jsonb) as id`, [company, poster, JSON.stringify([L("1000", 100, 0), L("4000", 0, 100)])])).rows[0].id;
    const rev = (await q(`select public.reverse_journal($1,$2,$3,'2026-07-16') as id`, [company, j, poster])).rows[0].id;
    expect(rev).toBeTruthy();
    const orig = await q(`select status from journal_entries where id=$1`, [j]);
    expect(orig.rows[0].status).toBe("reversed");
    // reversing again with the SAME key is idempotent — returns the same reversal, never a 2nd
    const rev2 = (await q(`select public.reverse_journal($1,$2,$3,'2026-07-16') as id`, [company, j, poster])).rows[0].id;
    expect(rev2).toBe(rev);
    const n = await q(`select count(*)::int c from journal_entries where company_id=$1 and reversal_of_journal_id=$2`, [company, j]);
    expect(n.rows[0].c).toBe(1); // exactly one reversal journal
    // reversing with a DIFFERENT key is rejected (already reversed)
    let threw = false;
    try {
      await q(`select public.reverse_journal($1,$2,$3,'2026-07-16','other-key')`, [company, j, poster]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
