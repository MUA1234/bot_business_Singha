import { describe, it, expect } from "vitest";
import { summarizePipeline, type Opportunity } from "@/modules/commercial/pipeline-value";

describe("pipeline value (change plan §9.1)", () => {
  const opps: Opportunity[] = [
    { amount: 100000, probability: 50, status: "open" },
    { amount: 200000, probability: 25, status: "open" },
    { amount: 50000, probability: 100, status: "won" },
    { amount: 999, probability: 80, status: "lost" },
  ];

  it("summarises open value, weighted forecast and won value", () => {
    const s = summarizePipeline(opps);
    expect(s.openCount).toBe(2);
    expect(s.openValue).toBe(300000);
    expect(s.weightedValue).toBe(100000); // 100k*0.5 + 200k*0.25
    expect(s.wonValue).toBe(50000);
  });

  it("clamps probability and ignores negative amounts", () => {
    const s = summarizePipeline([{ amount: -5, probability: 200, status: "open" }, { amount: 1000, probability: 100, status: "open" }]);
    expect(s.openValue).toBe(1000);
    expect(s.weightedValue).toBe(1000);
  });

  it("empty pipeline is all zero", () => {
    expect(summarizePipeline([])).toEqual({ openCount: 0, openValue: 0, weightedValue: 0, wonValue: 0 });
  });
});
