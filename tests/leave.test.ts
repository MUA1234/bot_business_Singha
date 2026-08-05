import { describe, it, expect } from "vitest";
import { calendarDays, overlaps, usedLeaveDays, remainingLeave } from "@/modules/workforce/leave";

describe("leave calculations (change plan §7.1)", () => {
  it("counts inclusive calendar days", () => {
    expect(calendarDays("2026-08-05", "2026-08-05")).toBe(1);
    expect(calendarDays("2026-08-05", "2026-08-07")).toBe(3);
    expect(calendarDays("2026-08-07", "2026-08-05")).toBe(0); // end before start
  });

  it("detects overlap", () => {
    expect(overlaps({ start: "2026-08-05", end: "2026-08-10" }, { start: "2026-08-09", end: "2026-08-12" })).toBe(true);
    expect(overlaps({ start: "2026-08-05", end: "2026-08-06" }, { start: "2026-08-07", end: "2026-08-08" })).toBe(false);
  });

  it("sums used and computes remaining", () => {
    const approved = [
      { start: "2026-08-05", end: "2026-08-07" }, // 3
      { start: "2026-09-01", end: "2026-09-02" }, // 2
    ];
    expect(usedLeaveDays(approved)).toBe(5);
    expect(remainingLeave(21, approved)).toBe(16);
  });
});
