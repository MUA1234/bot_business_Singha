/**
 * Unit tests for the service-provider registry helper.
 */
import { describe, it, expect } from "vitest";
import { providerHealth, type ProviderHealthInput } from "@/modules/crm/service-provider";

function provider(overrides: Partial<ProviderHealthInput> = {}): ProviderHealthInput {
  return {
    status: "active",
    compliance_status: "verified",
    insurance_status: "valid",
    insurance_expiry: undefined,
    ...overrides,
  };
}

describe("providerHealth", () => {
  it("returns verified for active + verified compliance + valid insurance", () => {
    expect(providerHealth(provider())).toBe("verified");
  });

  it("returns blocked for blacklisted status", () => {
    expect(providerHealth(provider({ status: "blacklisted" }))).toBe("blocked");
  });

  it("returns blocked for expired compliance", () => {
    expect(providerHealth(provider({ compliance_status: "expired" }))).toBe("blocked");
  });

  it("returns blocked for expired insurance", () => {
    expect(providerHealth(provider({ insurance_status: "expired" }))).toBe("blocked");
  });

  it("returns blocked when insurance expiry is past the reference date", () => {
    expect(providerHealth(provider({ insurance_expiry: "2024-01-01" }), new Date("2024-06-01"))).toBe("blocked");
  });

  it("returns verified when insurance expiry is on or after the reference date", () => {
    expect(providerHealth(provider({ insurance_expiry: "2024-06-01" }), new Date("2024-06-01"))).toBe("verified");
    expect(providerHealth(provider({ insurance_expiry: "2024-12-31" }), new Date("2024-06-01"))).toBe("verified");
  });

  it("returns warning when compliance is pending", () => {
    expect(providerHealth(provider({ compliance_status: "pending" }))).toBe("warning");
  });

  it("returns warning when insurance is pending", () => {
    expect(providerHealth(provider({ insurance_status: "pending" }))).toBe("warning");
  });

  it("returns warning when status is inactive", () => {
    expect(providerHealth(provider({ status: "inactive" }))).toBe("warning");
  });
});
