import { describe, it, expect } from "vitest";
import {
  detectTaskExceptions,
  detectCapacityExceptions,
  sortBySeverity,
  type TaskLike,
  type Exception,
} from "@/management/ai-manager/exceptions";

const NOW = new Date("2026-08-05T12:00:00Z");
const iso = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString();

describe("exception detector (change plan §6.2)", () => {
  it("flags overdue as critical, skips terminal tasks", () => {
    const tasks: TaskLike[] = [
      { id: "1", title: "late", status: "in_progress", dueDate: iso(-1), lastCheckInAt: iso(0) },
      { id: "2", title: "done", status: "completed", dueDate: iso(-5) },
    ];
    const ex = detectTaskExceptions(tasks, NOW);
    expect(ex.some((e) => e.type === "overdue" && e.taskId === "1")).toBe(true);
    expect(ex.some((e) => e.taskId === "2")).toBe(false); // completed skipped
  });

  it("flags due_soon within 2 days", () => {
    const ex = detectTaskExceptions(
      [{ id: "3", title: "soon", status: "scheduled", dueDate: iso(1), estimateHours: 4 }],
      NOW,
    );
    expect(ex.some((e) => e.type === "due_soon")).toBe(true);
  });

  it("flags blocked, escalated, stale check-in and missing estimate", () => {
    const ex = detectTaskExceptions(
      [
        { id: "b", title: "b", status: "blocked" },
        { id: "e", title: "e", status: "escalated" },
        { id: "s", title: "s", status: "in_progress", lastCheckInAt: iso(-5), estimateHours: 2 },
        { id: "m", title: "m", status: "scheduled", estimateHours: null },
      ],
      NOW,
    );
    const types = ex.map((e) => e.type);
    expect(types).toContain("blocked");
    expect(types).toContain("escalated");
    expect(types).toContain("stale_check_in");
    expect(types).toContain("missing_estimate");
  });

  it("capacity: overloaded critical, underallocated info", () => {
    const ex = detectCapacityExceptions([
      { membershipId: "m1", status: "overloaded", utilizationPct: 130 },
      { membershipId: "m2", status: "underallocated", utilizationPct: 20 },
      { membershipId: "m3", status: "healthy", utilizationPct: 80 },
    ]);
    expect(ex).toHaveLength(2);
    expect(ex[0]?.severity).toBe("critical"); // sorted critical-first
  });

  it("sortBySeverity orders critical → warn → info", () => {
    const list: Exception[] = [
      { type: "due_soon", severity: "warn", message: "" },
      { type: "underallocated", severity: "info", message: "" },
      { type: "overdue", severity: "critical", message: "" },
    ];
    expect(sortBySeverity(list).map((e) => e.severity)).toEqual(["critical", "warn", "info"]);
  });
});
