import { describe, it, expect } from "vitest";
import { urgencyScore } from "@/components/spatial/reducer";

describe("spatial priority / urgency model", () => {
  it("orders urgencies from background to interrupt", () => {
    expect(urgencyScore("background")).toBeLessThan(urgencyScore("queued"));
    expect(urgencyScore("queued")).toBeLessThan(urgencyScore("visible"));
    expect(urgencyScore("visible")).toBeLessThan(urgencyScore("interrupt"));
  });

  it("maps urgency values deterministically", () => {
    expect(urgencyScore("interrupt")).toBe(4);
    expect(urgencyScore("visible")).toBe(3);
    expect(urgencyScore("queued")).toBe(2);
    expect(urgencyScore("background")).toBe(1);
  });
});
