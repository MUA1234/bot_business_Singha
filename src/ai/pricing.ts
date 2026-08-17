/**
 * AI model price table + cost calculation (NEXT_PHASE_DEVELOPER_BRIEF §WP5.4).
 *
 * The configured model `gpt-5.6-sol` had no price, so the cost ledger recorded 0 for
 * every call (tokens were still recorded). We do NOT invent a rate — the real price
 * is supplied as configuration via env, so the owner sets the confirmed OpenAI rate:
 *   OPENAI_PRICE_GPT56_INPUT_PER_MTOK   (USD per 1M input tokens)
 *   OPENAI_PRICE_GPT56_OUTPUT_PER_MTOK  (USD per 1M output tokens)
 * Until set, cost stays an explicit, auditable "0" (never a guess). Model ids remain
 * confined to the AI layer (gateway routing table + this pricing table).
 */
export interface TokenPrice {
  input: number; // USD per 1,000,000 input tokens
  output: number; // USD per 1,000,000 output tokens
}

import Decimal from "decimal.js";

type Env = Record<string, string | undefined>;

function envPrice(env: Env, key: string): number | null {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Build the price table, layering env-configured rates over the static defaults. */
export function priceTable(env: Env = process.env): Record<string, TokenPrice> {
  const table: Record<string, TokenPrice> = {
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4o": { input: 2.5, output: 10 },
  };
  const input = envPrice(env, "OPENAI_PRICE_GPT56_INPUT_PER_MTOK");
  const output = envPrice(env, "OPENAI_PRICE_GPT56_OUTPUT_PER_MTOK");
  if (input !== null && output !== null && (input > 0 || output > 0)) {
    table["gpt-5.6-sol"] = { input, output };
  }
  return table;
}

/**
 * Cost as a fixed-precision decimal string (never a float in the ledger). Unknown
 * model → "0" (explicit, auditable). Prices are injectable for testing.
 * Computed in Decimal — the tokens×rate products and their sum must not accumulate float
 * error before landing in ai_runs.cost_usd (money, aggregated later for budgets).
 */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  prices: Record<string, TokenPrice> = priceTable(),
): string {
  const price = prices[model];
  if (!price) return "0";
  return new Decimal(inputTokens)
    .times(String(price.input))
    .plus(new Decimal(outputTokens).times(String(price.output)))
    .div(1_000_000)
    .toFixed(6);
}
