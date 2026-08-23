/**
 * PRJ-005 — Portfolio prioritisation helpers.
 */
import { describe, it, expect } from "vitest";
import { rankProjectsByPriority, projectRiskExposure, PRIORITY_WEIGHTS, type ProjectPrioritisationInput } from "@/modules/project/portfolio-prioritisation";

const project = (over: Partial<ProjectPrioritisationInput> = {}): ProjectPrioritisationInput => ({
  projectId: over.projectId ?? "p1",
  name: over.name ?? "Project",
  valueTotal: over.valueTotal ?? "0",
  openRisks: over.openRisks ?? [],
  overloadedPeople: over.overloadedPeople ?? 0,
  overdueOrBlockedTasks: over.overdueOrBlockedTasks ?? 0,
});

describe("projectRiskExposure", () => {
  it("returns 0 when there are no open risks", () => {
    expect(projectRiskExposure([])).toBe(0);
  });

  it("returns the maximum exposure score among open risks", () => {
    expect(
      projectRiskExposure([
        { impact: "low", likelihood: "low" },
        { impact: "critical", likelihood: "high" },
      ]),
    ).toBe(12);
  });
});

describe("rankProjectsByPriority", () => {
  it("returns an empty array for no projects", () => {
    expect(rankProjectsByPriority([])).toEqual([]);
  });

  it("ranks a higher-value project above a lower-value project", () => {
    const a = project({ projectId: "a", name: "A", valueTotal: "100000" });
    const b = project({ projectId: "b", name: "B", valueTotal: "10000" });
    const ranked = rankProjectsByPriority([b, a]);
    expect(ranked.map((r) => r.projectId)).toEqual(["a", "b"]);
  });

  it("penalises projects with high risk", () => {
    const safe = project({ projectId: "safe", name: "Safe", valueTotal: "50000" });
    const risky = project({
      projectId: "risky",
      name: "Risky",
      valueTotal: "50000",
      openRisks: [{ impact: "critical", likelihood: "critical" }],
    });
    const ranked = rankProjectsByPriority([risky, safe]);
    expect(ranked[0]!.projectId).toBe("safe");
  });

  it("penalises projects with overloaded capacity", () => {
    const ok = project({ projectId: "ok", name: "OK", valueTotal: "50000" });
    const overloaded = project({ projectId: "over", name: "Over", valueTotal: "50000", overloadedPeople: 3 });
    const ranked = rankProjectsByPriority([overloaded, ok]);
    expect(ranked[0]!.projectId).toBe("ok");
  });

  it("penalises projects with overdue or blocked dependencies", () => {
    const clean = project({ projectId: "clean", name: "Clean", valueTotal: "50000" });
    const blocked = project({ projectId: "blocked", name: "Blocked", valueTotal: "50000", overdueOrBlockedTasks: 4 });
    const ranked = rankProjectsByPriority([blocked, clean]);
    expect(ranked[0]!.projectId).toBe("clean");
  });

  it("uses custom weights when supplied", () => {
    const a = project({ projectId: "a", name: "A", valueTotal: "100000" });
    const b = project({ projectId: "b", name: "B", valueTotal: "10000", overdueOrBlockedTasks: 1 });
    // With dependency weight 0, value should dominate and a wins.
    const ranked = rankProjectsByPriority([b, a], { ...PRIORITY_WEIGHTS, dependency: 0 });
    expect(ranked[0]!.projectId).toBe("a");
  });

  it("exposes per-axis ranks in the result", () => {
    const a = project({ projectId: "a", name: "A", valueTotal: "100000" });
    const b = project({ projectId: "b", name: "B", valueTotal: "10000" });
    const ranked = rankProjectsByPriority([a, b]);
    const aResult = ranked.find((r) => r.projectId === "a")!;
    expect(aResult.valueRank).toBe(1);
    expect(aResult.score).toBeLessThan(ranked.find((r) => r.projectId === "b")!.score);
  });
});
