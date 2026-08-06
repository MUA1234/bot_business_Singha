/**
 * Actionable alerts (NEXT_PHASE_DEVELOPER_BRIEF §WP6.5). Pure and deterministic:
 * turns raw operational signals into a ranked, actionable alert list so critical
 * failures create an alert rather than disappearing into logs. It reports — the
 * caller decides how to notify (in-app, email, etc.).
 */
export interface AlertSignals {
  failedEvents: number;
  deadLetters: number;
  outboxFailed: number;
  repeatedAiFailures: number; // AI runs failing repeatedly
  accountingIntegrityBreaches: number; // e.g. unbalanced journal detected
  migrationMismatch: boolean; // code expects a migration not applied
}

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  key: string;
  severity: AlertSeverity;
  message: string;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function buildAlerts(s: AlertSignals): Alert[] {
  const alerts: Alert[] = [];

  if (s.accountingIntegrityBreaches > 0)
    alerts.push({ key: "accounting_integrity", severity: "critical", message: `${s.accountingIntegrityBreaches} accounting integrity exception(s) — ledger may be unbalanced` });
  if (s.migrationMismatch)
    alerts.push({ key: "migration_mismatch", severity: "critical", message: "Database migration mismatch — code expects a migration that is not applied" });
  if (s.deadLetters > 0)
    alerts.push({ key: "dead_letters", severity: "critical", message: `${s.deadLetters} dead-letter event(s) need triage/replay` });
  if (s.failedEvents > 0)
    alerts.push({ key: "failed_events", severity: "warning", message: `${s.failedEvents} source event(s) failed processing` });
  if (s.outboxFailed > 0)
    alerts.push({ key: "outbox_failed", severity: "warning", message: `${s.outboxFailed} outbound message(s) failed to send` });
  if (s.repeatedAiFailures > 0)
    alerts.push({ key: "ai_failures", severity: "warning", message: `${s.repeatedAiFailures} repeated AI failure(s) — check the gateway/model access` });

  // Ranked most-severe first; stable within a severity by insertion order.
  return alerts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Highest severity present, or null when there is nothing to report. */
export function topSeverity(alerts: Alert[]): AlertSeverity | null {
  return alerts.length ? alerts[0]!.severity : null;
}
