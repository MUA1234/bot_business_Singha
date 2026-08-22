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
  // 0069 durable inbound processing — leases, bounded retry, dead-letter, company-scoped backlog.
  // Each gates on caller_jwt_role() = 'service_role' internally AND is granted to service_role only;
  // migration 0069 carries its own fail-closed assertion that anon/authenticated cannot execute them.
  "claim_source_events(integer,text,integer)",
  "complete_source_event(uuid,text)",
  "fail_source_event(uuid,text,text,text,integer)",
  "source_event_backlog(uuid)",
  "complete_outbox_and_advance(uuid,text,text)",
  "create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text)", // 0068 atomic AI-case boundary
  "enqueue_outbox_row(uuid,text,text,text,text,text,text,jsonb,text,uuid,text)",
  "enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)",
  "ledger_integrity_report(uuid)",
  "reconcile_quotation_from_outbox(uuid)",
  // 0070 trusted channel identity resolution — service-only, in-function caller_jwt_role gate,
  // company-scoped, fails closed on unknown/ambiguous. Migration 0070 asserts anon/authenticated
  // cannot execute it.
  "resolve_channel_identity(uuid,text,text)",
  // 0071 AIM-002 task identity + deduplication. Service-only with an in-function caller_jwt_role
  // gate; the identity hash is recomputed by a trigger so a caller can never forge it.
  "create_task_deduplicated(uuid,text,text,text,text,text,text,uuid,boolean,uuid)",
  // 0071 trigger function. SECURITY DEFINER because it computes the identity hash with
  // extensions.digest, which `authenticated` cannot reach; it reads and writes no table. Fired by
  // the trigger, never called directly.
  "tasks_set_identity_hash()",
  // 0072 AIM-003 durable routing. route_task is the atomic transition boundary (service-only,
  // in-function role gate); task_assignee_ineligible_reason revalidates a proposed assignee at
  // commit time; the append-only trigger refuses any rewrite of routing history.
  // 0078 — provenance is derived, not asserted. route_task (which took actor_source and actor as
  // ARGUMENTS) is dropped; the shared implementation is reachable from no role at all, and the two
  // machine wrappers fix their own source. route_task_as_human is deliberately NOT here: it is
  // granted to `authenticated` and NOT to service_role, and is classified below.
  // (_route_task_internal is OWNER_ONLY below — reachable by no role at all, including
  //  service_role. _is_task_routing_owner is NOT security definer: it reads pg_catalog only.)
  "route_task_as_ai(uuid,uuid,text,text,text,text,text,text,jsonb,uuid,text,uuid,uuid)",
  "route_task_as_system(uuid,uuid,text,text,text,text,text,jsonb,uuid,text,uuid,uuid)",
  "task_assignee_ineligible_reason(uuid,uuid,text,uuid)",
  // 0074 FOUND-003 — the RECEIVING company is resolved from trusted channel configuration rather
  // than a hardcoded constant. Service-only: the mapping decides which company owns a message.
  "resolve_channel_company(text,text)",
  // 0083 — the durable consumer settles a receipt it finished, so the scheduled sweeper does not
  // re-process it. Service-only: it decides that a receipt is done.
  "settle_processed_source_event(uuid)",
  // 0083 — the reviewer LIST, using the same capability predicate inbound_setup_status counts by.
  "inbound_reviewer_user_ids(uuid)",
  // 0084 (FOUND-006) — the SERVICE half of the quotation-status split. There is no branch inside
  // it: the EXECUTE grant IS the authorization, which is the whole point of the change.
  "quotation_status_for_service(uuid,uuid)",
  // 0075 FOUND-003 — the manual-review queue. record is idempotent per message; resolve
  // INDEPENDENTLY re-checks the named actor's capability rather than trusting the application.
  "record_inbound_review(uuid,text,text,text,text,uuid,text,text,text,text)",
  // 0076 — the canonical inbound receipt and its dispatch lifecycle. Service-only: these decide
  // which company owns a message and whether it becomes consumer work.
  // (canonical_event_identity, channel_accounts_normalize and task_routing_events_no_truncate are
  //  NOT SECURITY DEFINER — a plain immutable function and two trigger functions — so they are
  //  deliberately absent from a list that governs SECURITY DEFINER signatures.)
  "record_inbound_receipt(text,text,text,jsonb,text,text,text)",
  "claim_inbound_dispatch(uuid,text,integer)",
  "claim_inbound_dispatch_batch(integer,text,integer)",
  "record_inbound_dispatch(uuid,text,text,uuid,text,uuid)",
  "fail_inbound_dispatch(uuid,text,text,text,integer)",
  "inbound_dispatch_health()",
  // 0077 — hand a claimed row back, unharmed, when nothing can process it yet.
  "release_source_event(uuid,text)",
  // 0079 — the dispatch-lifecycle twin: a drain that runs out of time hands work back UNCHARGED
  // rather than failing it, so a slow run cannot dead-letter healthy receipts.
  "release_inbound_dispatch(uuid,text)",
  // 0080 — the owner configuration surface. Each re-checks the ACTING PERSON's capability inside
  // the transaction and audits the change in it; none of them grants anything by itself.
  "admin_upsert_channel_account(uuid,text,text,text,uuid)",
  "admin_set_channel_account_active(uuid,uuid,boolean,uuid)",
  "admin_set_membership_role(uuid,uuid,text,boolean,uuid)",
  "inbound_setup_status(uuid)",
  "resolve_inbound_review(uuid,uuid,uuid,text,text)",
  // 0075 — the single capability implementation, for an EXPLICIT actor. Service-only because it
  // takes an arbitrary user id; has_capability (same owner) wraps it for RLS in the caller's role.
  "actor_has_capability(uuid,uuid,text)",
  // (task_routing_events_append_only is a plain trigger function, not SECURITY DEFINER — it only
  //  raises. This allowlist governs SECURITY DEFINER signatures, so it is deliberately absent.)
]);
/**
 * INTERNAL: reachable by NO API role, not even the service context.
 *
 * `_route_task_internal` is the shared routing implementation. Provenance is decided by WHICH
 * WRAPPER calls it, so letting any role call it directly would hand back the exact forgery
 * migration 0078 removes. It runs only because the three SECURITY DEFINER wrappers execute as its
 * owner.
 */
const OWNER_ONLY = new Set([
  "_route_task_internal(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid,text,text,text)",
  // 0081 (OF-013) — the approval-submitter provenance guard. A TRIGGER function: it runs as part of
  // the statement that fires it, never as a callable entrypoint, so EXECUTE is revoked from every
  // role including service_role. SECURITY DEFINER so its `search_path` is pinned and its refusal
  // cannot be bypassed by a caller's own search_path.
  "approval_requests_provenance_guard()",
  // 0084 (FOUND-006) — the shared quotation-status implementation. It carries NO authorization of
  // its own, so it is reachable by no role at all: only its two wrappers, and the WP12 delivery
  // functions, run as the owner that can execute it.
  "_quotation_status_read(uuid,uuid)",
  // 0082 (R-07) — counts the ACTIVE holders of a role in a company, so the admin surface can refuse
  // to remove the last one. SECURITY DEFINER because it reads memberships across the RLS boundary;
  // reachable by no role at all, and called only from inside admin_set_membership_role.
  "_role_holder_count(uuid,text)",
]);

// Must exist AND be locked on any DB reaching this migration (the legacy 7-arg is intentionally excluded).
const SERVICE_ONLY_REQUIRED = [...SERVICE_ONLY].filter((s) => s !== "_journal_post_internal(uuid,date,text,text,uuid,jsonb,text)");

// Intentionally executable by authenticated (documented): RLS predicate helpers that RLS policies
// evaluate in the CALLER's role, and the authenticated write-path RPCs (fail-closed internally). Each
// classified by its exact signature — NOT by name — so a new overload of any of these must be re-approved.
const AUTHENTICATED_OK = new Set([
  // 0084 (FOUND-006) — the HUMAN half of the quotation-status split. Granted to `authenticated`
  // only, and it authorizes on the CAPABILITY rather than on anything the caller can assert.
  "quotation_status_for_capable(uuid,uuid)",
  // 0087 (OF-016) — the duplicate-review workflow. Both are HUMAN-ONLY on purpose: a suspected
  // duplicate is released or confirmed by a named person, never by a worker, so `service_role` is
  // excluded from the EXECUTE grant rather than merely unused. Each derives the acting human from
  // `auth.uid()` and re-checks `finance.duplicate.resolve` against live membership — the queue
  // read inside its own predicate, the resolver under the row locks.
  "resolve_duplicate_review(uuid,text,text)",
  "duplicate_review_queue(uuid)",
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
  // 0078 — the HUMAN routing path. Executable by `authenticated` BY DESIGN and explicitly NOT by
  // service_role: that grant is what makes "a service caller cannot make a human decision" a
  // property of the boundary rather than of a check someone could forget. Identity comes from
  // auth.uid(); there is no actor parameter.
  "route_task_as_human(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid)",
  // 0092 MOD-003 — model budget policy configuration. Authenticated-only: a human with
  // ai.model_budget.manage sets the daily per-task ceiling; the function re-checks the
  // acting person's capability inside the transaction and audits the change.
  "set_ai_model_budget_policy(uuid,text,numeric,boolean,integer)",
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
    const unclassified = rows.map((r) => r.sig)
      .filter((s: string) => !SERVICE_ONLY.has(s) && !AUTHENTICATED_OK.has(s) && !OWNER_ONLY.has(s));
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

  it("OWNER-ONLY signatures are reachable by NO api role — not even service_role", async () => {
    const internal = rows.filter((r) => OWNER_ONLY.has(r.sig));
    expect(internal.length, "the internal routing implementation is missing").toBe(OWNER_ONLY.size);
    for (const r of internal) {
      expect(r.auth_x, `${r.sig} authenticated EXECUTE`).toBe(false);
      expect(r.anon_x, `${r.sig} anon EXECUTE`).toBe(false);
      expect(r.svc_x, `${r.sig} service_role EXECUTE — the forgery would be reachable again`).toBe(false);
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
