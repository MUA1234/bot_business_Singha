import { describe, it, expect } from "vitest";
import { isSelfAction } from "@/modules/finance/expense-guards";

describe("isSelfAction (separation of duties)", () => {
  it("blocks when the actor is the claimant", () => {
    expect(isSelfAction("u1", "u1")).toBe(true);
  });
  it("allows a different reviewer", () => {
    expect(isSelfAction("u1", "u2")).toBe(false);
  });
  it("is false when the claimant is unknown (guard cannot assert self)", () => {
    expect(isSelfAction(null, "u1")).toBe(false);
    expect(isSelfAction(undefined, "u1")).toBe(false);
  });
});
