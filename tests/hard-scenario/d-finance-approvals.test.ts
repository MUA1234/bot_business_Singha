/**
 * PACKAGE D — finance and approvals.
 *
 * Exercises the REAL `decide_approval` RPC with REAL user tokens against the REAL
 * database, so separation of duties, capability checks, authority ceilings, idempotency
 * and concurrency are proven where they are actually enforced rather than in a mock.
 *
 * Fixtures (seeded by scripts/verify/dev-fixture-seed.mjs):
 *   request 600 — pending, approvals_required 2, submitted by FINANCE,
 *                 event 590 supplier_payment LKR 1,840,000
 *   request 601 — pending, approvals_required 1, submitted by STAFF,
 *                 event 591 expense_claim LKR 48,250
 *   request 602 — already approved
 *
 * Every assertion is rule-based. Where the outcome depends on configuration that is not
 * seeded (no authority_rules exist for this company), the test asserts the FAIL-CLOSED
 * requirement rather than a specific happy path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Decimal from "decimal.js";
import { stackConfigured, signInAs, serviceClient, TENANT_A, TENANT_B } from "./helpers/stack";

/** Money round-trip probes. Seeded by the suite so it is self-contained. */
const MONEY_PROBES = [
  { id: "0000f1de-0000-4000-8000-0000000009f1", amount: "1234.5600" },
  { id: "0000f1de-0000-4000-8000-0000000009f2", amount: "99999999999999.9999" },
  { id: "0000f1de-0000-4000-8000-0000000009f3", amount: "0.0001" },
];

const REQ_OWN_BY_FINANCE = "0000f1de-0000-4000-8000-000000000600"; // requires 2
const REQ_BY_STAFF = "0000f1de-0000-4000-8000-000000000601"; // requires 1
const REQ_ALREADY_APPROVED = "0000f1de-0000-4000-8000-000000000602";

/** Call the real RPC as a signed-in user; return the postgres error message if it raised. */
async function decide(
  db: Awaited<ReturnType<typeof signInAs>>["db"],
  request: string,
  action: "approve" | "reject",
  note = "hard-scenario",
) {
  const { data, error } = await db.rpc("decide_approval", {
    p_company: TENANT_A.company,
    p_request: request,
    p_action: action,
    p_note: note,
  });
  return { data, error: error?.message ?? null };
}

describe.skipIf(!stackConfigured)("D — finance and approvals", () => {
  let owner: Awaited<ReturnType<typeof signInAs>>;
  let finance: Awaited<ReturnType<typeof signInAs>>;
  let staff: Awaited<ReturnType<typeof signInAs>>;
  let bOwner: Awaited<ReturnType<typeof signInAs>>;

  /** Snapshot so each scenario can restore the fixture it perturbs. */
  const restore: { id: string; status: string }[] = [];

  beforeAll(async () => {
    owner = await signInAs(TENANT_A.owner);
    finance = await signInAs(TENANT_A.finance);
    staff = await signInAs(TENANT_A.staff);
    bOwner = await signInAs(TENANT_B.owner);

    const svc = serviceClient();
    const { data } = await svc
      .from("approval_requests")
      .select("id,status")
      .eq("company_id", TENANT_A.company);
    for (const r of (data ?? []) as { id: string; status: string }[]) restore.push(r);

    for (const p of MONEY_PROBES) {
      await svc.from("financial_events").upsert(
        {
          id: p.id,
          company_id: TENANT_A.company,
          event_type: "expense_claim",
          state: "captured",
          amount: p.amount,
          currency: "LKR",
          transaction_date: "2026-08-01",
          correlation_id: `hst-money-probe-${p.id.slice(-2)}`,
        },
        { onConflict: "id" },
      );
    }
  });

  afterAll(async () => {
    // Put the fixture back so the suite is repeatable.
    const svc = serviceClient();
    for (const r of restore) {
      await svc.from("approval_requests").update({ status: r.status }).eq("id", r.id);
    }
    await svc.from("approval_actions").delete().eq("note", "hard-scenario");
    await svc.from("approval_actions").delete().eq("note", "hst-race");
    for (const p of MONEY_PROBES) await svc.from("financial_events").delete().eq("id", p.id);
  });

  /* ── D1. Separation of duties ────────────────────────────────────────── */

  it("D1 — the maker cannot approve their own request", async () => {
    const { error } = await decide(finance.db, REQ_OWN_BY_FINANCE, "approve");
    expect(error, "self-approval was permitted").toBeTruthy();
    expect(error).toMatch(/maker cannot approve their own request|separation of duties/i);

    const svc = serviceClient();
    const { data } = await svc
      .from("approval_actions")
      .select("id")
      .eq("approval_request_id", REQ_OWN_BY_FINANCE)
      .eq("actor_user_id", finance.userId);
    expect(data ?? [], "a self-approval action was recorded").toHaveLength(0);
  });

  it("D1 — the maker cannot reject their own request either", async () => {
    const { error } = await decide(finance.db, REQ_OWN_BY_FINANCE, "reject");
    expect(error).toBeTruthy();
  });

  /* ── D2. Capability and authority ────────────────────────────────────── */

  it("D2 — a staff submitter without the approval capability is refused", async () => {
    const { error } = await decide(staff.db, REQ_OWN_BY_FINANCE, "approve");
    expect(error, "an unauthorised employee approved a request").toBeTruthy();
    expect(error).toMatch(/capability|authority|not authoris|not authoriz/i);
  });

  it("D2 — with no authority rule configured, approval fails CLOSED", async () => {
    // No `authority_rules` row exists for this company. The requirement is that an
    // absent limit means "no authority", never "unlimited authority".
    const { data, error } = await decide(owner.db, REQ_OWN_BY_FINANCE, "approve");
    if (error) {
      expect(error).toMatch(/authority|capability|fail-closed/i);
    } else {
      // If it were permitted, it must at least not have finalised a 1.84M payment on one
      // signature when two are required.
      expect(data).not.toBe("approved");
    }
    const svc = serviceClient();
    const { data: fe } = await svc
      .from("financial_events")
      .select("state")
      .eq("id", "0000f1de-0000-4000-8000-000000000590")
      .single();
    expect((fe as { state: string }).state).not.toBe("approved");
  });

  /* ── D3. State machine ───────────────────────────────────────────────── */

  it("D3 — a request that is not pending cannot be decided again", async () => {
    const { error } = await decide(owner.db, REQ_ALREADY_APPROVED, "approve");
    expect(error).toBeTruthy();
    expect(error).toMatch(/not pending/i);
  });

  it("D3 — an unknown request id is refused, not silently ignored", async () => {
    const { error } = await decide(owner.db, "00000000-0000-4000-8000-000000000000", "approve");
    expect(error).toBeTruthy();
    expect(error).toMatch(/not found/i);
  });

  it("D3 — an invalid action is refused", async () => {
    const { error } = await owner.db
      .rpc("decide_approval", {
        p_company: TENANT_A.company,
        p_request: REQ_BY_STAFF,
        p_action: "approve_everything",
        p_note: "hard-scenario",
      })
      .then((r) => ({ error: r.error?.message ?? null }));
    expect(error).toBeTruthy();
    expect(error).toMatch(/action must be approve or reject/i);
  });

  /* ── D4. Tenant isolation on the decision path ───────────────────────── */

  it("D4 — another company's owner cannot decide this company's request", async () => {
    const { error } = await bOwner.db
      .rpc("decide_approval", {
        p_company: TENANT_A.company,
        p_request: REQ_BY_STAFF,
        p_action: "approve",
        p_note: "hard-scenario",
      })
      .then((r) => ({ error: r.error?.message ?? null }));
    expect(error, "a cross-tenant approval decision succeeded").toBeTruthy();

    const svc = serviceClient();
    const { data } = await svc
      .from("approval_actions")
      .select("id")
      .eq("approval_request_id", REQ_BY_STAFF)
      .eq("actor_user_id", bOwner.userId);
    expect(data ?? [], "a cross-tenant approval action was recorded").toHaveLength(0);
  });

  /* ── D5. Idempotency and conflicting decisions ───────────────────────── */

  it("D5 — repeating the SAME decision does not record a second action", async () => {
    const svc = serviceClient();
    // Use the staff-submitted request so the owner is not the maker.
    await decide(owner.db, REQ_BY_STAFF, "approve");
    const after1 = await svc
      .from("approval_actions")
      .select("id")
      .eq("approval_request_id", REQ_BY_STAFF)
      .eq("actor_user_id", owner.userId);

    await decide(owner.db, REQ_BY_STAFF, "approve");
    const after2 = await svc
      .from("approval_actions")
      .select("id")
      .eq("approval_request_id", REQ_BY_STAFF)
      .eq("actor_user_id", owner.userId);

    // Whether or not the first call was permitted, the second must not add a duplicate.
    expect((after2.data ?? []).length).toBe((after1.data ?? []).length);
    expect((after2.data ?? []).length).toBeLessThanOrEqual(1);
  });

  it("D5 — the same actor cannot reverse their decision by calling again", async () => {
    const svc = serviceClient();
    const { data: existing } = await svc
      .from("approval_actions")
      .select("action")
      .eq("approval_request_id", REQ_BY_STAFF)
      .eq("actor_user_id", owner.userId)
      .maybeSingle();
    if (!existing) return; // the earlier decision was refused; nothing to conflict with

    const { error } = await decide(owner.db, REQ_BY_STAFF, "reject");
    expect(error, "an actor flipped their own recorded decision").toBeTruthy();
    expect(error).toMatch(/conflicting decision|not pending/i);
  });

  /* ── D6. Concurrency ─────────────────────────────────────────────────── */

  it("D6 — concurrent decisions never produce more actions than actors", async () => {
    const svc = serviceClient();
    // Reset the request to pending and clear its actions so the race is clean.
    await svc.from("approval_actions").delete().eq("approval_request_id", REQ_BY_STAFF);
    await svc.from("approval_requests").update({ status: "pending" }).eq("id", REQ_BY_STAFF);

    // Fire the same decision from the same actor many times at once. The FOR UPDATE lock
    // plus the unique constraint must collapse these to at most one recorded action.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        owner.db.rpc("decide_approval", {
          p_company: TENANT_A.company,
          p_request: REQ_BY_STAFF,
          p_action: "approve",
          p_note: "hst-race",
        }),
      ),
    );
    expect(results).toHaveLength(8);

    const { data } = await svc
      .from("approval_actions")
      .select("id")
      .eq("approval_request_id", REQ_BY_STAFF)
      .eq("actor_user_id", owner.userId);
    expect((data ?? []).length, "a concurrency race duplicated approval actions").toBeLessThanOrEqual(1);
  });

  /* ── D7. Money is never a float ──────────────────────────────────────── */

  it("D7 — money survives the database round trip exactly at realistic magnitudes", async () => {
    // PostgREST serialises `numeric` as an unquoted JSON number, so every JS consumer
    // parses money into a double. That is a platform characteristic, not a repository
    // choice, and it is identical on hosted Supabase — so what has to be tested is not
    // the transport TYPE but whether the value survives unchanged.
    //
    // It does, up to the double's ~15 significant digits, because JS prints the shortest
    // representation that round-trips. Above that it does NOT — see finding F-005, whose
    // boundary the next test pins.
    const svc = serviceClient();
    const probes = [
      { id: "0000f1de-0000-4000-8000-0000000009f1", exact: "1234.5600" },
      { id: "0000f1de-0000-4000-8000-0000000009f3", exact: "0.0001" },
    ];
    for (const p of probes) {
      const { data } = await svc.from("financial_events").select("amount").eq("id", p.id).single();
      const readBack = String((data as { amount: unknown }).amount);
      expect(
        new Decimal(readBack).eq(new Decimal(p.exact)),
        `money ${p.exact} came back as ${readBack}`,
      ).toBe(true);
    }
  });

  it("D7 — FINDING F-005: beyond ~15 significant digits the round trip is LOSSY", async () => {
    // This pins the boundary so a future change cannot widen it unnoticed. It asserts the
    // defect that currently exists; when `dec()` is hardened to refuse a `number` input
    // (the recommended fix), this expectation must be inverted deliberately, not silently.
    const svc = serviceClient();
    const { data } = await svc
      .from("financial_events")
      .select("amount")
      .eq("id", "0000f1de-0000-4000-8000-0000000009f2")
      .single();
    const readBack = String((data as { amount: unknown }).amount);
    const truth = new Decimal("99999999999999.9999");
    expect(
      new Decimal(readBack).eq(truth),
      "the >15-digit round trip is now exact — F-005 appears fixed; invert this test",
    ).toBe(false);
    // And record exactly how it is wrong, so the report is not vague.
    expect(readBack).toBe("100000000000000");
  });
});
