import { describe, it, expect } from "vitest";
import { canDecideBankChange } from "@/modules/finance/bank-change-guards";

describe("canDecideBankChange (§WP2.5 maker/checker)", () => {
  it("allows a different approver on a pending change", () => {
    expect(canDecideBankChange("pending", "requester", "approver").ok).toBe(true);
  });

  it("blocks the requester from approving their own change (SoD)", () => {
    const r = canDecideBankChange("pending", "same", "same");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/separation of duties/i);
  });

  it("blocks deciding a change that is not pending", () => {
    expect(canDecideBankChange("approved", "requester", "approver").ok).toBe(false);
    expect(canDecideBankChange("rejected", "requester", "approver").ok).toBe(false);
  });
});
