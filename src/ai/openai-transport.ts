/**
 * Live OpenAI transport for the AI gateway (guide §4, DECISIONS D-006/D-015).
 *
 * This is the ONLY file besides `gateway.ts` that reaches a model provider, and one
 * of the few that names real model IDs (the routing table in `gateway.ts` owns the
 * logical → real mapping; this file only forwards the id it is given). Nothing here
 * is imported by business logic — the gateway depends on the `CompletionTransport`
 * interface, and this concrete transport is injected at the edge (Inngest consumer).
 *
 * It targets the OpenAI **Responses API** (`/v1/responses`), because the configured
 * model (`gpt-5.6-sol`) is served there rather than on Chat Completions. Mapping:
 *   - `system` → `instructions`
 *   - `user`   → `input` (JSON mode requires the word "json" in the input, so we
 *                append a short JSON directive)
 *   - `maxTokens` → `max_output_tokens`
 * Output text is read from `output[].content[].text`; usage from `usage`. It uses the
 * global `fetch` (Node ≥ 18) so there is no OpenAI SDK dependency to add (cost rule).
 */
import { env } from "@/config/env";
import type { CompletionRequest, CompletionResponse, CompletionTransport } from "./gateway";
import { computeCostUsd } from "./pricing";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export interface OpenAiTransportOptions {
  apiKey?: string;
  /** Override for tests / self-hosted gateways. */
  baseUrl?: string;
  /** Abort the request after this many ms (default 30s). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Build the live transport. `env.openai.apiKey()` throws loudly if the key is absent,
 * so this is only constructed inside the consumer where a key is required — never at
 * import time, and never in unit tests (which inject a fake transport).
 */
export function makeOpenAiTransport(opts: OpenAiTransportOptions = {}): CompletionTransport {
  const apiKey = opts.apiKey ?? env.openai.apiKey();
  const baseUrl = opts.baseUrl ?? OPENAI_RESPONSES_URL;
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
            instructions: req.system,
            // JSON mode (text.format json_object) requires the word "json" in the input.
            input: `${req.user}\n\nReturn the result as a single json object.`,
            max_output_tokens: req.maxTokens,
            // A caller-supplied schema is enforced by the provider (strict structured output);
            // otherwise fall back to plain JSON mode.
            text: req.jsonSchema
              ? { format: { type: "json_schema", name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } }
              : { format: { type: "json_object" } },
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

      const json = (await res.json()) as OpenAiResponsesResponse;
      const text = extractOutputText(json);
      const inputTokens = json.usage?.input_tokens ?? 0;
      const outputTokens = json.usage?.output_tokens ?? 0;

      return {
        text,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        cost_usd: computeCostUsd(req.model, inputTokens, outputTokens),
      };
    },
  };
}

interface OpenAiResponsesResponse {
  output?: {
    type?: string;
    content?: { type?: string; text?: string }[];
  }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Concatenate every assistant `output_text` chunk (ignores reasoning items). */
export function extractOutputText(json: OpenAiResponsesResponse): string {
  let text = "";
  for (const item of json.output ?? []) {
    if (item.type && item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" || c.type === "text") text += c.text ?? "";
    }
  }
  return text;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}
