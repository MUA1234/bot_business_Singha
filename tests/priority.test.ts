import { describe, it, expect } from "vitest";
import { scorePriority, sortByPriority } from "@/management/ai-manager/priority";
import type { TaskState } from "@/modules/work/task-lifecycle";

const NOW = new Date("2026-08-05T12:00:00Z");
const iso = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

describe("priority scorer (change plan §6.2)", () => {
  it("escalated + overdue outranks a calm future task", () => {
    const hot = scorePriority({ status: "escalated", dueDate: iso(-1), basePriority: 1 }, NOW);
    const calm = scorePriority({ status: "in_progress", dueDate: iso(30), basePriority: 4 }, NOW);
    expect(hot).toBeGreaterThan(calm);
  });

  it("terminal tasks sort last (-1)", () => {
    expect(scorePriority({ status: "completed" as TaskState }, NOW)).toBe(-1);
    expect(scorePriority({ status: "cancelled" as TaskState }, NOW)).toBe(-1);
  });

  it("closer deadline scores higher, all else equal", () => {
    const soon = scorePriority({ status: "scheduled", dueDate: iso(1), basePriority: 3 }, NOW);
    const later = scorePriority({ status: "scheduled", dueDate: iso(20), basePriority: 3 }, NOW);
    expect(soon).toBeGreaterThan(later);
  });

  it("sortByPriority puts the most urgent first and terminal last", () => {
    const tasks = [
      { id: "calm", status: "scheduled" as TaskState, dueDate: iso(30), basePriority: 5 },
      { id: "done", status: "completed" as TaskState },
      { id: "hot", status: "escalated" as TaskState, dueDate: iso(-2), basePriority: 1 },
    ];
    const order = sortByPriority(tasks, NOW).map((t) => t.id);
    expect(order[0]).toBe("hot");
    expect(order[order.length - 1]).toBe("done");
  });
});
