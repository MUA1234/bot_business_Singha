/**
 * WP8 — RLS write-policy matrix coverage. Live, READ-ONLY. FAILS if any public table with a
 * company_id column is NOT classified in security/rls-classification.json, so a new
 * company-scoped table cannot ship on generic company-member write by omission.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

describe.skipIf(!enabled)("RLS write-policy matrix coverage — live, read-only", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
  });
  afterAll(async () => { if (client) await client.end().catch(() => {}); });

  it("every company-scoped table is classified in the control matrix", async () => {
    const classified = JSON.parse(readFileSync("security/rls-classification.json", "utf8")).classified as Record<string, string>;
    const { rows } = await client.query(`
      select distinct table_name from information_schema.columns
      where table_schema='public' and column_name='company_id'
        and table_name in (select relname from pg_class where relkind='r' and relnamespace='public'::regnamespace)`);
    const tables = rows.map((r: { table_name: string }) => r.table_name);
    const unclassified = tables.filter((t: string) => !(t in classified));
    expect(unclassified, `unclassified company-scoped tables (add to security/rls-classification.json): ${unclassified.join(", ")}`).toEqual([]);
    // Sanity: a healthy number of tables are classified.
    expect(tables.length).toBeGreaterThan(80);
  });

  it("sensitive classes are not left on generic company-member write", async () => {
    const classified = JSON.parse(readFileSync("security/rls-classification.json", "utf8")).classified as Record<string, string>;
    // A curated set of clearly-sensitive tables must NOT be classified 'company_member'.
    const mustBeTightened = [
      "payments", "journal_entries", "customer_invoices", "supplier_bills", "bank_transactions",
      "cash_accounts", "cash_counts", "inventory_items", "stock_movements", "contracts", "legal_matters",
      "employees", "supplier_bank_detail_changes", "approval_actions", "reimbursements", "drivers",
    ];
    for (const t of mustBeTightened) {
      expect(classified[t], `${t} must be tightened, not company_member`).toBeDefined();
      expect(classified[t]).not.toBe("company_member");
    }
  });
});
