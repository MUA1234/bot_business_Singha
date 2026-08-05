import { describe, it, expect } from "vitest";
import { systemHealth } from "@/management/ai-manager/health";

describe("system health (change plan §13)", () => {
  it("is ok when nothing is failing or backlogged", () => {
    const h = systemHealth({ failedEvents: 0, deadLetters: 0, outboxFailed: 0, unprocessedEvents: 3 });
    expect(h.level).toBe("ok");
    expect(h.issues).toEqual([]);
  });

  it("is critical on any failure state", () => {
    expect(systemHealth({ failedEvents: 1, deadLetters: 0, outboxFailed: 0, unprocessedEvents: 0 }).level).toBe("critical");
    expect(systemHealth({ failedEvents: 0, deadLetters: 2, outboxFailed: 0, unprocessedEvents: 0 }).level).toBe("critical");
    expect(systemHealth({ failedEvents: 0, deadLetters: 0, outboxFailed: 5, unprocessedEvents: 0 }).level).toBe("critical");
  });

  it("warns on a large backlog", () => {
    const h = systemHealth({ failedEvents: 0, deadLetters: 0, outboxFailed: 0, unprocessedEvents: 120 });
    expect(h.level).toBe("warn");
    expect(h.issues.join(" ")).toMatch(/backlog/);
  });
});
