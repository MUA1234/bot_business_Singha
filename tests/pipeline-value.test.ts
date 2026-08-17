import { describe, it, expect } from "vitest";
import { summarizePipeline, type Opportunity } from "@/modules/commercial/pipeline-value";

describe("pipeline value (change plan §9.1) — Decimal-exact, canonical string outputs", () => {
  const opps: Opportunity[] = [
    { amount: "100000", probability: 50, status: "open" },
    { amount: "200000", probability: 25, status: "open" },
    { amount: "50000", probability: 100, status: "won" },
    { amount: "999", probability: 80, status: "lost" },
  ];

  it("summarises open value, weighted forecast and won value", () => {
    const s = summarizePipeline(opps);
    expect(s.openCount).toBe(2);
    expect(s.openValue).toBe("300000.00");
    expect(s.weightedValue).toBe("100000.00"); // 100k*0.5 + 200k*0.25
    expect(s.wonValue).toBe("50000.00");
  });

  it("clamps probability and ignores negative amounts", () => {
    const s = summarizePipeline([
      { amount: "-5", probability: 200, status: "open" },
      { amount: "1000", probability: 100, status: "open" },
    ]);
    expect(s.openValue).toBe("1000.00");
    expect(s.weightedValue).toBe("1000.00");
  });

  it("legacy numeric amounts still work (compat) and empty pipeline is all zero", () => {
    const s = summarizePipeline([{ amount: 1500, probability: 50, status: "open" }]);
    expect(s.openValue).toBe("1500.00");
    expect(s.weightedValue).toBe("750.00");
    expect(summarizePipeline([])).toEqual({ openCount: 0, openValue: "0.00", weightedValue: "0.00", wonValue: "0.00" });
  });

  it("is float-proof: fractional amounts that drift in JS number math sum exactly", () => {
    // 0.1 + 0.2 !== 0.3 in floats; a pipeline of 10 × 10000000.01 loses cents in float math at scale.
    const s = summarizePipeline([
      { amount: "0.1", probability: 100, status: "open" },
      { amount: "0.2", probability: 100, status: "open" },
    ]);
    expect(s.openValue).toBe("0.30");
    expect(s.weightedValue).toBe("0.30");
    const big = summarizePipeline(
      Array.from({ length: 10 }, (): Opportunity => ({ amount: "10000000.01", probability: 100, status: "open" })),
    );
    expect(big.openValue).toBe("100000000.10");
  });

  it("survives amounts beyond 2^53 minor units without precision loss", () => {
    const s = summarizePipeline([
      { amount: "90071992547409.91", probability: 100, status: "open" },
      { amount: "0.01", probability: 100, status: "open" },
    ]);
    expect(s.openValue).toBe("90071992547409.92");
  });
});
