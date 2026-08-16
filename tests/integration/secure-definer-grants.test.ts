/**
 * FINAL external-review SECURITY-BOUNDARY correction — migration 0062. Live Postgres, ZERO-PERSISTENCE.
 *
 * Proves that every service-only / internal SECURITY DEFINER function is callable ONLY by service_role:
 *   - authenticated and anon have NO EXECUTE privilege; service_role retains it;
 *   - a direct call as authenticated fails with SQLSTATE 42501 (insufficient_privilege) — an
 *     authenticated caller cannot create a journal, claim/read an outbox batch, inspect the
 *     cross-company ledger-integrity report, or complete an outbox row;
 *   - service_role can still execute them.
 *
 * An ALLOWLIST test covers ALL SECURITY DEFINER functions: each must be classified as either
 * service-only (locked) or intentionally-executable (RLS predicate or authenticated write-path RPC),
 * so a newly-added internal function cannot silently ship unlocked.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
const AUTH_UID = "00000000-0000-0000-0000-0000000000aa";

// Service-only / internal — locked to service_role by 0062.
const SERVICE_ONLY = [
  "_journal_post_internal", "_journal_fp_matches", "claim_outbox_batch",
  "complete_outbox_and_advance", "ledger_integrity_report", "enqueue_outbox_row",
  "reconcile_quotation_from_outbox",
].sort();

// Intentionally executable by authenticated (documented): RLS predicate helpers that RLS policies
// evaluate in the caller's role, and the authenticated write-path RPCs (fail-closed internally).
const AUTHENTICATED_OK = [
  "authority_ceiling", "has_capability", "has_company_access", "has_membership", "has_permission",
  "is_admin", "my_company", "my_department", "within_authority", "within_authority_for_event",
  "post_manual_journal", "post_customer_invoice", "post_supplier_bill", "settle_customer_invoice",
  "settle_supplier_bill", "reverse_journal", "reimburse_expense_claim", "request_supplier_bank_change",
  "decide_supplier_bank_change", "decide_approval",
];

async function callAs(role: "authenticated" | "service", sql: string): Promise<{ ok: boolean; code?: string }> {
  await client.query("savepoint s");
  try {
    if (role === "authenticated") {
      await client.query("set local role authenticated");
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: AUTH_UID, role: "authenticated" })]);
    } else {
      await client.query("set local role service_role");
      await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    }
    await client.query(sql);
    await client.query("release savepoint s");
    return { ok: true };
  } catch (e) {
    await client.query("rollback to savepoint s"); // un-abort the outer transaction
    return { ok: false, code: (e as { code?: string }).code };
  }
}

describe.skipIf(!enabled)("0062 SECURITY DEFINER grants — service-only lockdown (live, zero-persistence)", () => {
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("ALLOWLIST: every SECURITY DEFINER function in public is classified (service-only OR intentionally-executable)", async () => {
    const rows = (await client.query(
      `select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef order by 1`,
    )).rows.map((r: { proname: string }) => r.proname);
    const known = new Set([...SERVICE_ONLY, ...AUTHENTICATED_OK]);
    const unclassified = rows.filter((n: string) => !known.has(n));
    // If this fails, a new SECURITY DEFINER function shipped without being classified/locked in 0062.
    expect(unclassified, `unclassified SECURITY DEFINER function(s): ${unclassified.join(", ")}`).toEqual([]);
    // And every name we expect to be service-only is actually present as a SECURITY DEFINER function.
    for (const n of SERVICE_ONLY) expect(rows, n).toContain(n);
  });

  it("service-only functions: authenticated & anon have NO EXECUTE; service_role retains it", async () => {
    const rows = (await client.query(
      `select p.proname,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
              has_function_privilege('anon', p.oid, 'execute') as anon_x,
              has_function_privilege('service_role', p.oid, 'execute') as svc_x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef and p.proname = any($1)`,
      [SERVICE_ONLY],
    )).rows;
    expect(rows.length).toBeGreaterThanOrEqual(SERVICE_ONLY.length); // every signature of each name
    for (const r of rows) {
      expect(r.auth_x, `${r.proname} authenticated EXECUTE`).toBe(false);
      expect(r.anon_x, `${r.proname} anon EXECUTE`).toBe(false);
      expect(r.svc_x, `${r.proname} service_role EXECUTE`).toBe(true);
    }
  });

  it("authenticated caller CANNOT create a journal via _journal_post_internal (42501)", async () => {
    const r = await callAs("authenticated",
      `select public._journal_post_internal(null::uuid, current_date, 'LKR', 'm', null::uuid, 'system', '[]'::jsonb, 'k', 'manual', 'x', null::uuid)`);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
  });

  it("authenticated caller CANNOT claim/read an outbox batch (42501)", async () => {
    const r = await callAs("authenticated", `select public.claim_outbox_batch(1, 'attacker', 30)`);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
  });

  it("authenticated caller CANNOT inspect the cross-company ledger-integrity report (42501)", async () => {
    const r = await callAs("authenticated", `select public.ledger_integrity_report(null::uuid)`);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
  });

  it("authenticated caller CANNOT complete an outbox row (42501)", async () => {
    const r = await callAs("authenticated", `select public.complete_outbox_and_advance(gen_random_uuid(), 'attacker', 'wamid.X')`);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("42501");
  });

  it("authenticated caller CANNOT enqueue an outbox row or reconcile a quotation (42501)", async () => {
    const enq = await callAs("authenticated", `select public.enqueue_outbox_row(gen_random_uuid(), 'whatsapp', '9471', 'b', 'k', null, null, null, 'quotation', null, 'quotation')`);
    const rec = await callAs("authenticated", `select public.reconcile_quotation_from_outbox(gen_random_uuid())`);
    expect(enq.code).toBe("42501");
    expect(rec.code).toBe("42501");
  });

  it("service_role RETAINS execution of the locked functions (no 42501)", async () => {
    // Safe to run against an empty savepoint: claim finds no rows; the integrity report returns rows.
    const claim = await callAs("service", `select public.claim_outbox_batch(1, 'svc-worker', 30)`);
    const report = await callAs("service", `select public.ledger_integrity_report(null::uuid)`);
    expect(claim.ok, `claim_outbox_batch as service_role: ${claim.code}`).toBe(true);
    expect(report.ok, `ledger_integrity_report as service_role: ${report.code}`).toBe(true);
  });
});
