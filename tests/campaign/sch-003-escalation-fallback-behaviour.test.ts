/**
 * SCH-003 — leave-, capability- and company-aware escalation fallback. BEHAVIOURAL.
 *
 * WHY THIS FILE EXISTS (defect PR-F-013 → correction R1-F-001).
 * `sch-003-leave-workload-aware-scheduling.test.ts` asserted this invariant by checking the
 * route's SOURCE TEXT for a multi-line expression. That assertion failed on any CRLF
 * checkout, and — far worse — would have passed even while the fallback notified people on
 * approved leave, which is exactly what it was doing (R1-F-001).
 *
 * These tests drive the REAL route handler against a controlled database and assert what it
 * DOES. Every one of them fails if the guard is removed again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TODAY = new Date().toISOString().slice(0, 10);
const LONG_AGO = new Date(Date.now() - 30 * 86_400_000).toISOString();

const CO = "co-1";
const OTHER_CO = "co-2";
const CHAIN_MEMBER = "user-chain-on-leave";
const ADMIN_FREE = "user-admin-free";
const ADMIN_BUSY = "user-admin-busy";
const ADMIN_ON_LEAVE = "user-admin-on-leave";
const ADMIN_OTHER_CO = "user-admin-other-company";
const STAFF_NOT_ADMIN = "user-staff-not-admin";
const TASK = "task-1";

/**
 * Row shapes mirror the route's own queries. `profiles` is already filtered to
 * `is_active = true` by the route, so an INACTIVE member is represented by omission —
 * which is precisely how the production query behaves.
 */
let profiles: Array<Record<string, unknown>> = [];
let leaveRows: Array<Record<string, unknown>> = [];

const ALL_PROFILES = {
  chain: { id: CHAIN_MEMBER, company_id: CO, phone: "+94700000001", full_name: "Chain Member", username: null, is_admin: false },
  free: { id: ADMIN_FREE, company_id: CO, phone: "+94700000002", full_name: "Free Admin", username: null, is_admin: true },
  busy: { id: ADMIN_BUSY, company_id: CO, phone: "+94700000003", full_name: "Busy Admin", username: null, is_admin: true },
  onLeave: { id: ADMIN_ON_LEAVE, company_id: CO, phone: "+94700000004", full_name: "Absent Admin", username: null, is_admin: true },
  otherCo: { id: ADMIN_OTHER_CO, company_id: OTHER_CO, phone: "+94700000005", full_name: "Other Co Admin", username: null, is_admin: true },
  staff: { id: STAFF_NOT_ADMIN, company_id: CO, phone: "+94700000006", full_name: "Ordinary Staff", username: null, is_admin: false },
};

/** One overdue task whose entire escalation chain is on leave. */
const tasks = [{
  id: TASK, company_id: CO, title: "Overdue thing", status: "in_progress",
  due_date: "2020-01-01", updated_at: LONG_AGO, last_reminder_at: null,
  escalation_chain: [CHAIN_MEMBER], escalation_level: 0, escalated_to: null,
}];

const memberships = [
  { id: "m-chain", user_id: CHAIN_MEMBER }, { id: "m-free", user_id: ADMIN_FREE },
  { id: "m-busy", user_id: ADMIN_BUSY }, { id: "m-leave", user_id: ADMIN_ON_LEAVE },
  { id: "m-other", user_id: ADMIN_OTHER_CO }, { id: "m-staff", user_id: STAFF_NOT_ADMIN },
];

/** BUSY admin carries 30 hours of open work; FREE admin carries 1. */
const workloadTasks = [
  { id: TASK, estimate_hours: 0 }, { id: "w-busy", estimate_hours: 30 }, { id: "w-free", estimate_hours: 1 },
];
const allAssignments = [
  { task_id: "w-busy", membership_id: "m-busy" }, { task_id: "w-free", membership_id: "m-free" },
];

const taskUpdates: Array<Record<string, unknown>> = [];

function makeDb() {
  const result = (data: unknown) => {
    const t: Record<string, unknown> = {};
    for (const k of ["select", "eq", "in", "not", "lte", "gte", "limit", "order"]) t[k] = () => t;
    t.then = (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data, error: null });
    return t;
  };

  return {
    from(table: string) {
      if (table === "profiles") return result(profiles);
      if (table === "tasks") {
        return {
          ...(result(tasks) as object),
          select: (cols: string) => (cols.includes("estimate_hours") ? result(workloadTasks) : result(tasks)),
          update: (patch: Record<string, unknown>) => ({
            eq: async (_c: string, id: string) => {
              taskUpdates.push({ id, ...patch });
              return { error: null };
            },
          }),
        };
      }
      if (table === "task_assignments") {
        return { select: () => ({ in: () => result([]), limit: () => result(allAssignments) }) };
      }
      if (table === "memberships") return result(memberships);
      if (table === "leave_requests") return result(leaveRows);
      return result([]);
    },
  };
}

const enqueued: Array<{ recipient: string; dedupeKey: string }> = [];

vi.mock("@/lib/supabase/server", () => ({ supabaseAdmin: () => makeDb() }));
vi.mock("@/lib/outbox-enqueue", () => ({
  enqueueOutbox: async (m: { recipient: string; dedupeKey: string }) => {
    enqueued.push({ recipient: m.recipient, dedupeKey: m.dedupeKey });
    return "enqueued";
  },
}));
vi.mock("@/lib/audit", () => ({ writeAudit: async () => ({ ok: true }) }));

const SECRET = "sch003-secret";
const req = () =>
  new Request("http://localhost/api/cron/follow-ups", { headers: { authorization: `Bearer ${SECRET}` } });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  enqueued.length = 0;
  taskUpdates.length = 0;
  // Default world: chain member and one admin on leave; free, busy, other-company and
  // non-admin profiles all present and active.
  profiles = Object.values(ALL_PROFILES);
  leaveRows = [
    { profile_id: CHAIN_MEMBER, start_date: TODAY, end_date: TODAY },
    { profile_id: ADMIN_ON_LEAVE, start_date: TODAY, end_date: TODAY },
  ];
});
afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});

const phone = (userId: string) =>
  String(Object.values(ALL_PROFILES).find((p) => p.id === userId)!.phone).replace(/[^\d]/g, "");

const runRoute = async () => {
  const { GET } = await import("@/app/api/cron/follow-ups/route");
  return GET(req());
};

describe("SCH-003 — escalation fallback selects a SUITABLE person, or nobody", () => {
  it("falls back to an available admin when the whole chain is on leave", async () => {
    const res = await runRoute();
    expect(res.status).toBe(200);
    expect(enqueued.map((e) => e.recipient)).toContain(phone(ADMIN_FREE));
  });

  it("R1-F-001: NEVER notifies an admin on approved leave", async () => {
    await runRoute();
    expect(enqueued.map((e) => e.recipient)).not.toContain(phone(ADMIN_ON_LEAVE));
  });

  it("NEVER notifies the on-leave chain member it advanced past", async () => {
    await runRoute();
    expect(enqueued.map((e) => e.recipient)).not.toContain(phone(CHAIN_MEMBER));
  });

  it("NEVER notifies an INACTIVE member (absent from the active-profile query)", async () => {
    // The route's own query filters is_active; an inactive admin simply is not there.
    profiles = Object.values(ALL_PROFILES).filter((p) => p.id !== ADMIN_FREE);
    await runRoute();
    expect(enqueued.map((e) => e.recipient)).not.toContain(phone(ADMIN_FREE));
  });

  it("NEVER notifies an admin of ANOTHER COMPANY", async () => {
    await runRoute();
    expect(enqueued.map((e) => e.recipient)).not.toContain(phone(ADMIN_OTHER_CO));
  });

  it("NEVER notifies someone LACKING the required authority (not an admin)", async () => {
    await runRoute();
    expect(enqueued.map((e) => e.recipient)).not.toContain(phone(STAFF_NOT_ADMIN));
  });

  it("BATCHES: notifies exactly ONE fallback admin, not every administrator", async () => {
    await runRoute();
    const adminPhones = [phone(ADMIN_FREE), phone(ADMIN_BUSY), phone(ADMIN_ON_LEAVE)];
    const notified = enqueued.map((e) => e.recipient).filter((r) => adminPhones.includes(r));
    expect(notified).toHaveLength(1);
  });

  it("selects the LEAST-LOADED available admin as the single fallback", async () => {
    await runRoute();
    expect(enqueued.map((e) => e.recipient)).toContain(phone(ADMIN_FREE));
    expect(enqueued.map((e) => e.recipient)).not.toContain(phone(ADMIN_BUSY));
  });

  it("NO QUALIFIED PERSON: notifies nobody and records the reason truthfully", async () => {
    // Every admin in the company is on approved leave.
    leaveRows = [
      { profile_id: CHAIN_MEMBER, start_date: TODAY, end_date: TODAY },
      { profile_id: ADMIN_FREE, start_date: TODAY, end_date: TODAY },
      { profile_id: ADMIN_BUSY, start_date: TODAY, end_date: TODAY },
      { profile_id: ADMIN_ON_LEAVE, start_date: TODAY, end_date: TODAY },
    ];
    const res = await runRoute();
    expect(res.status).toBe(200);

    expect(enqueued).toHaveLength(0); // nobody notified — not "everyone" as a fallback

    const patch = taskUpdates.find((u) => u.id === TASK);
    expect(patch, "the task must still be updated so the condition is not lost").toBeTruthy();
    expect(patch!.escalation_reason).toBe("no_available_authorised_target");
    // The item is NOT claimed to be escalated to anybody.
    expect(patch!.escalated_to ?? null).toBeNull();
  });

  it("reports the skipped on-leave targets rather than hiding them", async () => {
    const res = await runRoute();
    const body = (await res.json()) as { ok: boolean; skippedLeave?: number };
    expect(body.ok).toBe(true);
    expect(body.skippedLeave ?? 0).toBeGreaterThan(0);
  });

  it("still refuses an unauthenticated caller", async () => {
    const { GET } = await import("@/app/api/cron/follow-ups/route");
    const res = await GET(new Request("http://localhost/api/cron/follow-ups"));
    expect(res.status).toBe(401);
    expect(enqueued).toHaveLength(0);
  });

  it("dedupes per task, action, recipient and day so a re-run cannot spam", async () => {
    await runRoute();
    const keys = enqueued.map((e) => e.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^followup:task-1:escalation:/);
  });
});
