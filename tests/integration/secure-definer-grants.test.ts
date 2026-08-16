/**
 * SECURITY-BOUNDARY correction — migrations 0062 (+ 0063 adds the atomic quotation-enqueue RPC). Live
 * Postgres, ZERO-PERSISTENCE.
 *
 * Every service-only / internal SECURITY DEFINER function is callable ONLY by service_role. The
 * allowlist is SIGNATURE-EXACT (keyed on the `regprocedure` identity — name + argument TYPES), so a new
 * OVERLOAD of an already-approved name cannot silently escape classification: it is a different
 * signature and fails the allowlist. Proves:
 *   - every exact SECURITY DEFINER signature in `public` is classified (service-only OR intentionally-executable);
 *   - an unknown overload of an approved name fails the allowlist;
 *   - every service-only signature has NO EXECUTE for PUBLIC/anon/authenticated and RETAINS it for service_role;
 *   - direct calls as authenticated fail with SQLSTATE 42501 (create a journal, claim/read an outbox
 *     batch, read the cross-company integrity report, complete an outbox row, atomically enqueue a quotation);
 *   - service_role can still execute them.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
const AUTH_UID = "00000000-0000-0000-0000-0000000000aa";

// Service-only / internal — locked to service_role. Keyed on the exact `regprocedure` identity
// (name + argument types). Includes the legacy 7-arg _journal_post_internal in case an upgraded DB
// still carries it (absent on a fresh DB — not required to be present, only required to be locked if so).
const SERVICE_ONLY = new Set([
  "_journal_fp_matches(uuid,text,uuid,text,uuid,date,text,text,jsonb)",
  "_journal_post_internal(uuid,date,text,text,uuid,text,jsonb,text,text,text,uuid)",
  "_journal_post_internal(uuid,date,text,text,uuid,jsonb,text)", // legacy 7-arg (upgrade only)
  "claim_outbox_batch(integer,text,integer)",
  "complete_outbox_and_advance(uuid,text,text)",
  "enqueue_outbox_row(uuid,text,text,text,text,text,text,jsonb,text,uuid,text)",
  "enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)",
  "ledger_integrity_report(uuid)",
  "reconcile_quotation_from_outbox(uuid)",
]);
// Must exist AND be locked on any DB reaching this migration (the legacy 7-arg is intentionally excluded).
const SERVICE_ONLY_REQUIRED = [...SERVICE_ONLY].filter((s) => s !== "_journal_post_internal(uuid,date,text,text,uuid,jsonb,text)");

// Intentionally executable by authenticated (documented): RLS predicate helpers that RLS policies
// evaluate in the CALLER's role, and the authenticated write-path RPCs (fail-closed internally). Each
// classified by its exact signature — NOT by name — so a new overload of any of these must be re-approved.
const AUTHENTICATED_OK = new Set([
  "authority_ceiling(uuid,text)",
  "has_capability(uuid,text)",
  "has_company_access(uuid)",
  "has_membership(uuid)",
  "has_permission(uuid,text)",
  "is_admin()",
  "my_company()",
  "my_department()",
  "within_authority(uuid,text,numeric,text)",
  "within_authority_for_event(uuid,uuid)",
  "post_manual_journal(uuid,date,text,text,uuid,jsonb,text)",
  "post_customer_invoice(uuid,uuid,text,text,uuid,date,text)",
  "post_supplier_bill(uuid,uuid,text,text,uuid,date,text)",
  "settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date,text)",
  "settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date,text)",
  "reverse_journal(uuid,uuid,uuid,date,text)",
  "reimburse_expense_claim(uuid,uuid,text,text,uuid,date,text)",
  "request_supplier_bank_change(uuid,uuid,text,text,uuid)",
  "decide_supplier_bank_change(uuid,uuid,text,uuid,text)",
  "decide_approval(uuid,uuid,text,text)",
]);

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
    await client.query("rollback to savepoint s");
    return { ok: false, code: (e as { code?: string }).code };
  }
}

describe.skipIf(!enabled)("0062/0063 SECURITY DEFINER grants — signature-exact service-only lockdown (live)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows: any[];
  beforeAll(async () => {
    const { default: pg } = await import("pg" as string);
    client = new pg.Client({ connectionString: URL, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    rows = (await client.query(
      `select p.oid::regprocedure::text as sig,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
              has_function_privilege('anon', p.oid, 'execute') as anon_x,
              has_function_privilege('service_role', p.oid, 'execute') as svc_x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
       order by 1`,
    )).rows;
  });
  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); } });

  it("ALLOWLIST (signature-exact): every SECURITY DEFINER signature is classified", async () => {
    const unclassified = rows.map((r) => r.sig).filter((s: string) => !SERVICE_ONLY.has(s) && !AUTHENTICATED_OK.has(s));
    // A NEW overload of an approved name has a different signature → it lands here and fails the test.
    expect(unclassified, `unclassified SECURITY DEFINER signature(s): ${unclassified.join(", ")}`).toEqual([]);
    // Every required service-only signature is actually present.
    const present = new Set(rows.map((r) => r.sig));
    for (const s of SERVICE_ONLY_REQUIRED) expect(present.has(s), `missing required service-only fn: ${s}`).toBe(true);
  });

  it("service-only signatures: authenticated & anon have NO EXECUTE; service_role retains it", async () => {
    const svc = rows.filter((r) => SERVICE_ONLY.has(r.sig));
    expect(svc.length).toBeGreaterThanOrEqual(SERVICE_ONLY_REQUIRED.length);
    for (const r of svc) {
      expect(r.auth_x, `${r.sig} authenticated EXECUTE`).toBe(false);
      expect(r.anon_x, `${r.sig} anon EXECUTE`).toBe(false);
      expect(r.svc_x, `${r.sig} service_role EXECUTE`).toBe(true);
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

  it("authenticated caller CANNOT atomically enqueue a quotation or enqueue/reconcile (42501)", async () => {
    const enqQ = await callAs("authenticated", `select public.enqueue_quotation_outbox(gen_random_uuid(), gen_random_uuid(), '9471', 'b', 'k', 100, 'LKR', 'whatsapp', 'quotation')`);
    const enq = await callAs("authenticated", `select public.enqueue_outbox_row(gen_random_uuid(), 'whatsapp', '9471', 'b', 'k', null, null, null, 'quotation', null, 'quotation')`);
    const rec = await callAs("authenticated", `select public.reconcile_quotation_from_outbox(gen_random_uuid())`);
    expect(enqQ.code).toBe("42501");
    expect(enq.code).toBe("42501");
    expect(rec.code).toBe("42501");
  });

  it("service_role RETAINS execution of the locked functions (no 42501)", async () => {
    const claim = await callAs("service", `select public.claim_outbox_batch(1, 'svc-worker', 30)`);
    const report = await callAs("service", `select public.ledger_integrity_report(null::uuid)`);
    expect(claim.ok, `claim_outbox_batch as service_role: ${claim.code}`).toBe(true);
    expect(report.ok, `ledger_integrity_report as service_role: ${report.code}`).toBe(true);
  });
});
