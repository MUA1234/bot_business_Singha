/**
 * Daily monitoring digest (Architecture V2 change plan §13 — scheduled monitoring).
 * Pure and deterministic: turns per-company counters into a short digest line for the
 * owner, or null when there's nothing worth pinging about. Reporting only — the cron
 * that uses this creates notifications; it never executes any business action.
 */
export interface DigestMetrics {
  overdueTasks: number;
  expiringSoon: number; // licences / vehicle docs / contract renewals due soon
  overdueObligations: number;
  overloadedStaff: number;
}

/** A one-line digest, or null when everything is quiet. */
export function buildDigestBody(m: DigestMetrics): string | null {
  const parts: string[] = [];
  if (m.overdueTasks > 0) parts.push(`${m.overdueTasks} overdue task${m.overdueTasks === 1 ? "" : "s"}`);
  if (m.overdueObligations > 0) parts.push(`${m.overdueObligations} overdue obligation${m.overdueObligations === 1 ? "" : "s"}`);
  if (m.expiringSoon > 0) parts.push(`${m.expiringSoon} renewal${m.expiringSoon === 1 ? "" : "s"} due soon`);
  if (m.overloadedStaff > 0) parts.push(`${m.overloadedStaff} overloaded staff`);
  if (parts.length === 0) return null;
  return `Daily digest — ${parts.join("; ")}.`;
}
