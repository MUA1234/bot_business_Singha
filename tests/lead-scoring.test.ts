import { describe, it, expect } from "vitest";
import { scoreLead } from "@/modules/commercial/lead-scoring";

describe("lead scoring (change plan §9.1)", () => {
  it("a fresh proposal with big value is hot", () => {
    const s = scoreLead({ stage: "proposal", estimatedValue: 2_000_000, lastContactDaysAgo: 2 });
    expect(s.grade).toBe("hot");
    expect(s.score).toBeGreaterThanOrEqual(60);
  });

  it("a new, stale, small lead is cold", () => {
    const s = scoreLead({ stage: "new", estimatedValue: 0, lastContactDaysAgo: 90 });
    expect(s.grade).toBe("cold");
  });

  it("won and lost leads score zero (out of pipeline)", () => {
    expect(scoreLead({ stage: "won", estimatedValue: 999, lastContactDaysAgo: 1 }).score).toBe(0);
    expect(scoreLead({ stage: "lost", estimatedValue: 999, lastContactDaysAgo: 1 }).score).toBe(0);
  });

  it("score is bounded 0..100", () => {
    const s = scoreLead({ stage: "proposal", estimatedValue: 999_999_999, lastContactDaysAgo: 0 });
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.score).toBeGreaterThanOrEqual(0);
  });
});
