/**
 * Lead scoring / qualification (Architecture V2 change plan §9.1). Pure and
 * deterministic: turns a lead's stage, value and recency into a 0–100 score and a
 * hot/warm/cold grade so sales (and the AI manager) can prioritise follow-up. It
 * ranks attention only — it never contacts anyone or changes a record.
 */
export type LeadStage = "new" | "contacted" | "qualified" | "proposal" | "won" | "lost";

export interface LeadInput {
  stage: LeadStage;
  estimatedValue: number; // in company base currency (ranking only, not ledger money)
  lastContactDaysAgo: number | null; // null = never contacted
}

export type LeadGrade = "hot" | "warm" | "cold";

export interface LeadScore {
  score: number; // 0..100
  grade: LeadGrade;
}

const STAGE_WEIGHT: Record<LeadStage, number> = {
  new: 10,
  contacted: 25,
  qualified: 45,
  proposal: 65,
  won: 0, // closed — no longer a pipeline priority
  lost: 0,
};

export function scoreLead(lead: LeadInput): LeadScore {
  if (lead.stage === "won" || lead.stage === "lost") return { score: 0, grade: "cold" };

  let score = STAGE_WEIGHT[lead.stage] ?? 0;

  // Value contribution (bounded): up to +25 for larger deals.
  const v = Math.max(lead.estimatedValue, 0);
  score += Math.min(25, v / 100_000); // 1 point per 100k, capped at 25

  // Recency: fresh contact adds urgency; stale contact decays.
  const days = lead.lastContactDaysAgo;
  if (days === null) score += 5; // uncontacted new lead — worth a touch
  else if (days <= 3) score += 15;
  else if (days <= 14) score += 8;
  else if (days > 45) score -= 10; // going cold

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade: LeadGrade = score >= 60 ? "hot" : score >= 30 ? "warm" : "cold";
  return { score, grade };
}
