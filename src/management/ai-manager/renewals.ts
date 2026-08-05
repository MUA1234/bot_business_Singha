/**
 * Renewal / expiry detector (Architecture V2 change plan §9.3 legal licences &
 * obligations, §9.4 vehicle documents & maintenance). Pure and deterministic: given
 * dated items, it flags what is expired or coming due so the command centre and each
 * department can act before a deadline is missed. It changes nothing.
 */
export type RenewalStatus = "expired" | "due_soon" | "upcoming" | "none";
export type Severity = "critical" | "warn" | "info";

export interface RenewalItem {
  id: string;
  label: string;
  dueDate: string | null; // ISO date (expiry / renewal / next-service)
  kind?: string;
}

export interface RenewalAlert {
  id: string;
  label: string;
  kind?: string;
  status: RenewalStatus;
  severity: Severity;
  dueDate: string | null;
  daysUntil: number | null; // negative = overdue
}

const DAY = 86_400_000;

export function renewalStatus(dueDate: string | null, now: Date, soonDays = 30): RenewalStatus {
  if (!dueDate) return "none";
  const due = new Date(dueDate).getTime();
  if (!Number.isFinite(due)) return "none";
  const days = Math.floor((due - now.getTime()) / DAY);
  if (days < 0) return "expired";
  if (days <= soonDays) return "due_soon";
  return "upcoming";
}

const SEVERITY: Record<RenewalStatus, Severity> = {
  expired: "critical",
  due_soon: "warn",
  upcoming: "info",
  none: "info",
};

/** Alerts for items that are expired or due within `soonDays`, worst-first. */
export function detectRenewals(items: RenewalItem[], now: Date, soonDays = 30): RenewalAlert[] {
  const order: Record<RenewalStatus, number> = { expired: 0, due_soon: 1, upcoming: 2, none: 3 };
  return items
    .map((it): RenewalAlert => {
      const status = renewalStatus(it.dueDate, now, soonDays);
      const due = it.dueDate ? new Date(it.dueDate).getTime() : null;
      const daysUntil = due && Number.isFinite(due) ? Math.floor((due - now.getTime()) / DAY) : null;
      return { id: it.id, label: it.label, kind: it.kind, status, severity: SEVERITY[status], dueDate: it.dueDate, daysUntil };
    })
    .filter((a) => a.status === "expired" || a.status === "due_soon")
    .sort((a, b) => order[a.status] - order[b.status] || (a.daysUntil ?? 0) - (b.daysUntil ?? 0));
}
