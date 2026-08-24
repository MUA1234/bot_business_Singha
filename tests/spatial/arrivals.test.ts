import { describe, it, expect } from "vitest";
import { mergeArrivals, taskToArrival, notificationToArrival } from "@/components/spatial/arrivalAdapter";
import type { ArrivalTaskRow, ArrivalNotifRow } from "@/components/spatial/arrivalAdapter";

function task(overrides: Partial<ArrivalTaskRow> = {}): ArrivalTaskRow {
  return {
    id: `task-${overrides.id ?? Math.random().toString(36).slice(2)}`,
    title: "A task",
    status: "in_progress",
    due_date: null,
    priority: 3,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function notif(overrides: Partial<ArrivalNotifRow> = {}): ArrivalNotifRow {
  return {
    id: `notif-${overrides.id ?? Math.random().toString(36).slice(2)}`,
    title: "A notification",
    body: "Details",
    type: "task_assigned",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("arrival adapter", () => {
  it("maps a task to a task arrival with a computed priority", () => {
    const t = task({ status: "blocked", priority: 1, due_date: "2026-08-20" });
    const arrival = taskToArrival(t, new Date("2026-08-24"));
    expect(arrival.kind).toBe("task");
    expect(arrival.moduleType).toBe("tasks");
    expect(arrival.priority).toBe("critical");
    expect(arrival.id).toBe(`task:${t.id}`);
  });

  it("maps a notification to an alert arrival", () => {
    const n = notif({ title: "Approval needed", body: "Please review" });
    const arrival = notificationToArrival(n);
    expect(arrival.kind).toBe("alert");
    expect(arrival.title).toBe("Approval needed");
    expect(arrival.message).toBe("Please review");
    expect(arrival.moduleType).toBe("command");
  });

  it("filters out terminal tasks", () => {
    const arrivals = mergeArrivals(
      [task({ status: "completed" }), task({ status: "cancelled" }), task({ status: "in_progress" })],
      [],
    );
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]!.title).toBe("A task");
  });

  it("deduplicates repeated events", () => {
    const t = task({ id: "dup" });
    const arrivals = mergeArrivals([t, t, t], []);
    expect(arrivals).toHaveLength(1);
  });

  it("filters arrivals by authorised module type", () => {
    const arrivals = mergeArrivals(
      [task({ status: "blocked" })],
      [notif()],
      { allowedModuleTypes: ["tasks"] },
    );
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]!.kind).toBe("task");
  });

  it("sorts by priority then recency", () => {
    const now = new Date("2026-08-24T12:00:00Z");
    const old = task({ id: "old-critical", status: "blocked", priority: 1, created_at: "2026-08-20T12:00:00Z" });
    const recent = task({ id: "recent-high", status: "awaiting_evidence", priority: 2, created_at: "2026-08-23T12:00:00Z" });
    const arrivals = mergeArrivals([recent, old], [], { now });
    expect(arrivals[0]!.id).toBe(`task:${old.id}`);
    expect(arrivals[1]!.id).toBe(`task:${recent.id}`);
  });

  it("limits the result set", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task({ id: String(i), priority: i + 1 }));
    const arrivals = mergeArrivals(tasks, [], { limit: 3 });
    expect(arrivals).toHaveLength(3);
  });
});
