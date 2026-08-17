/**
 * Anthropic provider transport — EVALUATION ONLY.
 *
 * Why it exists: the verification campaign could not measure live-model decision quality because no
 * provider was configured, and it refused to invent scores. This gives the application a real,
 * auditable way to call a model when the owner supplies a key — through the SAME `CompletionTransport`
 * abstraction every other route uses, so nothing about the trust boundary changes.
 *
 * Hard rules this file keeps:
 *  - The key is read from the environment (`ANTHROPIC_API_KEY`) and is NEVER logged, echoed,
 *    returned, or included in an error message. No credential is committed anywhere.
 *  - Model ids live in the gateway routing table (DECISIONS D-006); this module takes the model as
 *    a parameter and names none of its own.
 *  - Strict caps: a bounded `max_tokens`, a request timeout, and a per-process request ceiling, so a
 *    runaway evaluation cannot spend without limit.
 *  - No Fast mode, no streaming, no tools — a single deterministic completion.
 *  - It is NOT wired into any production path. Only the evaluation harness constructs it.
 */
import { computeCostUsd } from "./pricing";
import type { CompletionRequest, CompletionResponse, CompletionTransport } from "./gateway";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** Hard ceilings. An evaluation that needs more than this is a mistake, not a bigger budget. */
export const EVAL_LIMITS = {
  maxRequestsPerProcess: 200,
  maxOutputTokens: 2000,
  timeoutMs: 60_000,
} as const;

export class AnthropicTransportError extends Error {}

/** True when a key is configured. The harness reports "blocked" rather than guessing when false. */
export function anthropicKeyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "";
}

/**
 * Build the transport. Throws if no key is configured — callers must check
 * `anthropicKeyPresent()` first and record the evaluation as BLOCKED rather than fabricating one.
 */
export function makeAnthropicTransport(
  env: NodeJS.ProcessEnv = process.env,
  limits: { maxRequests?: number } = {},
): CompletionTransport & { requestCount(): number } {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new AnthropicTransportError("ANTHROPIC_API_KEY is not configured");

  const maxRequests = limits.maxRequests ?? EVAL_LIMITS.maxRequestsPerProcess;
  let requests = 0;

  return {
    requestCount: () => requests,

    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      if (requests >= maxRequests) {
        throw new AnthropicTransportError(`evaluation request ceiling reached (${maxRequests})`);
      }
      requests += 1;

      const maxTokens = Math.min(req.maxTokens, EVAL_LIMITS.maxOutputTokens);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EVAL_LIMITS.timeoutMs);

      let res: Response;
      try {
        res = await fetch(API_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "anthropic-version": API_VERSION,
            "x-api-key": key, // never logged; not included in any thrown message below
          },
          body: JSON.stringify({
            model: req.model,
            max_tokens: maxTokens,
            temperature: 0,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
          }),
        });
      } catch (e) {
        throw new AnthropicTransportError(`transport failure: ${(e as Error).name}`);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        // Status only. A provider error body can echo request content, and this path must not
        // become a way for prompt text or a header to reach a log.
        throw new AnthropicTransportError(`provider returned HTTP ${res.status}`);
      }

      const body = (await res.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const text = (body.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();

      const input_tokens = body.usage?.input_tokens ?? 0;
      const output_tokens = body.usage?.output_tokens ?? 0;

      return {
        text,
        usage: { input_tokens, output_tokens },
        // Unknown model → an explicit, auditable "0" rather than an invented rate (see pricing.ts).
        cost_usd: computeCostUsd(req.model, input_tokens, output_tokens),
      };
    },
  };
}
