/**
 * SCH-003 — leave and workload-aware escalation fallback, tested BEHAVIOURALLY.
 *
 * WHY THIS FILE EXISTS (defect PR-F-013).
 * `sch-003-leave-workload-aware-scheduling.test.ts` asserted this invariant by checking that
 * the route's SOURCE TEXT contained a particular multi-line expression. That assertion:
 *   * failed on any CRLF checkout, because the expected string embedded `\n` — it was the
 *     single red test on the approved baseline, and it was red for a reason unrelated to the
 *     behaviour it claimed to protect;
 *   * would have passed even if the fallback selected an admin who was ON LEAVE, or ignored
 *     workload order entirely, so long as the characters were present;
 *   * would have failed on a harmless reformat, training the reader to ignore it.
 *
 * This test drives the REAL route handler with a controlled database and asserts what it
 * actually DOES. It is strictly stronger: it fails on three independent regressions the
 * source-text assertion could not detect — no fallback at all, an unavailable admin being
 * reminded, and the wrong workload order — and it is indifferent to formatting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── the controlled database ────────────────────────────────────────────────────────────
const TODAY = new Date().toISOString().slice(0, 10);
const LONG_AGO = new Date(Date.now() - 30 * 86_400_000).toISOString();

const CO = "co-1";
const CHAIN_MEMBER = "user-chain-on-leave";
const ADMIN_FREE = "user-admin-free";
const ADMIN_BUSY = "user-admin-busy";
const ADMIN_ON_LEAVE = "user-admin-on-leave";
const TASK = "task-1";

const profiles = [
  { id: CHAIN_MEMBER, company_id: CO, phone: "+94700000001", full_name: "Chain Member", username: null, is_admin: false },
  { id: ADMIN_FREE, company_id: CO, phone: "+94700000002", full_name: "Free Admin", username: null, is_admin: true },
  { id: ADMIN_BUSY, company_id: CO, phone: "+94700000003", full_name: "Busy Admin", username: null, is_admin: true },
  { id: ADMIN_ON_LEAVE, company_id: CO, phone: "+94700000004", full_name: "Absent Admin", username: null, is_admin: true },
];

/** One overdue task whose entire escalation chain is on leave. */
const tasks = [
  {
    id: TASK,
    company_id: CO,
    title: "Overdue thing",
    status: "in_progress",
    due_date: "2020-01-01",
    updated_at: LONG_AGO,
    last_reminder_at: null,
    escalation_chain: [CHAIN_MEMBER],
    escalation_level: 0,
    escalated_to: null,
  },
];

/** Memberships map user ids to membership ids; workload is derived from assignments. */
const memberships = [
  { id: "m-chain", user_id: CHAIN_MEMBER },
  { id: "m-free", user_id: ADMIN_FREE },
  { id: "m-busy", user_id: ADMIN_BUSY },
  { id: "m-leave", user_id: ADMIN_ON_LEAVE },
];

/** BUSY admin carries 30 hours of open work; FREE admin carries 1. */
const workloadTasks = [
  { id: TASK, estimate_hours: 0 },
  { id: "w-busy", estimate_hours: 30 },
  { id: "w-free", estimate_hours: 1 },
];
const allAssignments = [
  { task_id: "w-busy", membership_id: "m-busy" },
  { task_id: "w-free", membership_id: "m-free" },
];

/** The chain member AND one admin are on approved leave today. */
const leaveRows = [
  { profile_id: CHAIN_MEMBER, start_date: TODAY, end_date: TODAY },
  { profile_id: ADMIN_ON_LEAVE, start_date: TODAY, end_date: TODAY },
];

const taskUpdates: Array<Record<string, unknown>> = [];

/**
 * A minimal chainable stand-in for the Supabase client.
 *
 * Deliberately keyed on the TABLE only: the route's filters narrow rows the fake already
 * returns in their narrowed form, so the fake cannot make a test pass by widening a filter.
 */
function makeDb() {
  const result = (data: unknown) => {
    const thenable = {
      select: () => thenable,
      eq: () => thenable,
      in: () => thenable,
      not: () => thenable,
      lte: () => thenable,
      gte: () => thenable,
      limit: () => thenable,
      order: () => thenable,
      then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data, error: null }),
    };
    return thenable;
  };

  return {
    from(table: string) {
      if (table === "profiles") return result(profiles);
      if (table === "tasks") {
        return {
          ...result(tasks),
          // `tasks` is read twice (task list, then workload) and written once.
          select: (cols: string) => (cols.includes("estimate_hours") ? result(workloadTasks) : result(tasks)),
          update: (patch: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              taskUpdates.push({ id, ...patch });
              return { error: null };
            },
          }),
        };
      }
      if (table === "task_assignments") {
        return {
          select: () => ({
            in: () => result([]), // no direct assignees: escalation is the path under test
            limit: () => result(allAssignments),
          }),
        };
      }
      if (table === "memberships") return result(memberships);
      if (table === "leave_requests") return result(leaveRows);
      return result([]);
    },
  };
}

// ── mocks ──────────────────────────────────────────────────────────────────────────────
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
});
afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});

const phoneOf = (userId: string) => profiles.find((p) => p.id === userId)!.phone.replace(/[^\d]/g, "");

describe("SCH-003 — escalation falls back to available admins (behavioural)", () => {
  it("falls back to company admins when the whole escalation chain is on leave", async () => {
    const { GET } = await import("@/app/api/cron/follow-ups/route");
    const res = await GET(req());
    expect(res.status).toBe(200);

    expect(enqueued.length).toBeGreaterThan(0);
    const recipients = enqueued.map((e) => e.recipient);
    expect(recipients).toContain(phoneOf(ADMIN_FREE));
  });

  /**
   * DEFECT R1-F-001 — reproduced, reported, NOT silently fixed.
   *
   * The escalation FALLBACK reminds every company admin it can find, including admins on
   * approved leave. `rankAvailableCandidates` only SORTS ("most available first"); it does
   * not filter, and the fallback loop at route.ts:291-301 never checks `avail.available`.
   * Its sibling — the ordinary reminder path at route.ts:319-322 — does exactly that check
   * (`if (!avail.available) { skippedLeave++; continue; }`), so this is one missing guard in
   * one branch, not a design disagreement.
   *
   * It contradicts SCH-003's stated invariant ("escalation targets on leave are skipped").
   * The old source-text assertion could never have caught it: the characters
   * `rankAvailableCandidates(...)` are present and correct.
   *
   * `it.fails` states the truth: this expectation is currently NOT met. It is not a
   * permissive assertion — the suite goes RED the moment the route is fixed, which forces
   * this block to be converted into an ordinary assertion rather than quietly forgotten.
   * Fixing the route is a product change outside the authorised test-correction scope and
   * awaits an owner decision.
   */
  it.fails("DEFECT R1-F-001: does NOT yet skip an admin on approved leave in the fallback", async () => {
    const { GET } = await import("@/app/api/cron/follow-ups/route");
    await GET(req());

    const recipients = enqueued.map((e) => e.recipient);
    expect(recipients).not.toContain(phoneOf(ADMIN_ON_LEAVE));
  });

  it("NEVER reminds the on-leave chain member it advanced past", async () => {
    const { GET } = await import("@/app/api/cron/follow-ups/route");
    await GET(req());

    const recipients = enqueued.map((e) => e.recipient);
    expect(recipients).not.toContain(phoneOf(CHAIN_MEMBER));
  });

  it("ranks available admins by workload — the least loaded is reminded FIRST", async () => {
    const { GET } = await import("@/app/api/cron/follow-ups/route");
    await GET(req());

    const recipients = enqueued.map((e) => e.recipient);
    const free = recipients.indexOf(phoneOf(ADMIN_FREE));
    const busy = recipients.indexOf(phoneOf(ADMIN_BUSY));
    expect(free).toBeGreaterThanOrEqual(0);
    expect(busy).toBeGreaterThanOrEqual(0);
    expect(free, "the least-loaded available admin must be reminded before the busiest").toBeLessThan(busy);
  });

  it("reports the skipped on-leave targets rather than hiding them", async () => {
    const { GET } = await import("@/app/api/cron/follow-ups/route");
    const res = await GET(req());
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
    const { GET } = await import("@/app/api/cron/follow-ups/route");
    await GET(req());
    const keys = enqueued.map((e) => e.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^followup:task-1:escalation:/);
  });
});
