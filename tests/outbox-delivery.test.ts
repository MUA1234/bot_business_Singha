import { describe, it, expect } from "vitest";
import { selectDueForDelivery, planAfterAttempt, deadLetters, replayReset, type OutboxRow } from "@/events/outbox-delivery";
import { MAX_OUTBOX_ATTEMPTS } from "@/events/outbox";

const now = new Date("2026-08-15T12:00:00Z");
const iso = (offMin: number) => new Date(now.getTime() + offMin * 60_000).toISOString();

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: "o1",
  status: "pending",
  attempts: 0,
  next_retry_at: null,
  last_error: null,
  created_at: "2026-08-15T10:00:00Z",
  ...over,
});

describe("selectDueForDelivery", () => {
  it("includes pending and due-failed, excludes sent/dead/future-failed", () => {
    const rows = [
      row({ id: "pending", status: "pending" }),
      row({ id: "due-failed", status: "failed", next_retry_at: iso(-1) }),
      row({ id: "future-failed", status: "failed", next_retry_at: iso(+10) }),
      row({ id: "sent", status: "sent" }),
      row({ id: "dead", status: "dead" }),
    ];
    const due = selectDueForDelivery(rows, now).map((r) => r.id);
    expect(due).toContain("pending");
    expect(due).toContain("due-failed");
    expect(due).not.toContain("future-failed");
    expect(due).not.toContain("sent");
    expect(due).not.toContain("dead");
  });

  it("orders oldest first (FIFO)", () => {
    const rows = [
      row({ id: "new", created_at: "2026-08-15T11:00:00Z" }),
      row({ id: "old", created_at: "2026-08-15T09:00:00Z" }),
    ];
    expect(selectDueForDelivery(rows, now).map((r) => r.id)).toEqual(["old", "new"]);
  });
});

describe("planAfterAttempt", () => {
  it("marks sent and clears retry on success", () => {
    const p = planAfterAttempt({ attempts: 1 }, { ok: true }, now);
    expect(p.status).toBe("sent");
    expect(p.attempts).toBe(2);
    expect(p.next_retry_at).toBeNull();
  });

  it("schedules a retry on failure below the cap", () => {
    const p = planAfterAttempt({ attempts: 0 }, { ok: false, error: "timeout" }, now);
    expect(p.status).toBe("failed");
    expect(p.next_retry_at).not.toBeNull();
    expect(p.last_error).toBe("timeout");
  });

  it("dead-letters at the attempt cap (no further retry)", () => {
    const p = planAfterAttempt({ attempts: MAX_OUTBOX_ATTEMPTS - 1 }, { ok: false, error: "gone" }, now);
    expect(p.status).toBe("dead");
    expect(p.next_retry_at).toBeNull();
  });

  it("truncates a very long error", () => {
    const p = planAfterAttempt({ attempts: 0 }, { ok: false, error: "x".repeat(1000) }, now);
    expect(p.last_error!.length).toBe(500);
  });
});

describe("dead letters + replay", () => {
  it("lists only dead rows", () => {
    expect(deadLetters([row({ status: "dead" }), row({ status: "failed" })]).map((r) => r.status)).toEqual(["dead"]);
  });

  it("replays only dead/failed, resetting to pending", () => {
    expect(replayReset({ status: "dead" })).toMatchObject({ status: "pending", attempts: 0 });
    expect(replayReset({ status: "failed" })).toMatchObject({ status: "pending" });
    expect(replayReset({ status: "sent" })).toBeNull();
    expect(replayReset({ status: "pending" })).toBeNull();
  });
});
