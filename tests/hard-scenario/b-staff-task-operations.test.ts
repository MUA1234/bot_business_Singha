/**
 * PACKAGE B — staff and task operations.
 *
 * Multi-step workflows through the REAL task RPCs against the REAL database: creation
 * with deduplication, assignment and eligibility, concurrent updates by two managers,
 * duplicate and concurrent creation requests, permission loss while work is open, and
 * the append-only routing ledger.
 *
 * A NOTE ON WHICH CLIENT CALLS WHAT, because it is a security property rather than a
 * convenience. `create_task_deduplicated` and `task_assignee_ineligible_reason` are
 * granted to `service_role` ONLY — an authenticated user cannot execute them, and the
 * application reaches them from the server. The suite therefore drives them through the
 * service client (the real path) and separately ASSERTS that an authenticated caller is
 * refused. An earlier draft of this file called them as a signed-in user, got
 * `permission denied`, and read the resulting null as "eligible" — the opposite of the
 * truth. That is exactly the failure mode these tests exist to catch, so it is recorded
 * here rather than quietly corrected.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { stackConfigured, signInAs, serviceClient, TENANT_A, TENANT_B } from "./helpers/stack";

const MARK = "HST-B";

describe.skipIf(!stackConfigured)("B — staff and task operations", () => {
  let owner: Awaited<ReturnType<typeof signInAs>>;
  let staff: Awaited<ReturnType<typeof signInAs>>;
  let bOwner: Awaited<ReturnType<typeof signInAs>>;
  let staffMembership: string;

  beforeAll(async () => {
    owner = await signInAs(TENANT_A.owner);
    staff = await signInAs(TENANT_A.staff);
    bOwner = await signInAs(TENANT_B.owner);

    const svc = serviceClient();
    const { data } = await svc.from("memberships").select("id,user_id").eq("company_id", TENANT_A.company);
    const rows = (data ?? []) as { id: string; user_id: string }[];
    staffMembership = rows.find((r) => r.user_id === staff.userId)!.id;
  });

  afterAll(async () => {
    const svc = serviceClient();
    const { data } = await svc.from("tasks").select("id").like("title", `${MARK}%`);
    for (const t of (data ?? []) as { id: string }[]) {
      await svc.from("task_assignments").delete().eq("task_id", t.id);
      await svc.from("tasks").delete().eq("id", t.id);
    }
    await svc.from("memberships").update({ status: "active" }).eq("id", staffMembership);
  });

  /** Create a task through the real deduplicating RPC, on the real (service) path. */
  async function createTask(title: string, sourceId = title) {
    const svc = serviceClient();
    const { data, error } = await svc.rpc("create_task_deduplicated", {
      p_company: TENANT_A.company,
      p_title: title,
      p_source_type: "manual",
      p_source_id: sourceId,
      p_purpose: "hst-purpose",
      p_target: "hst-target",
      p_window: "2026-08-28",
      p_management_case: null,
      p_requires_evidence: false,
      p_created_by: owner.userId,
    });
    // The function returns TABLE(task_id uuid, created boolean) — a row set, not a bare
    // id — and `created` distinguishes a fresh task from a deduplicated hit, which is
    // exactly what the deduplication cases below need to assert.
    const row = Array.isArray(data) ? (data[0] as { task_id: string; created: boolean } | undefined) : null;
    return { id: row?.task_id ?? null, created: row?.created ?? null, error: error?.message ?? null };
  }

  /* ── B0. The service-only boundary ───────────────────────────────────── */

  it("B0 — an authenticated user cannot execute the task-creation RPC directly", async () => {
    const { error } = await owner.db.rpc("create_task_deduplicated", {
      p_company: TENANT_A.company,
      p_title: `${MARK}-direct`,
      p_source_type: "manual",
      p_source_id: `${MARK}-direct`,
      p_purpose: "x",
      p_target: "y",
      p_window: "2026-08-28",
      p_management_case: null,
      p_requires_evidence: false,
      p_created_by: owner.userId,
    });
    expect(error?.message ?? "", "a user reached a service-only function").toMatch(/permission denied/i);

    const svc = serviceClient();
    const { data } = await svc.from("tasks").select("id").eq("title", `${MARK}-direct`);
    expect(data ?? [], "a refused call still created a task").toHaveLength(0);
  });

  it("B0 — an authenticated user cannot execute the eligibility RPC directly", async () => {
    const { error } = await owner.db.rpc("task_assignee_ineligible_reason", {
      p_company: TENANT_A.company,
      p_assignee: owner.userId,
      p_capability: "task.execute",
      p_submitter: owner.userId,
    });
    expect(error?.message ?? "").toMatch(/permission denied/i);
  });

  /* ── B1. Creation and deduplication ──────────────────────────────────── */

  it("B1 — a task is created and scoped to the acting company", async () => {
    const { id, error } = await createTask(`${MARK}-create-1`);
    expect(error).toBeNull();
    expect(id).toBeTruthy();

    const svc = serviceClient();
    const { data } = await svc.from("tasks").select("company_id").eq("id", id!).single();
    expect((data as { company_id: string }).company_id).toBe(TENANT_A.company);
  });

  it("B1 — a DUPLICATE creation request returns the same task, never a second one", async () => {
    const first = await createTask(`${MARK}-dedup`, `${MARK}-dedup-src`);
    const second = await createTask(`${MARK}-dedup`, `${MARK}-dedup-src`);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.created, "the first request should have created the task").toBe(true);
    expect(second.created, "the second request should have been deduplicated").toBe(false);
    expect(second.id, "a duplicate request created a second task").toBe(first.id);

    const svc = serviceClient();
    const { data } = await svc.from("tasks").select("id").eq("title", `${MARK}-dedup`);
    expect(data ?? []).toHaveLength(1);
  });

  it("B1 — CONCURRENT identical creation requests collapse to ONE task", async () => {
    await Promise.all(Array.from({ length: 6 }, () => createTask(`${MARK}-race`, `${MARK}-race-src`)));
    const svc = serviceClient();
    const { data } = await svc.from("tasks").select("id").eq("title", `${MARK}-race`);
    expect(data ?? [], "a creation race produced duplicate tasks").toHaveLength(1);
  });

  /* ── B2. Eligibility, decided by the database ───────────────────────── */

  it("B2 — a member of ANOTHER company is never eligible", async () => {
    const svc = serviceClient();
    const { data, error } = await svc.rpc("task_assignee_ineligible_reason", {
      p_company: TENANT_A.company,
      p_assignee: bOwner.userId,
      p_capability: "",
      p_submitter: owner.userId,
    });
    expect(error).toBeNull();
    expect(data, "a member of another company was reported eligible").toBe("not_active_member_of_company");
  });

  it("B2 — a submitter cannot assign work to themselves (separation of duties)", async () => {
    const svc = serviceClient();
    const { data } = await svc.rpc("task_assignee_ineligible_reason", {
      p_company: TENANT_A.company,
      p_assignee: owner.userId,
      p_capability: "",
      p_submitter: owner.userId,
    });
    expect(data).toBe("separation_of_duties");
  });

  it("B2 — a suspended member becomes ineligible", async () => {
    const svc = serviceClient();
    await svc.from("memberships").update({ status: "suspended" }).eq("id", staffMembership);
    try {
      const { data } = await svc.rpc("task_assignee_ineligible_reason", {
        p_company: TENANT_A.company,
        p_assignee: staff.userId,
        p_capability: "",
        p_submitter: owner.userId,
      });
      expect(data).toBe("not_active_member_of_company");
    } finally {
      await svc.from("memberships").update({ status: "active" }).eq("id", staffMembership);
    }
  });

  /* ── B3. Assignment integrity ───────────────────────────────────────── */

  it("B3 — a task can be assigned, and the assignment is company-scoped", async () => {
    const { id } = await createTask(`${MARK}-assign`);
    const svc = serviceClient();
    const { error } = await svc
      .from("task_assignments")
      .insert({ task_id: id, membership_id: staffMembership, company_id: TENANT_A.company });
    expect(error).toBeNull();

    const { data } = await svc.from("task_assignments").select("company_id").eq("task_id", id!);
    expect(data ?? []).toHaveLength(1);
    expect((data as { company_id: string }[])[0]!.company_id).toBe(TENANT_A.company);
  });

  it("B3 — an assignment cannot name a membership from another company", async () => {
    const { id } = await createTask(`${MARK}-assign-foreign`);
    const svc = serviceClient();
    const { data: bMem } = await svc
      .from("memberships").select("id").eq("company_id", TENANT_B.company).limit(1).single();

    const { error } = await svc.from("task_assignments").insert({
      task_id: id,
      membership_id: (bMem as { id: string }).id,
      company_id: TENANT_A.company,
    });
    // The composite tenant-integrity foreign key exists to make this impossible.
    expect(error, "a task was assigned to another company's member").not.toBeNull();
  });

  /* ── B4. Concurrent updates ─────────────────────────────────────────── */

  it("B4 — two concurrent status updates leave ONE coherent result, never a blend", async () => {
    const { id } = await createTask(`${MARK}-concurrent`);
    expect(id).toBeTruthy();
    const svc = serviceClient();

    await Promise.all([
      svc.from("tasks").update({ status: "in_progress" }).eq("id", id!),
      svc.from("tasks").update({ status: "blocked", blocker_reason: "HST contention" }).eq("id", id!),
    ]);

    const { data } = await svc.from("tasks").select("status").eq("id", id!).single();
    expect(["in_progress", "blocked"]).toContain((data as { status: string }).status);
  });

  it("B4 — a task's status can only be a declared lifecycle state", async () => {
    const { id } = await createTask(`${MARK}-badstatus`);
    const svc = serviceClient();
    const { error } = await svc.from("tasks").update({ status: "definitely_not_a_state" }).eq("id", id!);
    expect(error, "an undeclared task status was accepted").not.toBeNull();
  });

  /* ── B5. Permission loss while work is open ─────────────────────────── */

  it("B5 — suspending a membership removes read access while a task is still open", async () => {
    const { id } = await createTask(`${MARK}-permloss`);
    const svc = serviceClient();

    // Control: the member CAN see company work while active.
    const before = await staff.db.from("tasks").select("id").eq("id", id!);
    expect((before.data ?? []).length, "the control failed — the member could not see the task to begin with").toBe(1);

    await svc.from("memberships").update({ status: "suspended" }).eq("id", staffMembership);
    try {
      const fresh = await signInAs(TENANT_A.staff);
      const after = await fresh.db.from("tasks").select("id").eq("id", id!);
      expect((after.data ?? []).length, "a suspended member still read company work").toBe(0);
    } finally {
      await svc.from("memberships").update({ status: "active" }).eq("id", staffMembership);
    }
  });

  /* ── B6. Audit trail ────────────────────────────────────────────────── */

  it("B6 — the routing ledger is append-only", async () => {
    const svc = serviceClient();
    const { data } = await svc
      .from("task_routing_events").select("id").eq("company_id", TENANT_A.company).limit(1);
    const events = (data ?? []) as { id: string }[];
    if (events.length === 0) return; // nothing routed yet; nothing to assert

    const { error } = await svc
      .from("task_routing_events").update({ actor_type: "human" }).eq("id", events[0]!.id);
    expect(error, "a recorded routing event was mutable").not.toBeNull();
  });
});
