/**
 * Marketing observation adapter (R2A).
 *
 * DELIBERATELY NARROW. The only condition this adapter can honestly detect is a campaign
 * left STALLED — non-terminal, with no audience attached or nothing sent. It cannot judge
 * whether a campaign is performing, because **attribution does not exist**: no table links a
 * campaign to resulting revenue. That gap is recorded in the R2A coverage matrix rather than
 * approximated with a proxy metric, which would be a fabricated judgement about spend.
 *
 * R2A ADDS NO SEND PATH AND NO CAMPAIGN EXECUTION. This module imports no outbox, no
 * template and no provider; its only output is an internal review, and its authority class is
 * never `automatic`, so nothing marketing-related can reach the unattended lane.
 */
import type { EvidenceRef } from "../types";
import {
  dayWindow, freshnessFor, identityKeyFor, priorityFor,
  type Observation, type Severity,
} from "../observation";

export const MARKETING_SOURCE = "marketing.campaign_stalled";

export interface CampaignRow {
  id: string;
  status: string | null;
  audience_id: string | null;
  sent_count: number | null;
  created_at: string | null;
}

/** A campaign in one of these states is finished and must not reappear as new work. */
const RESOLVED = new Set(["completed", "sent", "cancelled", "archived", "closed"]);

/** A campaign only counts as stalled once it has had a reasonable chance to start. */
const STALLED_AFTER_DAYS = 7;

export interface MarketingScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  campaigns: CampaignRow[];
}

export function detectMarketingObservations(input: MarketingScanInput): Observation[] {
  const { companyId, correlationId, now } = input;
  const out: Observation[] = [];

  for (const c of input.campaigns) {
    if (c.status && RESOLVED.has(c.status.toLowerCase())) continue;
    if (!c.created_at) continue;

    const createdAt = Date.parse(c.created_at);
    if (Number.isNaN(createdAt)) continue;

    const ageDays = (now.getTime() - createdAt) / 86_400_000;
    if (ageDays < STALLED_AFTER_DAYS) continue;

    const noAudience = !c.audience_id;
    const nothingSent = Number(c.sent_count ?? 0) === 0;
    if (!noAudience && !nothingSent) continue;

    // No audience at all is the worse of the two: the campaign cannot run.
    const severity: Severity = noAudience ? "warn" : "info";
    // DEFECT R2S-F-006, and here it was self-defeating: a campaign is STALLED precisely BECAUSE
    // it is old, and `created_at` was then used as the evidence-freshness anchor — so every
    // campaign that qualified as stalled was immediately classified as stale evidence and
    // skipped. The condition and the reason for discarding it were the same fact.
    //
    // `campaigns` has no update timestamp, so freshness is honestly unknown. The AGE still
    // drives the condition; it just no longer disqualifies it.
    const freshness = freshnessFor(null, now);

    const facts = {
      campaign_status: c.status ?? "unknown",
      has_audience: !noAudience,
      nothing_sent: nothingSent,
      age_band: ageDays >= 30 ? "30d+" : ageDays >= 14 ? "14-30d" : "7-14d",
    };

    const evidence: EvidenceRef[] = [
      { sourceTable: "campaigns", sourceId: c.id, facts, origin: "detector" },
    ];

    out.push({
      companyId,
      department: "marketing",
      observationSource: MARKETING_SOURCE,
      kind: "campaign_stalled",
      subjectRef: { table: "campaigns", id: c.id },
      evidence,
      evidenceAt: c.created_at,
      detectedAt: now.toISOString(),
      facts,
      summary: noAudience ? "Campaign has no audience" : "Campaign has sent nothing",
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      identityKey: identityKeyFor({
        companyId, observationSource: MARKETING_SOURCE, subjectId: c.id, window: dayWindow(now),
      }),
      freshness,
      // INTERNAL REVIEW ONLY. Never a send, never a launch.
      suggestedActionCategory: "review",
      // Marketing touches customers, so it can never run unattended.
      authorityClass: "manager_approval",
      correlationId,
      // A campaign carries no recorded business deadline, and inventing one is forbidden.
      businessDeadline: null,
    });
  }

  return out;
}
