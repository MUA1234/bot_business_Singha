/**
 * Procurement observation adapter (R2A).
 *
 * WRAPS the existing, tested `needsReorder` (src/modules/procurement/inventory.ts). The rule
 * for when stock is low is not reimplemented.
 *
 * FINANCE RULES STILL APPLY IN FULL. Detecting that stock is low is not authorising a
 * purchase: this module posts nothing, settles nothing, approves nothing and pays nobody. Its
 * output is an internal review at `manager_approval`, because committing spend is a human
 * decision under D-9.
 *
 * Three-way-match variance is deliberately NOT covered here — see the coverage matrix. It
 * needs an invoice-receipt-PO join that exists at page level rather than as a pure module
 * function, and reimplementing it inside an adapter would be exactly the duplication R2A is
 * meant to avoid.
 */
import { needsReorder } from "@/modules/procurement/inventory";
import type { EvidenceRef } from "../types";
import {
  dayWindow, STORED_STATE_FRESHNESS, identityKeyFor, priorityFor,
  type Observation, type Severity,
} from "../observation";

export const PROCUREMENT_SOURCE = "procurement.stock_below_reorder";

export interface InventoryRow {
  id: string;
  quantity_on_hand: number | string | null;
  reorder_level: number | string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProcurementScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  inventory: InventoryRow[];
}

export function detectProcurementObservations(input: ProcurementScanInput): Observation[] {
  const { companyId, correlationId, now } = input;
  const out: Observation[] = [];

  for (const i of input.inventory) {
    const onHand = Number(i.quantity_on_hand);
    const reorderLevel = Number(i.reorder_level);

    // An item with no reorder level has no threshold to breach. Treating a missing level as
    // zero would silently declare every item healthy; skipping says nothing either way.
    if (!Number.isFinite(onHand) || !Number.isFinite(reorderLevel) || reorderLevel <= 0) continue;

    if (!needsReorder({ quantityOnHand: onHand, reorderLevel })) continue;

    // Out of stock is materially worse than merely low.
    const severity: Severity = onHand <= 0 ? "critical" : "warn";
    const evidenceAt = i.updated_at ?? i.created_at ?? null;
    // Stored state, re-read in full this cycle: our information is current however long ago
    // the row was last edited. Anchoring freshness on the record's age discarded the
    // longest-neglected conditions — the ones that most need raising (R2S-P-F-004). The age
    // itself is still carried, as evidenceAt, which is what out-of-order protection compares.
    const freshness = STORED_STATE_FRESHNESS;

    // A COVER BAND, not the quantity: exact stock levels and unit costs are commercially
    // sensitive, and the item reference carries anyone authorised to the real numbers.
    const facts = {
      stock_state: onHand <= 0 ? "out_of_stock" : "below_reorder",
      cover_band: onHand <= 0 ? "0%" : onHand / reorderLevel < 0.5 ? "under-50%" : "50-100%",
    };

    const evidence: EvidenceRef[] = [
      { sourceTable: "inventory_items", sourceId: i.id, facts, origin: "detector" },
    ];

    out.push({
      companyId,
      department: "procurement",
      observationSource: PROCUREMENT_SOURCE,
      kind: "stock_below_reorder",
      subjectRef: { table: "inventory_items", id: i.id },
      evidence,
      evidenceAt: evidenceAt ?? now.toISOString(),
      detectedAt: now.toISOString(),
      facts,
      summary: onHand <= 0 ? "Stock exhausted" : "Stock below reorder level",
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      identityKey: identityKeyFor({
        companyId, observationSource: PROCUREMENT_SOURCE, subjectId: i.id, window: dayWindow(now),
      }),
      freshness,
      suggestedActionCategory: "review",
      // Committing spend is always human.
      authorityClass: "manager_approval",
      correlationId,
      // Stock has no intrinsic recorded deadline.
      businessDeadline: null,
    });
  }

  return out;
}
