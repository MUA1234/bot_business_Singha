/**
 * CTL-004 — Explainable business-health score helpers.
 */
import { describe, it, expect } from "vitest";
import { computeHealthScore, healthScoreWeights, healthScoreStatusTone } from "@/modules/management/health-score";

const base = () => ({
  currency: "LKR",
  cashTotal: "1000000",
  arOverdue: "0",
  apOverdue: "0",
  openTasks: 5,
  overdueTasks: 0,
  blockedTasks: 0,
  openRisks: 0,
  openIncidents: 0,
  openObligations: 0,
  overloadedPeople: 0,
  totalPeople: 5,
  forecastGoesNegative: false,
});

describe("computeHealthScore", () => {
  it("returns a high score for a healthy profile", () => {
    const h = computeHealthScore(base());
    expect(h.score).toBeGreaterThan(80);
    expect(h.status).toBe("ok");
    expect(h.issues).toContain("healthy profile");
  });

  it("penalises negative cash", () => {
    const h = computeHealthScore({ ...base(), cashTotal: "-50000" });
    expect(h.components.find((c) => c.name === "Cash on hand")!.score).toBe(0);
    expect(h.issues).toContain("cash is low or negative");
  });

  it("penalises overdue receivables", () => {
    const h = computeHealthScore({ ...base(), arOverdue: "1000000" });
    expect(h.components.find((c) => c.name === "Overdue receivables")!.score).toBeLessThan(70);
    expect(h.issues).toContain("overdue receivables");
  });

  it("penalises overdue payables", () => {
    const h = computeHealthScore({ ...base(), apOverdue: "1000000" });
    expect(h.components.find((c) => c.name === "Overdue payables")!.score).toBeLessThan(60);
    expect(h.issues).toContain("overdue payables");
  });

  it("penalises task pressure", () => {
    const h = computeHealthScore({ ...base(), overdueTasks: 3, blockedTasks: 2 });
    expect(h.components.find((c) => c.name === "Task health")!.score).toBeLessThan(60);
    expect(h.issues).toContain("task pressure");
  });

  it("penalises capacity overload", () => {
    const h = computeHealthScore({ ...base(), overloadedPeople: 3, totalPeople: 5 });
    expect(h.components.find((c) => c.name === "Capacity pressure")!.score).toBe(52);
    expect(h.issues).toContain("capacity pressure");
  });

  it("penalises a negative forecast", () => {
    const h = computeHealthScore({ ...base(), forecastGoesNegative: true });
    expect(h.components.find((c) => c.name === "Cash forecast")!.score).toBe(30);
    expect(h.issues).toContain("forecast goes negative");
  });

  it("penalises open risks, incidents and obligations", () => {
    const h = computeHealthScore({ ...base(), openRisks: 5, openIncidents: 2, openObligations: 3 });
    expect(h.issues).toContain("open risks");
    expect(h.issues).toContain("open incidents");
    expect(h.issues).toContain("open obligations");
  });

  it("exposes weights that sum to 1", () => {
    const w = healthScoreWeights();
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("exposes per-component contributions", () => {
    const h = computeHealthScore(base());
    expect(h.components.length).toBe(9);
    expect(h.components.every((c) => c.contribution >= 0)).toBe(true);
  });
});

describe("healthScoreStatusTone", () => {
  it("maps statuses to badge tones", () => {
    expect(healthScoreStatusTone("critical")).toBe("danger");
    expect(healthScoreStatusTone("warn")).toBe("warn");
    expect(healthScoreStatusTone("ok")).toBe("ok");
  });
});
