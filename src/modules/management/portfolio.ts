/**
 * CTL-002 — Cross-company portfolio overview.
 *
 * Pure, deterministic aggregation of per-company health signals so an owner with
 * multiple companies can see them together without breaching isolation. The page
 * only ever queries companies the current user has an active membership in.
 *
 * Hours are ordinary numbers; money uses exact-decimal strings via @/lib/money.
 */
import { computeCashPosition, type CashAccount, type CashMovement } from "@/modules/finance/cash-position";
import { ageItems, type AgingItem, type AgingResult } from "@/modules/finance/aging";
import { dec, decGtZero, decSub, fmtMoney } from "@/lib/money";

export interface PortfolioCompanyInput {
  companyId: string;
  name: string;
  currency: string;
  projects: { status: string }[];
  tasks: { status: string; due_date: string | null }[];
  risks: { status: string }[];
  incidents: { status: string }[];
  obligations: { status: string }[];
  cashAccounts: CashAccount[];
  payments: CashMovement[];
  invoices: AgingItem[];
  bills: AgingItem[];
  capacitySnapshots: { status: string }[];
}

export interface PortfolioCompanySummary {
  companyId: string;
  name: string;
  currency: string;
  projectCount: number;
  activeProjectCount: number;
  openTasks: number;
  overdueTasks: number;
  overloadedPeople: number;
  openRisks: number;
  openIncidents: number;
  openObligations: number;
  cashOnHand: string;
  arOverdue: string;
  apOverdue: string;
  issues: PortfolioIssue[];
  status: "critical" | "warn" | "ok";
}

export interface PortfolioIssue {
  type: string;
  severity: PortfolioCompanySummary["status"];
  message: string;
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "cancelled"]);
const ACTIVE_PROJECT_STATUSES = new Set(["active"]);

function countOpenTasks(tasks: PortfolioCompanyInput["tasks"]): number {
  return tasks.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status)).length;
}

function countOverdueTasks(tasks: PortfolioCompanyInput["tasks"], today: string): number {
  return tasks.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status) && t.due_date && t.due_date < today).length;
}

function countOverloaded(snapshots: PortfolioCompanyInput["capacitySnapshots"]): number {
  return snapshots.filter((s) => s.status === "overloaded").length;
}

function countOpen(rows: { status: string }[]): number {
  return rows.filter((r) => r.status === "open").length;
}

/** Summarize one company from the inputs. */
export function summarizeCompanyPortfolio(
  input: PortfolioCompanyInput,
  today: string = new Date().toISOString().slice(0, 10),
): PortfolioCompanySummary {
  const cash = computeCashPosition(input.cashAccounts, input.payments);
  const cashOnHand = cash.totalsByCurrency[input.currency] ?? "0";

  const ar = ageItems(input.invoices, input.currency, new Date(today + "T00:00:00Z"));
  const ap = ageItems(input.bills, input.currency, new Date(today + "T00:00:00Z"));

  const issues: PortfolioIssue[] = [];
  if (decGtZero(ar.overdue)) {
    issues.push({ type: "ar_overdue", severity: "critical", message: `Overdue receivables ${fmtMoney(ar.overdue, input.currency)}` });
  }
  if (decGtZero(ap.overdue)) {
    issues.push({ type: "ap_overdue", severity: "warn", message: `Overdue payables ${fmtMoney(ap.overdue, input.currency)}` });
  }
  if (countOverdueTasks(input.tasks, today) > 0) {
    issues.push({ type: "overdue_tasks", severity: "warn", message: `${countOverdueTasks(input.tasks, today)} overdue task(s)` });
  }
  if (countOverloaded(input.capacitySnapshots) > 0) {
    issues.push({ type: "overloaded", severity: "warn", message: `${countOverloaded(input.capacitySnapshots)} overloaded person(s)` });
  }
  if (countOpen(input.risks) > 0) {
    issues.push({ type: "open_risks", severity: countOpen(input.risks) >= 3 ? "critical" : "warn", message: `${countOpen(input.risks)} open risk(s)` });
  }
  if (countOpen(input.incidents) > 0) {
    issues.push({ type: "open_incidents", severity: "critical", message: `${countOpen(input.incidents)} open incident(s)` });
  }

  let status: PortfolioCompanySummary["status"] = "ok";
  if (issues.some((i) => i.severity === "critical")) status = "critical";
  else if (issues.some((i) => i.severity === "warn")) status = "warn";

  return {
    companyId: input.companyId,
    name: input.name,
    currency: input.currency,
    projectCount: input.projects.length,
    activeProjectCount: input.projects.filter((p) => ACTIVE_PROJECT_STATUSES.has(p.status)).length,
    openTasks: countOpenTasks(input.tasks),
    overdueTasks: countOverdueTasks(input.tasks, today),
    overloadedPeople: countOverloaded(input.capacitySnapshots),
    openRisks: countOpen(input.risks),
    openIncidents: countOpen(input.incidents),
    openObligations: countOpen(input.obligations),
    cashOnHand,
    arOverdue: ar.overdue,
    apOverdue: ap.overdue,
    issues,
    status,
  };
}

/** Rank companies so the ones needing attention appear first. */
export function rankPortfolioByUrgency(summaries: PortfolioCompanySummary[]): PortfolioCompanySummary[] {
  const severityOrder = { critical: 0, warn: 1, ok: 2 };
  return [...summaries].sort((a, b) => {
    const statusCmp = severityOrder[a.status] - severityOrder[b.status];
    if (statusCmp !== 0) return statusCmp;
    return dec(b.arOverdue).comparedTo(dec(a.arOverdue));
  });
}
