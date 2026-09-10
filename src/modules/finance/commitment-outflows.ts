/**
 * FIN-004 — Commitments and expected payments.
 * Pure helper that turns company-scoped purchase orders and contractual commitments
 * into dated expected outflows for the rolling cash forecast. No float math; no
 * currency conversion — exact currency match only.
 */
import { decGtZero, Money } from "@/lib/money";

export interface CommitmentOutflow {
  id: string;
  kind: "purchase_order" | "commitment";
  description: string;
  date: string; // ISO date
  amount: string; // decimal string
  currency: string;
  status: string;
}

export interface PurchaseOrderInput {
  id: string;
  po_number: string;
  total_amount: string | number;
  currency: string;
  status: string;
  expected_payment_date: string | null;
}

export interface CommitmentInput {
  id: string;
  description: string;
  amount: string | number;
  currency: string;
  status: string;
  expected_settlement_date: string | null;
}

export interface BuildCommitmentOutflowsOptions {
  purchaseOrders: PurchaseOrderInput[];
  commitments: CommitmentInput[];
  currency: string;
  now?: Date;
  horizonDays?: number;
}

const DAY_MS = 86_400_000;

const TERMINAL_PO_STATUSES = new Set(["closed", "cancelled"]);
const TERMINAL_COMMITMENT_STATUSES = new Set(["settled", "cancelled"]);

function stripTime(d: Date): Date {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  return t;
}

function isWithinHorizon(dateStr: string, now: Date, horizonDays: number): boolean {
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return false;
  const start = stripTime(now).getTime();
  const offset = Math.floor((d.getTime() - start) / DAY_MS);
  return offset >= 0 && offset <= horizonDays;
}

/**
 * Build deterministic commitment outflows for the forecast.
 *
 * Rules:
 * - Exclude terminal statuses (PO: closed/cancelled; commitment: settled/cancelled).
 * - Exclude rows without an expected date or whose date is outside the horizon.
 * - Exact currency match only (no FX conversion).
 * - Sort by date ascending, then by kind+id for determinism.
 */
export function buildCommitmentOutflows(options: BuildCommitmentOutflowsOptions): CommitmentOutflow[] {
  const { purchaseOrders, commitments, currency, now = new Date(), horizonDays = 90 } = options;
  const out: CommitmentOutflow[] = [];

  for (const po of purchaseOrders) {
    if (TERMINAL_PO_STATUSES.has(po.status)) continue;
    if (!po.expected_payment_date) continue;
    if (po.currency !== currency) continue;
    const amount = Money.of(String(po.total_amount), po.currency).toString();
    if (!decGtZero(amount)) continue;
    if (!isWithinHorizon(po.expected_payment_date, now, horizonDays)) continue;
    out.push({
      id: po.id,
      kind: "purchase_order",
      description: po.po_number,
      date: po.expected_payment_date,
      amount,
      currency: po.currency,
      status: po.status,
    });
  }

  for (const c of commitments) {
    if (TERMINAL_COMMITMENT_STATUSES.has(c.status)) continue;
    if (!c.expected_settlement_date) continue;
    if (c.currency !== currency) continue;
    const amount = Money.of(String(c.amount), c.currency).toString();
    if (!decGtZero(amount)) continue;
    if (!isWithinHorizon(c.expected_settlement_date, now, horizonDays)) continue;
    out.push({
      id: c.id,
      kind: "commitment",
      description: c.description,
      date: c.expected_settlement_date,
      amount,
      currency: c.currency,
      status: c.status,
    });
  }

  out.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.id.localeCompare(b.id);
  });

  return out;
}
