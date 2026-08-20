/**
 * Deterministic gate over a model's finance-intent classification (FOUND-003).
 *
 * The model may read the message; it may not decide what happens to it. This gate turns a
 * schema-valid `FinanceIntent` into exactly one of three outcomes, using rules a person can audit:
 *
 *   capture       — persist a source event and let the existing policy/authority pipeline run;
 *   clarify       — ask the sender one specific question (amount, currency, counterparty);
 *   manual_review — a human looks at it, because something is unsafe to assume.
 *
 * What this gate NEVER does, by construction: post an accounting entry, mark a payment complete,
 * initiate a transfer, or decide an authority level. Capturing an event is the beginning of a
 * review, not a financial action.
 */
import { Money } from "@/lib/money";
import type { FinanceIntent } from "@/schemas/finance-intent";

export type FinanceGateOutcome =
  | {
      outcome: "capture";
      kind: FinanceIntent["kind"];
      /** Canonical decimal string. Never a float, never rounded here. */
      amount: string;
      currency: string;
      counterparty: string | null;
      requiresEvidence: boolean;
      reasons: string[];
    }
  | { outcome: "clarify"; question: string; missing: string[]; reasons: string[] }
  | { outcome: "manual_review"; reasons: string[] };

export interface FinanceGateContext {
  /** Currencies this company actually transacts in. An amount in anything else is not assumed. */
  knownCurrencies: string[];
  /** Minimum confidence below which nothing is captured without a human. */
  minConfidence?: number;
}

/** Currency words a Sri Lankan business writes in practice, mapped to ISO codes. */
const CURRENCY_WORDS: Record<string, string> = {
  rs: "LKR",
  "rs.": "LKR",
  rupee: "LKR",
  rupees: "LKR",
  lkr: "LKR",
  "sl rs": "LKR",
  usd: "USD",
  "us$": "USD",
  dollar: "USD",
  dollars: "USD",
  eur: "EUR",
  euro: "EUR",
  euros: "EUR",
  gbp: "GBP",
};

/**
 * Normalise a stated currency to an ISO code, or null when it cannot be determined.
 * A currency is NEVER inferred from the company's default — an unstated currency is a question,
 * not an assumption, because assuming it silently changes what the business believes it spent.
 */
export function normalizeCurrency(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (CURRENCY_WORDS[s]) return CURRENCY_WORDS[s];
  const upper = s.toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

/**
 * Parse a stated amount into a canonical decimal string.
 * Accepts thousands separators; refuses anything that is not unambiguously one positive number.
 * Returns null when the text does not yield exactly one parseable amount.
 */
export function parseStatedAmount(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // Strip grouping commas and spaces, keep digits and at most one decimal point.
  const cleaned = s.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  try {
    const m = Money.of(cleaned, "XXX"); // currency-agnostic parse; exactness is what matters here
    if (!m.isPositive()) return null;
    return cleaned;
  } catch {
    return null;
  }
}

/** Amount above which a supporting document is required before capture. */
const EVIDENCE_THRESHOLD = "10000";

export function gateFinanceIntent(intent: FinanceIntent, ctx: FinanceGateContext): FinanceGateOutcome {
  const reasons: string[] = [];
  const minConfidence = ctx.minConfidence ?? 0.5;

  if (intent.kind === "none") {
    return { outcome: "manual_review", reasons: ["not classified as a financial event"] };
  }

  // A low-confidence reading is never captured as a financial fact.
  if (intent.confidence < minConfidence) {
    return {
      outcome: "manual_review",
      reasons: [`classification confidence ${intent.confidence} is below ${minConfidence}`],
    };
  }

  const amount = parseStatedAmount(intent.amountRaw);
  const currency = normalizeCurrency(intent.currencyRaw);
  const missing: string[] = [];
  if (!amount) missing.push("amount");
  if (!currency) missing.push("currency");

  if (missing.length > 0) {
    // An ambiguous amount or an unstated currency is a QUESTION. Guessing either would change what
    // the business believes it spent, silently.
    return {
      outcome: "clarify",
      question:
        missing.length === 2
          ? "How much was it, and in which currency?"
          : missing[0] === "amount"
            ? "How much was it exactly?"
            : "Which currency was that in?",
      missing,
      reasons: [`could not determine: ${missing.join(", ")}`],
    };
  }

  // A currency the company does not transact in is not assumed to be a typo.
  const known = ctx.knownCurrencies.map((c) => c.trim().toUpperCase());
  if (known.length > 0 && !known.includes(currency!)) {
    return {
      outcome: "manual_review",
      reasons: [`currency ${currency} is not one this company transacts in (${known.join(", ")}) — never converted`],
    };
  }

  // Material amounts require a supporting document before they are captured as fact.
  const material = Money.of(amount!, currency!).greaterThan(Money.of(EVIDENCE_THRESHOLD, currency!));
  if (material && !intent.mentionsEvidenceDocument) {
    return {
      outcome: "manual_review",
      reasons: [`amount ${amount} ${currency} is material and no supporting document was referenced`],
    };
  }

  if (intent.missingInfo.length > 0) reasons.push(`model flagged missing info: ${intent.missingInfo.join(", ")}`);
  reasons.push("amount and currency parsed exactly; captured for policy and authority evaluation");

  return {
    outcome: "capture",
    kind: intent.kind,
    amount: amount!,
    currency: currency!,
    counterparty: intent.counterpartyRaw?.trim() || null,
    requiresEvidence: material,
    reasons,
  };
}
