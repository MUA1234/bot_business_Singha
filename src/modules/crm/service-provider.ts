/**
 * CRM-003 — Service provider registry helpers.
 *
 * Pure, deterministic status/health classification. No side effects, no floats,
 * no external state.
 */

export interface ProviderHealthInput {
  status: string;
  compliance_status: string;
  insurance_status: string;
  insurance_expiry: string | null | undefined;
}

export type ProviderHealth = "verified" | "warning" | "blocked";

/**
 * Classify a service provider's operational health.
 *
 * - `blocked`  : blacklisted, expired compliance, expired insurance, or insurance past expiry.
 * - `verified` : active, compliance verified, insurance valid, and insurance not expired.
 * - `warning`  : everything else (e.g. pending documents or insurance due soon).
 */
export function providerHealth(
  provider: ProviderHealthInput,
  referenceDate: Date = new Date(),
): ProviderHealth {
  if (provider.status === "blacklisted") return "blocked";
  if (provider.compliance_status === "expired") return "blocked";
  if (provider.insurance_status === "expired") return "blocked";

  if (provider.insurance_expiry) {
    const expiry = new Date(provider.insurance_expiry);
    const ref = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
    if (expiry < ref) return "blocked";
  }

  if (
    provider.status === "active" &&
    provider.compliance_status === "verified" &&
    provider.insurance_status === "valid"
  ) {
    return "verified";
  }

  return "warning";
}
