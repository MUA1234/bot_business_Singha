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
  owner: string; // who is accountable for triaging this class of alert
  runbook: string; // where to look / what to do
  firstSeen?: string; // ISO — when this alert key was first observed (from a seen-map)
  lastSeen?: string; // ISO — when it was last observed
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Static owner + runbook per alert key (§WP E.6). */
const META: Record<string, { owner: string; runbook: string }> = {
  accounting_integrity: { owner: "finance-oncall", runbook: "docs/architecture-v2/RUNBOOKS.md#ledger-imbalance" },
  migration_mismatch: { owner: "platform-oncall", runbook: "docs/architecture-v2/MIGRATION_STATE.md" },
  dead_letters: { owner: "platform-oncall", runbook: "docs/architecture-v2/RUNBOOKS.md#dead-letters" },
  failed_events: { owner: "platform-oncall", runbook: "docs/architecture-v2/RUNBOOKS.md#failed-events" },
  outbox_failed: { owner: "platform-oncall", runbook: "docs/architecture-v2/RUNBOOKS.md#outbox" },
  ai_failures: { owner: "platform-oncall", runbook: "docs/architecture-v2/RUNBOOKS.md#ai-gateway" },
};
const meta = (key: string) => META[key] ?? { owner: "platform-oncall", runbook: "docs/architecture-v2/RUNBOOKS.md" };

export function buildAlerts(s: AlertSignals): Alert[] {
  const raw: Omit<Alert, "owner" | "runbook">[] = [];

  if (s.accountingIntegrityBreaches > 0)
    raw.push({ key: "accounting_integrity", severity: "critical", message: `${s.accountingIntegrityBreaches} accounting integrity exception(s) — ledger may be unbalanced` });
  if (s.migrationMismatch)
    raw.push({ key: "migration_mismatch", severity: "critical", message: "Database migration mismatch — code expects a migration that is not applied" });
  if (s.deadLetters > 0)
    raw.push({ key: "dead_letters", severity: "critical", message: `${s.deadLetters} dead-letter event(s) need triage/replay` });
  if (s.failedEvents > 0)
    raw.push({ key: "failed_events", severity: "warning", message: `${s.failedEvents} source event(s) failed processing` });
  if (s.outboxFailed > 0)
    raw.push({ key: "outbox_failed", severity: "warning", message: `${s.outboxFailed} outbound message(s) failed to send` });
  if (s.repeatedAiFailures > 0)
    raw.push({ key: "ai_failures", severity: "warning", message: `${s.repeatedAiFailures} repeated AI failure(s) — check the gateway/model access` });

  // Attach owner+runbook and rank most-severe first (stable within a severity).
  return raw
    .map((a) => ({ ...a, ...meta(a.key) }))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Stamp first/last-seen from a persisted seen-map (§WP E.6). `seen[key].firstSeen` is
 * preserved across observations; lastSeen is refreshed to `now`. Pure — the caller owns
 * persistence of the returned map.
 */
export function stampSeen(
  alerts: Alert[],
  seen: Record<string, { firstSeen: string }>,
  now: Date = new Date(),
): Alert[] {
  const nowIso = now.toISOString();
  return alerts.map((a) => ({ ...a, firstSeen: seen[a.key]?.firstSeen ?? nowIso, lastSeen: nowIso }));
}

/** Highest severity present, or null when there is nothing to report. */
export function topSeverity(alerts: Alert[]): AlertSeverity | null {
  return alerts.length ? alerts[0]!.severity : null;
}
