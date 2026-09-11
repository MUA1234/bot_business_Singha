/**
 * Regression tests for a LIVE observability defect found on 2026-09-11.
 *
 * `source_events.status` has existed since migration 0004 with the states
 * received/processing/processed/failed/dead_letter/duplicate, and `/api/health` counts
 * `received` + `processing` as **unprocessed**. No code path in the application ever advanced
 * it: all 14 live rows sat at `received` with `processed_at` NULL — including every message
 * that had been answered and delivered — so the health metric only ever grew, and a genuinely
 * stuck event looked exactly like a delivered one.
 *
 * The fix closes the lifecycle out at both boundaries (the synchronous webhook and the
 * Inngest worker) from the handler's own outcome. These tests pin the mapping and the write.
 */
import { describe, it, expect, vi } from "vitest";
import { outcomeForHandlerStatus } from "@/events/source-event";
import { completeSourceEvent } from "@/db/source-event-store";

describe("outcomeForHandlerStatus", () => {
  it("marks every handled conversation status as processed", () => {
    for (const status of ["duplicate", "collecting", "awaiting_price", "quoting", "quoted"]) {
      expect(outcomeForHandlerStatus(status)).toEqual({ status: "processed", lastError: null });
    }
  });

  it("marks an unattributable message as FAILED and names the reason", () => {
    // An unmapped business number must become visible: the message is durable and replayable
    // once the number is mapped, and silence here looks like a healthy system.
    expect(outcomeForHandlerStatus("company_unresolved")).toEqual({
      status: "failed",
      lastError: "company_unresolved",
    });
  });

  it("treats an unknown status as a failure rather than silently claiming success", () => {
    expect(outcomeForHandlerStatus("something_new").status).toBe("failed");
  });
});

describe("completeSourceEvent", () => {
  function fakeDb() {
    const updates: { patch: Record<string, unknown>; id: unknown }[] = [];
    const db: any = {
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: unknown) => {
            updates.push({ patch, id });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    };
    return { db, updates };
  }

  it("stamps status, processed_at and the resolved company on the event", async () => {
    const { db, updates } = fakeDb();
    await completeSourceEvent(db, "ev1", { status: "processed", lastError: null }, "company-1");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("ev1");
    expect(updates[0]!.patch).toMatchObject({
      status: "processed",
      last_error: null,
      company_id: "company-1",
    });
    expect(typeof updates[0]!.patch.processed_at).toBe("string");
  });

  it("does not overwrite company_id with null when the company was never resolved", async () => {
    const { db, updates } = fakeDb();
    await completeSourceEvent(db, "ev2", { status: "failed", lastError: "company_unresolved" }, null);
    expect(updates[0]!.patch).not.toHaveProperty("company_id");
    expect(updates[0]!.patch).toMatchObject({ status: "failed", last_error: "company_unresolved" });
  });

  it("never throws — the customer has already been replied to by this point", async () => {
    const db: any = {
      from: () => ({
        update: () => ({ eq: () => Promise.resolve({ error: { message: "permission denied" } }) }),
      }),
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      completeSourceEvent(db, "ev3", { status: "processed", lastError: null }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
