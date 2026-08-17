/**
 * WP10 — classification ↔ enforcement correspondence. Live, READ-ONLY.
 *
 * The declared class in security/rls-classification.json must match what the database
 * actually enforces (brief §WP10 mandated tests):
 *   - a `capability` table must NOT retain any generic company-member (has_company_access)
 *     write policy, and must have at least one has_capability write policy;
 *   - a `service_only` / `rpc_only` table must NOT grant authenticated insert/update/delete.
 *
 * This is a general guard over the whole matrix, not only the tables 0048 touched, so a
 * future regression (e.g. a new sensitive table left on company-member write) fails here.
 *
 * Skipped unless DATABASE_URL is set.  Run:  DATABASE_URL=… npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

function classified(): Record<string, string> {
  return JSON.parse(readFileSync("security/rls-classification.json", "utf8")).classified as Record<string, string>;
}

describe.skipIf(!enabled)("WP10 classification ↔ enforcement — live, read-only", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
  });
  afterAll(async () => { if (client) await client.end().catch(() => {}); });

  it("no table remains classified company_member (WP10 removed the class)", () => {
    const stillMember = Object.entries(classified()).filter(([, c]) => c === "company_member").map(([t]) => t);
    expect(stillMember, `still company_member: ${stillMember.join(", ")}`).toEqual([]);
  });

  it("capability tables have no generic company-member write policy, and do gate on has_capability", async () => {
    const caps = Object.entries(classified()).filter(([, c]) => c === "capability").map(([t]) => t);
    // All write policies on capability tables, with their predicates.
    const { rows } = await client.query(`
      select tablename, policyname, coalesce(qual,'') || ' ' || coalesce(with_check,'') as expr
      from pg_policies where schemaname='public' and cmd in ('INSERT','UPDATE','DELETE','ALL')`);
    const byTable = new Map<string, { policyname: string; expr: string }[]>();
    for (const r of rows as { tablename: string; policyname: string; expr: string }[]) {
      if (!byTable.has(r.tablename)) byTable.set(r.tablename, []);
      byTable.get(r.tablename)!.push({ policyname: r.policyname, expr: r.expr });
    }
    const memberLeaks: string[] = [];
    const missingCap: string[] = [];
    for (const t of caps) {
      const pols = byTable.get(t) ?? [];
      // A "generic company-member write" is a policy gated on company access ALONE. A
      // policy that also references has_capability (e.g. tasks_write_upd: USING
      // has_capability('approve') OR assignee, WITH CHECK has_company_access for
      // company-scope) is legitimately capability-gated, not a member-write hole.
      if (pols.some((p) => p.expr.includes("has_company_access") && !p.expr.includes("has_capability"))) memberLeaks.push(t);
      if (!pols.some((p) => p.expr.includes("has_capability"))) missingCap.push(t);
    }
    expect(memberLeaks, `capability tables still on generic company-member write: ${memberLeaks.join(", ")}`).toEqual([]);
    expect(missingCap, `capability tables without a has_capability write policy: ${missingCap.join(", ")}`).toEqual([]);
  });

  it("service_only / rpc_only tables do not grant authenticated insert/update/delete", async () => {
    const locked = Object.entries(classified()).filter(([, c]) => c === "service_only" || c === "rpc_only").map(([t]) => t);
    const { rows } = await client.query(`
      select table_name, privilege_type from information_schema.role_table_grants
      where grantee='authenticated' and table_schema='public' and privilege_type in ('INSERT','UPDATE','DELETE')`);
    const granted = new Set((rows as { table_name: string; privilege_type: string }[]).map((r) => r.table_name));
    const leaks = locked.filter((t) => granted.has(t));
    expect(leaks, `service_only/rpc_only tables that still grant authenticated write: ${leaks.join(", ")}`).toEqual([]);
  });
});
