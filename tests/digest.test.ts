import { describe, it, expect } from "vitest";
import { buildDigestBody } from "@/management/ai-manager/digest";

describe("daily digest (change plan §13)", () => {
  it("summarises what needs attention", () => {
    expect(buildDigestBody({ overdueTasks: 3, expiringSoon: 1, overdueObligations: 0, overloadedStaff: 2 }))
      .toBe("Daily digest — 3 overdue tasks; 1 renewal due soon; 2 overloaded staff.");
  });

  it("singular grammar", () => {
    expect(buildDigestBody({ overdueTasks: 1, expiringSoon: 0, overdueObligations: 1, overloadedStaff: 0 }))
      .toBe("Daily digest — 1 overdue task; 1 overdue obligation.");
  });

  it("null when nothing to report", () => {
    expect(buildDigestBody({ overdueTasks: 0, expiringSoon: 0, overdueObligations: 0, overloadedStaff: 0 })).toBe(null);
  });
});
