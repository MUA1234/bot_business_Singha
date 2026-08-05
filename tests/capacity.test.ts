import { describe, it, expect } from "vitest";
import { computeCapacity } from "@/modules/work/capacity";

describe("capacity engine (change plan §7.2)", () => {
  it("computes a healthy week", () => {
    const r = computeCapacity({
      contractedHours: 40, leaveHours: 0, meetingHours: 5, recurringHours: 5,
      taskEstimateHours: 24, contingencyPct: 0.1,
    });
    // total 40; contingency 4; net = 40-5-5-4 = 26; allocated 24; available 2
    expect(r.totalHours).toBe(40);
    expect(r.netCapacityHours).toBe(26);
    expect(r.availableHours).toBe(2);
    expect(r.status).toBe("healthy");
  });

  it("flags overloaded when allocation exceeds net", () => {
    const r = computeCapacity({
      contractedHours: 40, leaveHours: 8, meetingHours: 4, recurringHours: 4,
      taskEstimateHours: 30, contingencyPct: 0.1,
    });
    // total 32; contingency 3.2; net = 32-4-4-3.2 = 20.8; allocated 30; available < 0
    expect(r.availableHours).toBeLessThan(0);
    expect(r.status).toBe("overloaded");
  });

  it("flags underallocated when utilisation is low", () => {
    const r = computeCapacity({
      contractedHours: 40, leaveHours: 0, meetingHours: 0, recurringHours: 0,
      taskEstimateHours: 5, contingencyPct: 0,
    });
    expect(r.utilizationPct).toBeLessThan(60);
    expect(r.status).toBe("underallocated");
  });

  it("clamps negatives and never returns negative capacity", () => {
    const r = computeCapacity({
      contractedHours: 10, leaveHours: 20, meetingHours: 5, recurringHours: 0,
      taskEstimateHours: -3, contingencyPct: 2,
    });
    expect(r.totalHours).toBe(0); // leave > contracted
    expect(r.netCapacityHours).toBe(0);
    expect(r.allocatedHours).toBe(0); // negative estimate clamped
    expect(r.status).not.toBe("overloaded");
  });
});
