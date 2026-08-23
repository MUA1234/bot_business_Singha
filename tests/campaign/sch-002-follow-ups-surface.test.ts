/**
 * SCH-002 — SLAs, 24/48-hour follow-ups and reminders.
 *
 * The follow-ups cron route must be a real runtime entrypoint that is CRON_SECRET-gated,
 * resolves task assignees through task_assignments → memberships → profiles, calls the
 * deterministic follow-up engine, enqueues approved internal templates through the outbox,
 * and writes an audit record for the batch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const ROUTE = "src/app/api/cron/follow-ups/route.ts";

describe("SCH-002 — Follow-ups cron surface", () => {
  const route = readFileSync(ROUTE, "utf8");

  it("has a real runtime entrypoint under /api/cron/follow-ups", () => {
    expect(route).toContain("export async function GET");
  });

  it("imports and uses the deterministic follow-up engine", () => {
    expect(route).toContain("evaluateFollowUp");
  });

  it("is fail-closed on missing or wrong CRON_SECRET", () => {
    expect(route).toContain("CRON_SECRET");
    expect(route).toContain("timingSafeEqual");
    expect(route).toContain("status: 401");
    expect(route).toContain("status: 500");
  });

  it("reads active profiles and non-terminal tasks", () => {
    expect(route).toContain('from("profiles")');
    expect(route).toContain('from("tasks")');
    expect(route).toContain("completed,cancelled");
  });

  it("resolves assignees through task_assignments and memberships", () => {
    expect(route).toContain('from("task_assignments")');
    expect(route).toContain('from("memberships")');
    expect(route).toContain("assigneesByTask");
  });

  it("enqueues approved internal templates through the outbox", () => {
    expect(route).toContain("enqueueOutbox");
    expect(route).toContain("InternalTemplates");
  });

  it("writes a follow-up audit event for the batch", () => {
    expect(route).toContain("writeAudit");
    expect(route).toContain("follow_up.enqueued");
    expect(route).toContain("follow_up.escalated");
  });

  it("returns the standard cron result shape", () => {
    expect(route).toContain("ok: true");
    expect(route).toContain("tasks:");
    expect(route).toContain("enqueued:");
  });
});
