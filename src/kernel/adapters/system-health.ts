/**
 * System / provider health observation adapter (R1 checkpoint 3).
 *
 * WRAPS the existing, tested `src/lib/health-signals.ts` — `outboxAgeLevel`,
 * `ledgerIntegrityLevel`, `backlogLevel` and `worstLevel` are used as they are.
 *
 * SYSTEM-HEALTH FINDINGS MAY NEVER EXPOSE SECRETS. This is the adapter most likely to leak,
 * because diagnostics are exactly where credentials, connection strings and provider error
 * bodies accumulate. Three structural rules:
 *
 *   1. Only COUNTS, LEVELS and CONFIGURATION-KEY NAMES cross the boundary — never values.
 *      "OPENAI_API_KEY is missing" is a fact; its value is not, and is never read here.
 *   2. Provider error text is NEVER copied. A provider failure becomes a count and a level.
 *      Upstream error bodies routinely echo the request, including auth headers.
 *   3. `assertObservationSafe` independently rejects any fact key that looks sensitive, so a
 *      future edit that adds one fails the build rather than shipping.
 */
import {
  outboxAgeLevel,
  ledgerIntegrityLevel,
  worstLevel,
  type LedgerIntegrityCounts,
  type SignalLevel,
} from "@/lib/health-signals";
import type { EvidenceRef } from "../types";
import {
  dayWindow,
  freshnessFor,
  identityKeyFor,
  priorityFor,
  type Observation,
  type Severity,
} from "../observation";

export const SYSTEM_SOURCE = "system.health_degraded";

export interface SystemHealthInput {
  companyId: string;
  correlationId: string;
  now: Date;
  /** Age in minutes of the oldest undelivered outbox row; null when the queue is empty. */
  oldestPendingOutboxMinutes: number | null;
  /** Count of outbox rows in a failed state. */
  failedOutboxCount: number;
  /**
   * Ledger integrity probe counts, in the EXACT shape `ledgerIntegrityLevel` declares.
   * Mirroring the existing interface rather than inventing a near-miss of it is deliberate:
   * an earlier draft used `unbalancedJournals`/`orphanLines`, which typechecking rejected —
   * had the shape been `any`, the detector would have read `undefined` for every count and
   * silently reported the ledger healthy.
   */
  ledger: LedgerIntegrityCounts;
  /** Provider attempt counts. NO error bodies, by construction — this is a count. */
  providerFailures: number;
  /** Names ONLY of required configuration keys that are absent. Never values. */
  missingConfigKeys: string[];
  /** When these signals were sampled. */
  sampledAt: string;
}

const SEVERITY: Record<SignalLevel, Severity> = { ok: "info", warn: "warn", crit: "critical" };

export function detectSystemHealthObservations(input: SystemHealthInput): Observation[] {
  const { companyId, correlationId, now } = input;

  const outboxLevel = outboxAgeLevel(input.oldestPendingOutboxMinutes);
  const ledger = ledgerIntegrityLevel(input.ledger);
  const providerLevel: SignalLevel = input.providerFailures >= 10 ? "crit" : input.providerFailures > 0 ? "warn" : "ok";
  const configLevel: SignalLevel = input.missingConfigKeys.length > 0 ? "warn" : "ok";
  const failedLevel: SignalLevel = input.failedOutboxCount >= 5 ? "crit" : input.failedOutboxCount > 0 ? "warn" : "ok";

  const level = worstLevel([outboxLevel, ledger.level, providerLevel, configLevel, failedLevel]);

  // Healthy is not an observation. The kernel is exception-led; "everything is fine" is the
  // absence of work, not a queue entry.
  if (level === "ok") return [];

  const severity = SEVERITY[level];
  const freshness = freshnessFor(input.sampledAt, now);

  const facts = {
    level,
    outbox_level: outboxLevel,
    failed_outbox_count: input.failedOutboxCount,
    ledger_level: ledger.level,
    ledger_issue_count: ledger.issues.length,
    provider_failure_count: input.providerFailures,
    // KEY NAMES only. Values are never read by this module.
    missing_config_keys: [...input.missingConfigKeys].sort(),
  };

  const evidence: EvidenceRef[] = [
    {
      sourceTable: "message_outbox",
      sourceId: `health:${dayWindow(now)}`,
      facts: { outbox_level: outboxLevel, failed_outbox_count: input.failedOutboxCount },
      origin: "detector",
    },
  ];
  if (ledger.level !== "ok") {
    evidence.push({
      sourceTable: "ledger_integrity_report",
      sourceId: `health:${dayWindow(now)}`,
      facts: { ledger_level: ledger.level, ledger_issue_count: ledger.issues.length },
      origin: "detector",
    });
  }
  if (input.providerFailures > 0) {
    evidence.push({
      sourceTable: "ai_model_attempts",
      sourceId: `health:${dayWindow(now)}`,
      // A COUNT. Never the provider's error body.
      facts: { provider_failure_count: input.providerFailures },
      origin: "detector",
    });
  }

  return [
    {
      companyId,
      department: "system",
      observationSource: SYSTEM_SOURCE,
      kind: "health_degraded",
      subjectRef: { table: "system_health", id: `${companyId}:${dayWindow(now)}` },
      evidence,
      evidenceAt: input.sampledAt,
      detectedAt: now.toISOString(),
      facts,
      summary: level === "crit" ? "System health critical" : "System health degraded",
      severity,
      priority: priorityFor(severity, freshness),
      confidence: 1,
      identityKey: identityKeyFor({
        companyId,
        observationSource: SYSTEM_SOURCE,
        subjectId: "system",
        window: dayWindow(now),
      }),
      freshness,
      suggestedActionCategory: "investigate",
      // Investigating system health internally is ordinary operational work; acting on the
      // finding (re-configuring a provider, for instance) re-enters the authority ladder.
      authorityClass: level === "crit" ? "manager_approval" : "automatic",
      correlationId,
      businessDeadline: null,
    },
  ];
}
