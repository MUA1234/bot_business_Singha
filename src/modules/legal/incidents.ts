/**
 * RSK-005 — Incident log helpers.
 * Pure deterministic status / severity helpers for the incident register.
 */

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "investigating" | "resolved" | "closed";

const SEVERITY_ORDER: Record<IncidentSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function isOpenIncident(status: IncidentStatus): boolean {
  return status === "open" || status === "investigating";
}

export function severityBadgeClass(severity: IncidentSeverity): string {
  switch (severity) {
    case "critical":
      return "danger";
    case "high":
      return "warn";
    case "medium":
      return "info";
    case "low":
      return "";
  }
}

export function sortIncidentsBySeverity<T extends { severity: IncidentSeverity; occurred_at: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
  });
}
