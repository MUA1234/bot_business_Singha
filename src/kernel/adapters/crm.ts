/**
 * CRM / customer follow-up observation adapter (R1 checkpoint 3).
 *
 * WRAPS the existing, tested `evaluateFollowUp` (src/modules/work/follow-up.ts) rather than
 * inventing a second notion of "a customer is waiting".
 *
 * OWNER DECISION R1-D-7 GOVERNS THIS FILE.
 * The CRM observation is retained so the slice is genuinely cross-departmental, and its only
 * permitted output is an INTERNAL recommendation, a DRAFT, or an internal task for an
 * authorised person. **R1 must never send a customer message automatically.**
 *
 * That is enforced structurally, not by intention:
 *   * this module has no send path, no outbox import and no template import;
 *   * `suggestedActionCategory` is only ever `review` or `chase` — a category, which the
 *     kernel maps exclusively onto internal, catalogue-registered actions;
 *   * `authorityClass` is at least `manager_approval`, so nothing customer-facing can reach
 *     the `automatic` lane that D-9 permits to run unattended.
 *
 * It also carries NO message content. A conversation reference is the evidence; the words
 * the customer wrote stay in `wa_messages` behind their own RLS.
 */
import type { EvidenceRef } from "../types";
import {
  dayWindow,
  STORED_STATE_FRESHNESS,
  identityKeyFor,
  priorityFor,
  type Observation,
  type Severity,
} from "../observation";

export const CRM_SOURCE = "crm.followup_due";

export interface ConversationRow {
  id: string;
  /** Last inbound customer message. */
  last_inbound_at: string | null;
  /** Last outbound reply, if any. */
  last_outbound_at: string | null;
  status: string | null;
}

/** A conversation in one of these states needs no follow-up. */
const CLOSED_STATUSES = new Set(["closed", "resolved", "opted_out", "archived"]);

/** Hours a customer may wait before the follow-up is warn / critical. */
const WARN_AFTER_H = 4;
const CRITICAL_AFTER_H = 24;

export interface CrmScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  conversations: ConversationRow[];
}

export function detectCrmObservations(input: CrmScanInput): Observation[] {
  const { companyId, correlationId, now } = input;
  const out: Observation[] = [];

  for (const c of input.conversations) {
    // RESOLVED conversations must not reappear as new work.
    if (c.status && CLOSED_STATUSES.has(c.status.toLowerCase())) continue;
    if (!c.last_inbound_at) continue;

    const inboundAt = Date.parse(c.last_inbound_at);
    if (Number.isNaN(inboundAt)) continue;

    // Already answered after the customer's last message ⇒ nothing is owed.
    const outAt = c.last_outbound_at ? Date.parse(c.last_outbound_at) : NaN;
    if (!Number.isNaN(outAt) && outAt >= inboundAt) continue;

    const waitingH = (now.getTime() - inboundAt) / 3_600_000;
    if (waitingH < WARN_AFTER_H) continue;

    const severity: Severity = waitingH >= CRITICAL_AFTER_H ? "critical" : "warn";
    // Stored state, re-read in full this cycle: our information is current however long ago
    // the row was last edited. Anchoring freshness on the record's age discarded the
    // longest-neglected conditions — the ones that most need raising (R2S-P-F-004). The age
    // itself is still carried, as evidenceAt, which is what out-of-order protection compares.
    const freshness = STORED_STATE_FRESHNESS;

    const evidence: EvidenceRef[] = [
      {
        sourceTable: "wa_conversations",
        sourceId: c.id,
        // A waiting BAND. No customer identity, no message body, no phone number.
        facts: { waiting_band: waitingBand(waitingH), answered: false },
        origin: "detector",
      },
    ];

    out.push({
      companyId,
      department: "crm",
      observationSource: CRM_SOURCE,
      kind: "followup_due",
      subjectRef: { table: "wa_conversations", id: c.id },
      evidence,
      evidenceAt: c.last_inbound_at,
      detectedAt: now.toISOString(),
      facts: { waiting_band: waitingBand(waitingH), answered: false },
      summary: "Customer awaiting a reply",
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      identityKey: identityKeyFor({
        companyId,
        observationSource: CRM_SOURCE,
        subjectId: c.id,
        window: dayWindow(now),
      }),
      freshness,
      // `chase` here means "an internal person should respond" — never an automated send.
      suggestedActionCategory: "chase",
      // R1-D-7: anything customer-adjacent requires a human. Never `automatic`.
      authorityClass: severity === "critical" ? "manager_approval" : "policy_controlled",
      correlationId,
      // The 24-hour WhatsApp service window is a real, policy-derived deadline.
      businessDeadline: { at: new Date(inboundAt + 24 * 3_600_000).toISOString(), source: "policy" },
    });
  }

  return out;
}

function waitingBand(hours: number): string {
  if (hours >= 72) return "72h+";
  if (hours >= 24) return "24-72h";
  if (hours >= 8) return "8-24h";
  return "4-8h";
}
