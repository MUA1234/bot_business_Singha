/**
 * System health summary (Architecture V2 change plan §13 / OBSERVABILITY). Pure and
 * deterministic: turns raw operational counters into an overall level + the specific
 * issues to act on. Used by the admin Health dashboard. It reports — it fixes nothing.
 */
export interface HealthMetrics {
  failedEvents: number; // source_events in 'failed'
  deadLetters: number; // dead_letter_events unresolved
  outboxFailed: number; // message_outbox in 'failed'/'dead'
  unprocessedEvents: number; // source_events still 'received'/'processing'
}

export type HealthLevel = "ok" | "warn" | "critical";

export interface HealthSummary {
  level: HealthLevel;
  issues: string[];
}

/** Anything stuck in a failure state is critical; a backlog is a warning. */
export function systemHealth(m: HealthMetrics): HealthSummary {
  const issues: string[] = [];
  if (m.deadLetters > 0) issues.push(`${m.deadLetters} dead-letter event(s) need triage`);
  if (m.failedEvents > 0) issues.push(`${m.failedEvents} failed source event(s)`);
  if (m.outboxFailed > 0) issues.push(`${m.outboxFailed} outbound message(s) failed to send`);

  const critical = m.deadLetters > 0 || m.failedEvents > 0 || m.outboxFailed > 0;
  if (!critical && m.unprocessedEvents > 50) issues.push(`${m.unprocessedEvents} events awaiting processing (backlog)`);

  const level: HealthLevel = critical ? "critical" : m.unprocessedEvents > 50 ? "warn" : "ok";
  return { level, issues };
}
