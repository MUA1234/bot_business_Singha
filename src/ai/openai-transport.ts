/**
 * Live OpenAI transport for the AI gateway (guide §4, DECISIONS D-006).
 *
 * This is the ONLY file besides `gateway.ts` that reaches a model provider, and one
 * of the few that names real model IDs (the routing table in `gateway.ts` owns the
 * logical → real mapping; this file only forwards the id it is given). Nothing here
 * is imported by business logic — the gateway depends on the `CompletionTransport`
 * interface, and this concrete transport is injected at the edge (Inngest consumer).
 *
 * It uses `fetch` (Node ≥ 18 global) so there is no OpenAI SDK dependency to add
 * (cost rule). It requests JSON output, forwards the fenced prompt unchanged, and
 * computes the USD cost from a small per-model price table for the cost ledger (§13).
 */
import { env } from "@/config/env";
import type { CompletionRequest, CompletionResponse, CompletionTransport } from "./gateway";

/**
 * USD price per 1M tokens, per model. Update alongside OpenAI's pricing page. Keeping
 * this here (not in the gateway) means the gateway stays provider-agnostic. If a model
 * id is unknown we record cost "0" rather than guessing — an explicit, auditable zero.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
};

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

export interface OpenAiTransportOptions {
  apiKey?: string;
  /** Override for tests / self-hosted gateways. */
  baseUrl?: string;
  /** Abort the request after this many ms (default 30s). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Compute cost as a fixed-precision decimal string (never a float in the ledger). */
export function computeCostUsd(model: string, inputTokens: number, outputTokens: number): string {
  const price = PRICE_PER_MTOK[model];
  if (!price) return "0";
  const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return cost.toFixed(6);
}

/**
 * Build the live transport. `env.openai.apiKey()` throws loudly if the key is absent,
 * so this is only constructed inside the consumer where a key is required — never at
 * import time, and never in unit tests (which inject a fake transport).
 */
export function makeOpenAiTransport(opts: OpenAiTransportOptions = {}): CompletionTransport {
  const apiKey = opts.apiKey ?? env.openai.apiKey();
  const baseUrl = opts.baseUrl ?? OPENAI_CHAT_URL;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: req.model,
            max_tokens: req.maxTokens,
            temperature: 0,
            // Force a JSON object back; the gateway still re-validates with Zod.
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: req.user },
            ],
          }),
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        // Thrown → the gateway records a transport_error run; Inngest retries.
        const detail = await safeText(res);
        throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 300)}`);
      }

      const json = (await res.json()) as OpenAiChatResponse;
      const text = json.choices?.[0]?.message?.content ?? "";
      const inputTokens = json.usage?.prompt_tokens ?? 0;
      const outputTokens = json.usage?.completion_tokens ?? 0;

      return {
        text,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        cost_usd: computeCostUsd(req.model, inputTokens, outputTokens),
      };
    },
  };
}

interface OpenAiChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}
