/**
 * PRJ-004 — unit tests for project risk, decision and scenario helpers.
 */
import { describe, it, expect } from "vitest";
import { riskExposureScore, riskExposureLevel, exposureLevel, riskNeedsReview } from "@/modules/project/risks";
import { isValidDecisionOption, decisionStatusLabel } from "@/modules/project/decisions";
import { compareScenarios, anyScenarioBelowFloor } from "@/modules/project/scenarios";

describe("project risks", () => {
  it.each([
    [{ impact: "low", likelihood: "low" }, 1],
    [{ impact: "high", likelihood: "medium" }, 6],
    [{ impact: "critical", likelihood: "critical" }, 16],
  ] as const)("exposure score %o = %i", (input, expected) => {
    expect(riskExposureScore({ ...input, status: "open" })).toBe(expected);
  });

  it.each([
    [1, "low"],
    [4, "medium"],
    [9, "high"],
    [16, "severe"],
  ] as const)("exposure level %i = %s", (score, level) => {
    expect(exposureLevel(score)).toBe(level);
  });

  it("open risk with past review date needs review", () => {
    expect(riskNeedsReview(new Date(Date.now() - 86400000).toISOString().slice(0, 10))).toBe(true);
  });

  it("closed risk never needs review", () => {
    expect(riskExposureLevel({ impact: "critical", likelihood: "critical", status: "closed" })).toBe("severe");
  });
});

describe("project decisions", () => {
  const options = [
    { id: "a", label: "Option A" },
    { id: "b", label: "Option B" },
  ];

  it("validates a known option", () => {
    expect(isValidDecisionOption(options, "a")).toBe(true);
    expect(isValidDecisionOption(options, "c")).toBe(false);
    expect(isValidDecisionOption(options, "")).toBe(false);
  });

  it("labels statuses correctly", () => {
    expect(decisionStatusLabel("pending")).toBe("pending");
    expect(decisionStatusLabel("decided", "a")).toBe("decided");
    expect(decisionStatusLabel("reversed")).toBe("reversed");
  });
});

describe("project scenarios", () => {
  const scenarios = [
    { id: "s1", title: "Conservative", bestCaseTotal: "110", expectedTotal: "100", worstCaseTotal: "90", currency: "LKR" },
    { id: "s2", title: "Aggressive", bestCaseTotal: "150", expectedTotal: "120", worstCaseTotal: "80", currency: "LKR" },
    { id: "s3", title: "Safe", bestCaseTotal: "105", expectedTotal: "95", worstCaseTotal: "92", currency: "LKR" },
  ];

  it("picks the scenario with the highest expected total", () => {
    const result = compareScenarios(scenarios);
    expect(result.preferredId).toBe("s2");
    expect(result.reason).toContain("highest expected total");
  });

  it("returns null when there are no scenarios", () => {
    const result = compareScenarios([]);
    expect(result.preferredId).toBeNull();
  });

  it("detects any scenario below a floor", () => {
    expect(anyScenarioBelowFloor(scenarios, "85")).toBe(true);
    expect(anyScenarioBelowFloor(scenarios, "70")).toBe(false);
  });
});
