/**
 * Additional health-signal classifiers (WP E). Pure — thresholds only, no I/O — so they
 * are deterministic and unit-tested. The /api/health route feeds live metric values in.
 * Every level distinguishes a real "ok" from "unavailable" upstream (see @/lib/metric).
 */
export type SignalLevel = "ok" | "warn" | "crit";

/** Which mandatory config keys are absent. */
export function missingConfig(present: Record<string, boolean>, required: string[]): string[] {
  return required.filter((k) => !present[k]);
}

/** Oldest pending outbox age (minutes) → level. null = empty queue (ok). */
export function outboxAgeLevel(oldestPendingMinutes: number | null): SignalLevel {
  if (oldestPendingMinutes === null) return "ok";
  if (oldestPendingMinutes > 60) return "crit";
  if (oldestPendingMinutes > 15) return "warn";
  return "ok";
}

export interface LedgerIntegrityCounts {
  imbalancedJournals: number;
  headerLineMismatch: number;
  orphanedLines: number;
  lockedPeriodPostings: number;
}

/** Any ledger integrity breach is critical (financial correctness). */
export function ledgerIntegrityLevel(c: LedgerIntegrityCounts): { level: SignalLevel; issues: string[] } {
  const issues: string[] = [];
  if (c.imbalancedJournals > 0) issues.push(`${c.imbalancedJournals} journal(s) with unbalanced lines`);
  if (c.headerLineMismatch > 0) issues.push(`${c.headerLineMismatch} journal(s) whose header ≠ line totals`);
  if (c.orphanedLines > 0) issues.push(`${c.orphanedLines} orphaned/cross-company journal line(s)`);
  if (c.lockedPeriodPostings > 0) issues.push(`${c.lockedPeriodPostings} posting(s) in a locked/closed period`);
  return { level: issues.length ? "crit" : "ok", issues };
}

/** Operational backlog → level (warn >20, crit >100 on the worst of the three). */
export function backlogLevel(x: { overdueTasks: number; followUpBacklog: number; unanalysedConversations: number }): SignalLevel {
  const worst = Math.max(x.overdueTasks, x.followUpBacklog, x.unanalysedConversations);
  if (worst > 100) return "crit";
  if (worst > 20) return "warn";
  return "ok";
}

/**
 * Inbound messages that could not be attributed to ANY company (FOUND-003).
 *
 * These are the one class of inbound failure with no company-scoped queue to land in: with no
 * company, there is nothing to scope a review row to. They are persisted and counted, and this is
 * where they become visible. ANY of them means real traffic is arriving at a number nobody has
 * mapped — a configuration gap, not a message defect.
 */
export function unattributedInboundLevel(count: number | null): SignalLevel {
  if (count === null) return "warn"; // unavailable is never "all clear"
  if (count > 20) return "crit";
  if (count > 0) return "warn";
  return "ok";
}

/** Combine several signal levels into the single worst level. */
export function worstLevel(levels: SignalLevel[]): SignalLevel {
  if (levels.includes("crit")) return "crit";
  if (levels.includes("warn")) return "warn";
  return "ok";
}
