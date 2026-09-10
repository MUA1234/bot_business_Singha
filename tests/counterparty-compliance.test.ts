/**
 * Unit tests for the counterparty compliance/insurance health helper (CRM-005).
 */
import { describe, it, expect } from "vitest";
import { counterpartyHealth, canOrderFromCounterparty, type CounterpartyHealthInput } from "@/modules/crm/counterparty-compliance";

function input(overrides: Partial<CounterpartyHealthInput> = {}): CounterpartyHealthInput {
  return {
    status: "active",
    compliance_status: "verified",
    insurance_status: "valid",
    insurance_expiry: "2025-12-31",
    ...overrides,
  };
}

describe("counterpartyHealth", () => {
  it("returns verified when active, verified, valid and expiry is >= 30 days away", () => {
    expect(counterpartyHealth(input({ insurance_expiry: "2025-09-22" }), new Date("2025-08-23"))).toBe("verified");
    expect(counterpartyHealth(input({ insurance_expiry: "2025-09-23" }), new Date("2025-08-23"))).toBe("verified");
  });

  it("returns warning when insurance expires within 30 days", () => {
    expect(counterpartyHealth(input({ insurance_expiry: "2025-09-21" }), new Date("2025-08-23"))).toBe("warning");
    expect(counterpartyHealth(input({ insurance_expiry: "2025-08-23" }), new Date("2025-08-23"))).toBe("warning");
  });

  it("returns warning when no insurance expiry is set", () => {
    expect(counterpartyHealth(input({ insurance_expiry: null }), new Date("2025-08-23"))).toBe("warning");
    expect(counterpartyHealth(input({ insurance_expiry: undefined }), new Date("2025-08-23"))).toBe("warning");
  });

  it("returns warning when compliance is pending", () => {
    expect(counterpartyHealth(input({ compliance_status: "pending" }), new Date("2025-08-23"))).toBe("warning");
  });

  it("returns warning when insurance is pending", () => {
    expect(counterpartyHealth(input({ insurance_status: "pending" }), new Date("2025-08-23"))).toBe("warning");
  });

  it("returns warning when status is inactive", () => {
    expect(counterpartyHealth(input({ status: "inactive" }), new Date("2025-08-23"))).toBe("warning");
  });

  it("returns blocked when compliance is expired", () => {
    expect(counterpartyHealth(input({ compliance_status: "expired" }))).toBe("blocked");
  });

  it("returns blocked when insurance is expired", () => {
    expect(counterpartyHealth(input({ insurance_status: "expired" }))).toBe("blocked");
  });

  it("returns blocked when insurance expiry has passed the reference date", () => {
    expect(counterpartyHealth(input({ insurance_expiry: "2024-01-01" }), new Date("2024-06-01"))).toBe("blocked");
    expect(counterpartyHealth(input({ insurance_expiry: "2024-05-31" }), new Date("2024-06-01"))).toBe("blocked");
  });

  it("returns blocked when status is blacklisted", () => {
    expect(counterpartyHealth(input({ status: "blacklisted" }))).toBe("blocked");
  });
});

describe("canOrderFromCounterparty", () => {
  it("allows verified health", () => {
    expect(canOrderFromCounterparty("verified")).toBe(true);
  });

  it("allows warning health", () => {
    expect(canOrderFromCounterparty("warning")).toBe(true);
  });

  it("refuses blocked health", () => {
    expect(canOrderFromCounterparty("blocked")).toBe(false);
  });

  it("refuses unknown or missing health", () => {
    expect(canOrderFromCounterparty("unknown" as any)).toBe(false);
    expect(canOrderFromCounterparty(undefined)).toBe(false);
    expect(canOrderFromCounterparty(null)).toBe(false);
  });
});
