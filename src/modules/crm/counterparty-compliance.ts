/**
 * CRM-005 — Compliance and insurance status per counterparty.
 *
 * Pure, deterministic health classification shared across suppliers and service
 * providers. Fail-closed: unknown/blocked health refuses ordering.
 */

export interface CounterpartyHealthInput {
  /** Optional counterparty lifecycle status (e.g. 'active', 'blacklisted'). */
  status?: string | null | undefined;
  compliance_status: string;
  insurance_status: string;
  insurance_expiry?: string | null | undefined;
}

export type CounterpartyHealth = "verified" | "warning" | "blocked";

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseISODate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map((n) => Number(n));
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((a.getTime() - b.getTime()) / msPerDay);
}

/**
 * Classify a counterparty's ordering eligibility based on compliance and
 * insurance status.
 *
 * - `blocked`  : blacklisted, expired compliance, expired insurance, or an
 *                insurance expiry date that has passed the reference date.
 * - `verified` : active, compliance verified, insurance valid, and insurance
 *                expiry is at least 30 days after the reference date.
 * - `warning`  : everything else (e.g. pending documents, inactive status, or
 *                insurance due within 30 days).
 */
export function counterpartyHealth(
  input: CounterpartyHealthInput,
  referenceDate: Date = new Date(),
): CounterpartyHealth {
  const ref = startOfDayUTC(referenceDate);

  if (input.status === "blacklisted") return "blocked";
  if (input.compliance_status === "expired") return "blocked";
  if (input.insurance_status === "expired") return "blocked";

  const expiry = parseISODate(input.insurance_expiry);
  if (expiry && expiry < ref) return "blocked";

  if (
    input.status === "active" &&
    input.compliance_status === "verified" &&
    input.insurance_status === "valid"
  ) {
    if (expiry) {
      const days = daysBetween(expiry, ref);
      if (days >= 30) return "verified";
    }
  }

  return "warning";
}

/**
 * Fail-closed ordering gate. Only `verified` and `warning` counterparties may
 * be ordered from; `blocked` or any unrecognised health refuses the order.
 */
export function canOrderFromCounterparty(
  health: CounterpartyHealth | string | undefined | null,
): boolean {
  return health === "verified" || health === "warning";
}
