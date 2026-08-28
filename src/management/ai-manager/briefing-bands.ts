/**
 * Banded executive briefing.
 *
 * The same verified figures `buildBriefing` reports as sentences, grouped by
 * WHAT THE READER MUST DO — act now, decide today, watch, opportunities, no
 * action required — and each carrying the route to the screen whose records
 * prove it.
 *
 * Pure and deterministic, exactly like `buildBriefing`: it summarises numbers
 * that were read from the database. There is no model here, no speculation and
 * no recommendation to take an action; a band says how urgently a human should
 * LOOK, never what they should decide.
 *
 * `buildBriefing` is unchanged and still available — this adds structure, it
 * does not replace the sentence form.
 */
import { decGtZero, fmtMoney } from "@/lib/money";
import type { BriefingInput } from "./briefing";

export type BriefBand = "act" | "decide" | "watch" | "opportunity" | "clear";

export interface BandedBriefItem {
  id: string;
  band: BriefBand;
  title: string;
  detail?: string;
  href?: string;
  /**
   * Where the conclusion came from. Every item below is `system`: each is a
   * deterministic consequence of rows in the database. An AI-derived line would
   * be marked `ai` and rendered with the dashed provenance rule, so a reader can
   * never mistake advice for state.
   */
  provenance: "system" | "ai";
}

const money = (currency: string, v: string) => fmtMoney(v, currency);

/**
 * @param degraded when a data source failed to load. A degraded read cannot
 * distinguish "nothing is wrong" from "we could not see what is wrong", so the
 * all-clear line is suppressed and replaced by an explicit warning.
 */
export function buildBandedBriefing(
  input: BriefingInput,
  degraded = false,
): BandedBriefItem[] {
  const items: BandedBriefItem[] = [];

  if (degraded) {
    items.push({
      id: "degraded",
      band: "act",
      title: "One or more data sources failed to load",
      detail:
        "Figures on this screen are incomplete. This is a system problem, not a clean bill of health — no all-clear can be given until the sources recover.",
      href: "/app/command/health",
      provenance: "system",
    });
  }

  if (input.criticalCount > 0) {
    items.push({
      id: "critical",
      band: "act",
      title: `${input.criticalCount} critical item${input.criticalCount === 1 ? "" : "s"} need attention now`,
      detail: "Listed in full below, most severe first.",
      provenance: "system",
    });
  }

  if (input.forecastGoesNegative && input.forecastLowest) {
    items.push({
      id: "cash-negative",
      band: "act",
      title: "Cash is projected to go negative",
      detail: `Trough ${money(input.currency, input.forecastLowest.balance)} on ${input.forecastLowest.date}, from open invoices in and bills plus committed outflows out.`,
      href: "/app/finance/forecast",
      provenance: "system",
    });
  }

  if (decGtZero(input.apOverdue)) {
    items.push({
      id: "ap-overdue",
      band: "decide",
      title: `${money(input.currency, input.apOverdue)} in payables is overdue`,
      detail: "Each needs a payment decision from someone holding finance authority.",
      href: "/app/finance/receivables",
      provenance: "system",
    });
  }

  if (decGtZero(input.arOverdue)) {
    items.push({
      id: "ar-overdue",
      band: "decide",
      title: `${money(input.currency, input.arOverdue)} in receivables is overdue`,
      detail: "Money owed to the business that has passed its due date.",
      href: "/app/finance/receivables",
      provenance: "system",
    });
  }

  if (input.warnCount > 0) {
    items.push({
      id: "warnings",
      band: "watch",
      title: `${input.warnCount} warning${input.warnCount === 1 ? "" : "s"} to review`,
      detail: "Not urgent today, but they will become urgent if nothing changes.",
      provenance: "system",
    });
  }

  items.push({
    id: "cash",
    band: "watch",
    title: `Cash on hand: ${money(input.currency, input.cash)}`,
    detail: "Across every bank and cash account in this company.",
    href: "/app/finance/accounts",
    provenance: "system",
  });

  if (
    !degraded &&
    input.criticalCount === 0 &&
    input.warnCount === 0 &&
    !input.forecastGoesNegative
  ) {
    items.push({
      id: "clear",
      band: "clear",
      title: "No exceptions — operations are on track",
      detail: "Nothing in the sources checked is overdue, blocked or over capacity.",
      provenance: "system",
    });
  }

  return items;
}
