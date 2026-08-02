import { describe, it, expect } from "vitest";
import { canTransition, assertTransition, isTerminal } from "@/domain/lifecycle";

describe("Financial-event lifecycle (guide §6)", () => {
  it("allows the happy path", () => {
    const path = [
      ["detected", "draft"],
      ["draft", "awaiting_approval"],
      ["awaiting_approval", "approved"],
      ["approved", "posted"],
      ["posted", "bank_matched"],
      ["bank_matched", "reconciled"],
      ["reconciled", "locked"],
    ] as const;
    for (const [from, to] of path) expect(canTransition(from, to)).toBe(true);
  });

  it("rejects illegal jumps (AI cannot force arbitrary state)", () => {
    expect(canTransition("detected", "posted")).toBe(false);
    expect(canTransition("draft", "reconciled")).toBe(false);
    expect(canTransition("posted", "draft")).toBe(false);
    const r = assertTransition("draft", "posted");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("LIFECYCLE_ILLEGAL");
  });

  it("allows corrective transitions and marks terminals", () => {
    expect(canTransition("posted", "reversed")).toBe(true);
    expect(canTransition("draft", "cancelled")).toBe(true);
    expect(isTerminal("reversed")).toBe(true);
    expect(isTerminal("locked")).toBe(true);
    expect(isTerminal("draft")).toBe(false);
    expect(canTransition("reversed", "draft")).toBe(false); // terminal is dead-end
  });
});
