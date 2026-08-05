import { describe, it, expect } from "vitest";
import { assessObjective } from "@/management/ai-manager/objective-status";

const NOW = new Date("2026-08-05T00:00:00Z");

describe("objective status (change plan §10.1)", () => {
  it("done when target reached", () => {
    expect(assessObjective({ target: 100, current: 100 }, NOW).status).toBe("done");
    expect(assessObjective({ target: 100, current: 120 }, NOW).status).toBe("done");
  });

  it("on track when progress keeps up with time", () => {
    // window half elapsed, progress ~50%
    const a = assessObjective({ target: 100, current: 50, periodStart: "2026-08-01", periodEnd: "2026-08-09" }, NOW);
    expect(a.status).toBe("on_track");
  });

  it("off track when far behind the clock", () => {
    const a = assessObjective({ target: 100, current: 10, periodStart: "2026-08-01", periodEnd: "2026-08-09" }, NOW);
    expect(a.status).toBe("off_track");
  });

  it("at risk in the middle band", () => {
    const a = assessObjective({ target: 100, current: 35, periodStart: "2026-08-01", periodEnd: "2026-08-09" }, NOW);
    expect(a.status).toBe("at_risk");
  });
});
