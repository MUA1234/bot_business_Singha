/**
 * CTL-004 — Explainable business-health score.
 *
 * A composite 0–100 health indicator whose components and weights are inspectable.
 * The score is deterministic and uses exact-decimal helpers for monetary inputs.
 */
import { dec, decGtZero } from "@/lib/money";

export interface HealthScoreInput {
  currency: string;
  cashTotal: string;
  arOverdue: string;
  apOverdue: string;
  openTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  openRisks: number;
  openIncidents: number;
  openObligations: number;
  overloadedPeople: number;
  totalPeople: number;
  forecastGoesNegative: boolean;
}

export interface HealthScoreComponent {
  name: string;
  weight: number;
  raw: string;
  score: number;
  contribution: number;
}

export interface HealthScoreResult {
  score: number;
  status: "ok" | "warn" | "critical";
  components: HealthScoreComponent[];
  issues: string[];
  weights: Readonly<Record<string, number>>;
}

const WEIGHTS = {
  cash: 0.15,
  ar: 0.10,
  ap: 0.10,
  tasks: 0.15,
  capacity: 0.10,
  risks: 0.10,
  incidents: 0.10,
  obligations: 0.10,
  forecast: 0.10,
} as const;

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function cashScore(cashTotal: string): number {
  const amount = dec(cashTotal);
  if (amount.isNegative()) return 0;
  if (amount.isZero()) return 40;
  // Score rises quickly to a practical ceiling so any positive cash is healthy-ish.
  return clamp(60 + 40 * Math.min(1, amount.div(1_000_000).toNumber()));
}

function arScore(arOverdue: string): number {
  return decGtZero(arOverdue) ? clamp(100 - dec(arOverdue).div(500_000).toNumber() * 25) : 85;
}

function apScore(apOverdue: string): number {
  return decGtZero(apOverdue) ? clamp(100 - dec(apOverdue).div(500_000).toNumber() * 25) : 85;
}

function taskScore(open: number, overdue: number, blocked: number): number {
  let penalty = overdue * 12 + blocked * 10 + Math.max(0, open - overdue - blocked) * 2;
  return clamp(100 - penalty);
}

function capacityScore(overloaded: number, total: number): number {
  if (total === 0) return 70; // unknown capacity is slightly cautious
  const ratio = overloaded / total;
  return clamp(100 - ratio * 80);
}

function riskScore(openRisks: number): number {
  return clamp(100 - openRisks * 12);
}

function incidentScore(openIncidents: number): number {
  return clamp(100 - openIncidents * 25);
}

function obligationScore(openObligations: number): number {
  return clamp(100 - openObligations * 15);
}

function forecastScore(goesNegative: boolean): number {
  return goesNegative ? 30 : 90;
}

function overallStatus(score: number): HealthScoreResult["status"] {
  if (score < 40) return "critical";
  if (score < 70) return "warn";
  return "ok";
}

/**
 * Compute the explainable health score for a company.
 */
export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  const componentScores = {
    cash: cashScore(input.cashTotal),
    ar: arScore(input.arOverdue),
    ap: apScore(input.apOverdue),
    tasks: taskScore(input.openTasks, input.overdueTasks, input.blockedTasks),
    capacity: capacityScore(input.overloadedPeople, input.totalPeople),
    risks: riskScore(input.openRisks),
    incidents: incidentScore(input.openIncidents),
    obligations: obligationScore(input.openObligations),
    forecast: forecastScore(input.forecastGoesNegative),
  };

  const components: HealthScoreComponent[] = [
    { name: "Cash on hand", weight: WEIGHTS.cash, raw: `${input.currency} ${input.cashTotal}`, score: componentScores.cash, contribution: componentScores.cash * WEIGHTS.cash },
    { name: "Overdue receivables", weight: WEIGHTS.ar, raw: `${input.currency} ${input.arOverdue}`, score: componentScores.ar, contribution: componentScores.ar * WEIGHTS.ar },
    { name: "Overdue payables", weight: WEIGHTS.ap, raw: `${input.currency} ${input.apOverdue}`, score: componentScores.ap, contribution: componentScores.ap * WEIGHTS.ap },
    { name: "Task health", weight: WEIGHTS.tasks, raw: `${input.openTasks} open / ${input.overdueTasks} overdue / ${input.blockedTasks} blocked`, score: componentScores.tasks, contribution: componentScores.tasks * WEIGHTS.tasks },
    { name: "Capacity pressure", weight: WEIGHTS.capacity, raw: `${input.overloadedPeople} of ${input.totalPeople} overloaded`, score: componentScores.capacity, contribution: componentScores.capacity * WEIGHTS.capacity },
    { name: "Open risks", weight: WEIGHTS.risks, raw: `${input.openRisks}`, score: componentScores.risks, contribution: componentScores.risks * WEIGHTS.risks },
    { name: "Open incidents", weight: WEIGHTS.incidents, raw: `${input.openIncidents}`, score: componentScores.incidents, contribution: componentScores.incidents * WEIGHTS.incidents },
    { name: "Open obligations", weight: WEIGHTS.obligations, raw: `${input.openObligations}`, score: componentScores.obligations, contribution: componentScores.obligations * WEIGHTS.obligations },
    { name: "Cash forecast", weight: WEIGHTS.forecast, raw: input.forecastGoesNegative ? "projection goes negative" : "projection stays positive", score: componentScores.forecast, contribution: componentScores.forecast * WEIGHTS.forecast },
  ];

  const score = clamp(components.reduce((s, c) => s + c.contribution, 0));
  const issues: string[] = [];
  if (componentScores.cash < 60) issues.push("cash is low or negative");
  if (componentScores.ar < 60) issues.push("overdue receivables");
  if (componentScores.ap < 60) issues.push("overdue payables");
  if (componentScores.tasks < 60) issues.push("task pressure");
  if (componentScores.capacity < 60) issues.push("capacity pressure");
  if (componentScores.risks < 60) issues.push("open risks");
  if (componentScores.incidents < 60) issues.push("open incidents");
  if (componentScores.obligations < 60) issues.push("open obligations");
  if (componentScores.forecast < 60) issues.push("forecast goes negative");

  return {
    score,
    status: overallStatus(score),
    components,
    issues: issues.length > 0 ? issues : ["healthy profile"],
    weights: WEIGHTS,
  };
}

/** Inspectable weights so the score can be argued with. */
export function healthScoreWeights(): Readonly<typeof WEIGHTS> {
  return WEIGHTS;
}

export function healthScoreStatusTone(status: HealthScoreResult["status"]): string {
  if (status === "critical") return "danger";
  if (status === "warn") return "warn";
  return "ok";
}
