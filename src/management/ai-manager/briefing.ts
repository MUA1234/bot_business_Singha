/**
 * Executive briefing generator (Architecture V2 change plan §6.2). Pure and
 * deterministic: turns the command-centre state into a short, ranked set of plain
 * sentences for the owner. It summarises verified numbers only — no model, no
 * speculation — and recommends attention, never actions.
 */
export interface BriefingInput {
  criticalCount: number;
  warnCount: number;
  currency: string;
  cash: string; // decimal string
  arOverdue: string; // decimal string
  apOverdue: string; // decimal string
  forecastGoesNegative?: boolean;
  forecastLowest?: { date: string; balance: string } | null;
}

const money = (currency: string, v: string) => `${currency} ${Number(v).toLocaleString()}`;

/** Ordered briefing lines (most important first). Always returns at least one line. */
export function buildBriefing(input: BriefingInput): string[] {
  const lines: string[] = [];

  if (input.criticalCount > 0) {
    lines.push(`⚠️ ${input.criticalCount} critical item${input.criticalCount === 1 ? "" : "s"} need attention now.`);
  }
  if (input.forecastGoesNegative && input.forecastLowest) {
    lines.push(`💸 Cash is projected to go negative — trough ${money(input.currency, input.forecastLowest.balance)} on ${input.forecastLowest.date}.`);
  }
  if (Number(input.arOverdue) > 0) {
    lines.push(`📥 ${money(input.currency, input.arOverdue)} in receivables is overdue — chase collections.`);
  }
  if (Number(input.apOverdue) > 0) {
    lines.push(`📤 ${money(input.currency, input.apOverdue)} in payables is overdue — schedule/approve payment.`);
  }
  lines.push(`🏦 Cash on hand: ${money(input.currency, input.cash)}.`);
  if (input.warnCount > 0) {
    lines.push(`🔎 ${input.warnCount} warning${input.warnCount === 1 ? "" : "s"} to review when convenient.`);
  }
  if (input.criticalCount === 0 && input.warnCount === 0 && !input.forecastGoesNegative) {
    lines.push("✅ No exceptions — operations are on track.");
  }
  return lines;
}
