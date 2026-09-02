/**
 * External consultants and service providers observation adapter (R2A).
 *
 * WRAPS the existing, tested `providerHealth` (src/modules/crm/service-provider.ts), which
 * classifies a provider as verified / warning / blocked from status, compliance, insurance
 * status and insurance expiry. That classification is not reimplemented here.
 *
 * WHAT IT CANNOT SEE. CRM-004 — counterparty performance and reliability history — is
 * `absent` in the register. There is no delivery-performance record to read, so this adapter
 * detects COMPLIANCE health only. It does not, and must not, imply anything about whether a
 * provider does good work. That gap is named in the R2A coverage matrix rather than proxied
 * by something like invoice volume, which would be a fabricated performance judgement about
 * an external party.
 *
 * Engaging or standing down a provider is an EXTERNAL COMMITMENT and always human (D-9), so
 * the authority class is never `automatic` and the action is only ever an internal review.
 */
import { providerHealth, type ProviderHealth } from "@/modules/crm/service-provider";
import type { EvidenceRef } from "../types";
import {
  dayWindow, freshnessFor, identityKeyFor, priorityFor,
  type Observation, type Severity,
} from "../observation";

export const PROVIDERS_SOURCE = "providers.provider_at_risk";

export interface ServiceProviderRow {
  id: string;
  status: string;
  compliance_status: string;
  insurance_status: string;
  insurance_expiry: string | null;
  updated_at?: string | null;
}

/** A provider already stood down needs no management attention. */
const RESOLVED = new Set(["archived", "terminated", "inactive"]);

const SEVERITY: Partial<Record<ProviderHealth, Severity>> = {
  blocked: "critical",
  warning: "warn",
};

export interface ProvidersScanInput {
  companyId: string;
  correlationId: string;
  now: Date;
  providers: ServiceProviderRow[];
}

export function detectProviderObservations(input: ProvidersScanInput): Observation[] {
  const { companyId, correlationId, now } = input;
  const out: Observation[] = [];

  for (const p of input.providers) {
    if (p.status && RESOLVED.has(p.status.toLowerCase())) continue;

    const health = providerHealth(
      {
        status: p.status,
        compliance_status: p.compliance_status,
        insurance_status: p.insurance_status,
        insurance_expiry: p.insurance_expiry,
      },
      now,
    );

    const severity = SEVERITY[health];
    if (!severity) continue; // verified — nothing needs attention

    const freshness = freshnessFor(p.updated_at ?? p.insurance_expiry, now);

    // Classification and the two status flags only. NOT the provider's name, its pricing, its
    // capacity notes or its capabilities — all commercially sensitive, and all one row
    // reference away for anyone authorised to open it.
    const facts = {
      provider_health: health,
      compliance_status: p.compliance_status,
      insurance_status: p.insurance_status,
    };

    const evidence: EvidenceRef[] = [
      { sourceTable: "service_providers", sourceId: p.id, facts, origin: "detector" },
    ];

    out.push({
      companyId,
      department: "providers",
      observationSource: PROVIDERS_SOURCE,
      kind: "provider_at_risk",
      subjectRef: { table: "service_providers", id: p.id },
      evidence,
      evidenceAt: p.updated_at ?? p.insurance_expiry ?? now.toISOString(),
      detectedAt: now.toISOString(),
      facts,
      summary: health === "blocked" ? "Service provider blocked" : "Service provider compliance at risk",
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      identityKey: identityKeyFor({
        companyId, observationSource: PROVIDERS_SOURCE, subjectId: p.id, window: dayWindow(now),
      }),
      freshness,
      suggestedActionCategory: "review",
      // Engaging or standing down an external party is always human.
      authorityClass: "manager_approval",
      correlationId,
      // Insurance expiry is a real, recorded deadline when present.
      businessDeadline: p.insurance_expiry ? { at: p.insurance_expiry, source: "evidence" } : null,
    });
  }

  return out;
}
