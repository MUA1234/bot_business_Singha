/**
 * Finance observation adapter (R1 checkpoint 3).
 *
 * WRAPS the existing, tested `src/modules/finance/aging.ts` — `bucketFor` is not
 * reimplemented, reinterpreted or "improved". This adapter's only job is to turn what that
 * detector already computes into the common observation contract.
 *
 * FINANCE MAY NEVER POST, SETTLE, APPROVE OR MOVE MONEY. This module reads and describes.
 * Its suggested action category is `chase` or `review` — a category, not an action — and the
 * kernel maps categories onto registered internal actions only.
 */
import { bucketFor, type AgingBucket } from "@/modules/finance/aging";
import type { EvidenceRef } from "../types";
import {
  dayWindow,
  STORED_STATE_FRESHNESS,
  identityKeyFor,
  priorityFor,
  type Observation,
  type Severity,
} from "../observation";

export const FINANCE_SOURCE = "finance.receivable_overdue";

/** The minimum a detector needs. Deliberately NOT the whole invoice row. */
export interface OverdueInvoiceRow {
  id: string;
  /** ISO date. */
  due_date: string | null;
  /** Total minus settled, as a string to avoid float money. */
  outstanding: string;
  currency: string;
  updated_at: string | null;
  status: string | null;
}

const SEVERITY_BY_BUCKET: Record<AgingBucket, Severity | null> = {
  current: null,      // not overdue — not an observation at all
  d1_30: "info",
  d31_60: "warn",
  d61_90: "warn",
  d90_plus: "critical",
};

/** Settled or void invoices are RESOLVED and must never become new work. */
const RESOLVED_STATUSES = new Set(["paid", "settled", "void", "cancelled", "written_off"]);

export interface FinanceScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  invoices: OverdueInvoiceRow[];
}

export function detectFinanceObservations(input: FinanceScanInput): Observation[] {
  const { companyId, correlationId, now } = input;
  const out: Observation[] = [];

  for (const inv of input.invoices) {
    // RESOLVED source records do not reappear as new work.
    if (inv.status && RESOLVED_STATUSES.has(inv.status.toLowerCase())) continue;

    // An invoice with nothing outstanding is resolved regardless of status text.
    const outstanding = Number(inv.outstanding);
    if (!Number.isFinite(outstanding) || outstanding <= 0) continue;

    const bucket = bucketFor(inv.due_date, now);
    const severity = SEVERITY_BY_BUCKET[bucket];
    if (!severity) continue; // not overdue

    // Stored state, re-read in full this cycle: our information is current however long ago
    // the row was last edited. Anchoring on the record's age discarded the longest-neglected
    // conditions — the ones that most need raising (R2S-P-F-004).
    const freshness = STORED_STATE_FRESHNESS;

    const evidence: EvidenceRef[] = [
      {
        sourceTable: "customer_invoices",
        sourceId: inv.id,
        // Bucket and currency only. NOT the customer, NOT the line detail.
        facts: { aging_bucket: bucket, currency: inv.currency, outstanding_magnitude: magnitude(outstanding) },
        origin: "detector",
      },
    ];

    out.push({
      companyId,
      department: "finance",
      observationSource: FINANCE_SOURCE,
      kind: "receivable_overdue",
      subjectRef: { table: "customer_invoices", id: inv.id },
      evidence,
      evidenceAt: inv.updated_at ?? now.toISOString(),
      detectedAt: now.toISOString(),
      facts: { aging_bucket: bucket, currency: inv.currency, outstanding_magnitude: magnitude(outstanding) },
      summary: `Receivable overdue (${bucket.replace("_", "–")})`,
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1, // deterministic: a date comparison, not a judgement
      identityKey: identityKeyFor({
        companyId,
        observationSource: FINANCE_SOURCE,
        subjectId: inv.id,
        window: dayWindow(now),
      }),
      freshness,
      suggestedActionCategory: severity === "critical" ? "escalate" : "chase",
      // Chasing a customer is never automatic: it touches an external party.
      authorityClass: "manager_approval",
      correlationId,
      // The invoice's own due date IS the business deadline, and it comes from evidence.
      businessDeadline: inv.due_date ? { at: inv.due_date, source: "evidence" } : null,
    });
  }

  return out;
}

/**
 * Order of magnitude rather than the amount.
 *
 * A management queue is read across a company; the exact receivable balance of a named
 * customer is not something every manager needs in order to know that something is overdue.
 * The magnitude conveys urgency; the invoice reference conveys the detail, to whoever is
 * authorised to open it.
 */
function magnitude(v: number): string {
  const a = Math.abs(v);
  if (a >= 10_000_000) return "10m+";
  if (a >= 1_000_000) return "1m-10m";
  if (a >= 100_000) return "100k-1m";
  if (a >= 10_000) return "10k-100k";
  if (a >= 1_000) return "1k-10k";
  return "under-1k";
}
