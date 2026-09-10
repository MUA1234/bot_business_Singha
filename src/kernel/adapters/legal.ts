/**
 * Legal, licences, contracts and compliance observation adapter (R2A).
 *
 * WRAPS the existing, tested `detectRenewals` (src/management/ai-manager/renewals.ts) — the
 * same pure function the legal pages already use. One detector serves several record types
 * because expiry is expiry; the adapter carries the record TYPE through so the queue can tell
 * a licence from an insurance policy.
 *
 * AUTHORITY IS `specialist_approval`, DELIBERATELY HIGHER THAN THE OTHER DOMAINS. An expired
 * licence or a missed statutory obligation is a legal exposure, and RSK-006 records that Sri
 * Lankan advisory sources and human legal review are ABSENT. The kernel therefore raises the
 * fact that a date has passed. It does not advise, interpret, or assess consequence — that
 * would be practising law from a detector.
 */
import { detectRenewals, type RenewalItem } from "@/management/ai-manager/renewals";
import type { EvidenceRef } from "../types";
import {
  dayWindow, STORED_STATE_FRESHNESS, identityKeyFor, priorityFor,
  type Observation, type Severity,
} from "../observation";

export const LEGAL_SOURCE = "legal.obligation_expiring";

/** The record types this adapter covers, and the table each lives in. */
export type LegalRecordKind = "licence" | "contract" | "insurance" | "obligation";

const TABLE_FOR: Record<LegalRecordKind, string> = {
  licence: "licences",
  contract: "contracts",
  insurance: "insurances",
  obligation: "obligations",
};

export interface LegalRecordRow {
  id: string;
  kind: LegalRecordKind;
  /** Expiry, renewal or statutory due date. */
  due_date: string | null;
  status?: string | null;
  updated_at?: string | null;
}

/** Records in these states are closed and must not reappear as new work. */
const RESOLVED = new Set(["closed", "cancelled", "superseded", "renewed", "completed", "archived"]);

export interface LegalScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  records: LegalRecordRow[];
}

export function detectLegalObservations(input: LegalScanInput): Observation[] {
  const { companyId, correlationId, now } = input;

  const live = input.records.filter(
    (r) => r.due_date && !(r.status && RESOLVED.has(r.status.toLowerCase())),
  );

  // A COMPOSITE key. Row ids are unique per table, not across tables, so a licence and a
  // contract can legitimately share one — and keying the detector or the lookup on the bare
  // id would silently drop one of the two records.
  const keyOf = (r: LegalRecordRow) => `${r.kind}:${r.id}`;

  const items: RenewalItem[] = live.map((r) => ({
    id: keyOf(r),
    label: r.kind,
    dueDate: r.due_date,
    kind: r.kind,
  }));

  const alerts = detectRenewals(items, now);
  const byId = new Map(live.map((r) => [keyOf(r), r]));
  const out: Observation[] = [];

  for (const a of alerts) {
    if (a.status !== "expired" && a.status !== "due_soon") continue;
    const row = byId.get(a.id);
    if (!row) continue;

    const severity: Severity = a.status === "expired" ? "critical" : "warn";
    // DEFECT R2S-F-006, completed by R2S-P-F-004. A due or expiry date is not evidence
    // freshness — a licence that expired 400 days ago is the most urgent case there is, and
    // anchoring on that date made it the most certainly discarded one. Replacing it with
    // `updated_at` only moved the threshold: an expired licence whose row nobody has edited
    // for a month read as stale, and ingest SKIPS a stale observation with no existing item.
    //
    // Stored state, re-read in full this cycle: our information is current however long ago
    // the row was last edited. Anchoring freshness on the record's age discarded the
    // longest-neglected conditions — the ones that most need raising (R2S-P-F-004). The age
    // itself is still carried, as evidenceAt, which is what out-of-order protection compares.
    const freshness = STORED_STATE_FRESHNESS;

    const facts = {
      renewal_status: a.status,
      record_kind: row.kind,
      days_until_band:
        a.daysUntil === null ? "unknown" : a.daysUntil < 0 ? "overdue" : a.daysUntil <= 30 ? "0-30d" : "30d+",
    };

    const evidence: EvidenceRef[] = [
      { sourceTable: TABLE_FOR[row.kind], sourceId: row.id, facts, origin: "detector" },
    ];

    out.push({
      companyId,
      department: "legal",
      observationSource: LEGAL_SOURCE,
      kind: "obligation_expiring",
      subjectRef: { table: TABLE_FOR[row.kind], id: row.id },
      evidence,
      evidenceAt: row.updated_at ?? row.due_date ?? now.toISOString(),
      detectedAt: now.toISOString(),
      facts,
      summary: a.status === "expired" ? `${row.kind} expired` : `${row.kind} expiring`,
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      // The record KIND is part of the identity: a licence and a contract with the same row
      // id in different tables are two different conditions.
      identityKey: identityKeyFor({
        companyId, observationSource: LEGAL_SOURCE, subjectId: `${row.kind}:${row.id}`, window: dayWindow(now),
      }),
      freshness,
      suggestedActionCategory: a.status === "expired" ? "escalate" : "schedule",
      // Higher than the other domains, and never automatic. See the module header.
      authorityClass: "specialist_approval",
      correlationId,
      businessDeadline: row.due_date ? { at: row.due_date, source: "evidence" } : null,
    });
  }

  return out;
}
