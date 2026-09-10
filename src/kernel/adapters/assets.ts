/**
 * Assets / fleet observation adapter (R2A).
 *
 * WRAPS the existing, tested `detectRenewals` (src/management/ai-manager/renewals.ts) — the
 * same pure function the fleet pages already use to flag expiring vehicle documents. The
 * expiry rule is not reimplemented and not re-tuned.
 *
 * SCOPE IS DELIBERATELY NARROW: vehicle DOCUMENTS only. AST-001 (asset registry, custody,
 * reservations, utilisation) is `specified` in the register and NOT built, and this adapter
 * does not stand in for it. Covering documents while claiming asset intelligence would
 * overstate what exists.
 */
import { detectRenewals, type RenewalItem } from "@/management/ai-manager/renewals";
import type { EvidenceRef } from "../types";
import {
  dayWindow, freshnessFor, identityKeyFor, priorityFor,
  type Observation, type Severity,
} from "../observation";

export const ASSETS_SOURCE = "assets.document_expiring";

export interface VehicleDocumentRow {
  id: string;
  vehicle_id: string | null;
  doc_type: string | null;
  expiry_date: string | null;
  created_at?: string | null;
}

export interface AssetsScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  documents: VehicleDocumentRow[];
}

export function detectAssetObservations(input: AssetsScanInput): Observation[] {
  const { companyId, correlationId, now } = input;

  const items: RenewalItem[] = input.documents
    .filter((d) => d.expiry_date)
    .map((d) => ({
      id: d.id,
      // `label` feeds the shared detector's alert text; the ADAPTER never copies it into an
      // observation, so a registration number or reference cannot leak into the queue.
      label: d.doc_type ?? "vehicle document",
      dueDate: d.expiry_date,
      kind: d.doc_type ?? "document",
    }));

  const alerts = detectRenewals(items, now);
  const byId = new Map(input.documents.map((d) => [d.id, d]));
  const out: Observation[] = [];

  for (const a of alerts) {
    // `upcoming` is information, not a management exception; only expired and due-soon are.
    if (a.status !== "expired" && a.status !== "due_soon") continue;
    const row = byId.get(a.id);
    if (!row) continue;

    const severity: Severity = a.status === "expired" ? "critical" : "warn";
    // R2S-F-006, and the PRINCIPLE behind it. The stale_source skip in ingest exists for a good
    // reason: acting on a month-old SAMPLE without re-reading it is how an automated system
    // produces confidently wrong instructions. But that reasoning only holds for a SAMPLED
    // MEASUREMENT whose value decays — a capacity snapshot, a health probe.
    //
    // This condition is derived from a stored DATE that the loader re-reads EVERY cycle. The
    // expiry either has passed or it has not; that fact does not decay, and the row was read
    // moments ago. Anchoring freshness to when the row was FILED conflated "the record is old"
    // with "our information is old", and suppressed the longest-overdue cases entirely.
    // Freshness is honestly unknown, which never suppresses and never downgrades.
    const freshness = freshnessFor(null, now);

    const facts = {
      renewal_status: a.status,
      doc_type: row.doc_type ?? "unknown",
      days_until_band: bandFor(a.daysUntil),
    };

    const evidence: EvidenceRef[] = [
      { sourceTable: "vehicle_documents", sourceId: row.id, facts, origin: "detector" },
    ];

    out.push({
      companyId,
      department: "assets",
      observationSource: ASSETS_SOURCE,
      kind: "document_expiring",
      subjectRef: { table: "vehicle_documents", id: row.id },
      evidence,
      evidenceAt: row.created_at ?? row.expiry_date ?? now.toISOString(),
      detectedAt: now.toISOString(),
      facts,
      summary: a.status === "expired" ? "Vehicle document expired" : "Vehicle document expiring",
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      identityKey: identityKeyFor({
        companyId, observationSource: ASSETS_SOURCE, subjectId: row.id, window: dayWindow(now),
      }),
      freshness,
      suggestedActionCategory: a.status === "expired" ? "escalate" : "schedule",
      // A grounded vehicle is an operational and legal matter, never automatic.
      authorityClass: "manager_approval",
      correlationId,
      // The expiry date is a real deadline, recorded on the document itself.
      businessDeadline: row.expiry_date ? { at: row.expiry_date, source: "evidence" } : null,
    });
  }

  return out;
}

function bandFor(days: number | null): string {
  if (days === null) return "unknown";
  if (days < 0) return "overdue";
  if (days <= 7) return "0-7d";
  if (days <= 30) return "8-30d";
  return "30d+";
}
