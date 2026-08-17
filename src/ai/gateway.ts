/**
 * AI model gateway — the ONLY module allowed to name a model or reach a provider
 * (guide §4, DECISIONS D-006). Everything else calls `runExtraction`. The gateway:
 *   - fences untrusted content (prompt-injection resistance),
 *   - validates output against the Zod extraction contract,
 *   - records a cost-ledger entry for every run (model, prompt version, tokens,
 *     validation result, confidence, cost) — guide §13.
 *
 * The provider transport is injected (`CompletionTransport`) so this is testable
 * offline and provider-swappable (guide: model/provider fallback through the
 * gateway). The live OpenAI transport is wired in at configuration time — that is
 * one of the steps that needs your API key, and is intentionally NOT hardcoded here.
 */
import { randomUUID } from "node:crypto";
import { parseAiExtraction, type AiExtraction } from "@/schemas/ai-extraction";
import { EXTRACTION_PROMPT_VERSION, EXTRACTION_SYSTEM_PROMPT, wrapUntrusted } from "./prompts";

/** Logical model routing. Real model IDs live ONLY in this table.
 *  Per owner instruction (2026-08-02) both routes use `gpt-5.6-sol` — a Responses-API
 *  model (see openai-transport.ts). `maxTokens` maps to `max_output_tokens`; kept
 *  generous so reasoning + the JSON answer are never truncated. */
export const MODEL_ROUTES = {
  extraction: { model: "gpt-5.6-sol", maxTokens: 4000 },
  extraction_hard: { model: "gpt-5.6-sol", maxTokens: 4000 },
  // Customer-facing WhatsApp order intake (collect details, never price).
  quotation: { model: "gpt-5.6-sol", maxTokens: 2000 },
  // business analysis assistant: observe a business update → structured ManagementObservation.
  management: { model: "gpt-5.6-sol", maxTokens: 4000 },
  // EVALUATION ONLY — never used by a production path. The verification campaign scores the
  // scenario pack against this route when the owner supplies ANTHROPIC_API_KEY; without a key the
  // evaluation is reported as BLOCKED rather than estimated. Model ids stay in this table (D-006).
  evaluation: { model: "claude-opus-5", maxTokens: 2000 },
} as const;
export type RouteName = keyof typeof MODEL_ROUTES;

export interface CompletionRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}
export interface CompletionResponse {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
  cost_usd: string;
}
export interface CompletionTransport {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export interface AiRunRecord {
  ai_run_id: string;
  route: RouteName;
  model: string;
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  validation_ok: boolean;
  validation_issues?: string[];
  confidence_overall: number | null;
  correlation_id: string;
  // §WP5.3 — full observability trail (optional so existing callers are unaffected).
  latency_ms?: number;
  source_event_id?: string | null;
  company_id?: string | null;
}

export interface CostLedger {
  record(run: AiRunRecord): Promise<void> | void;
}

export interface ExtractionRequest {
  /** Untrusted external text (WhatsApp/email/receipt OCR). */
  content: string;
  /** Known, trusted context passed as structured hints (company, employee, etc.). */
  trustedContext?: Record<string, unknown>;
  correlationId: string;
  hard?: boolean; // route to the stronger model
  sourceEventId?: string | null; // §WP5.3 — tie the run to its originating event
  companyId?: string | null;
}

export type ExtractionResult =
  | { ok: true; extraction: AiExtraction; run: AiRunRecord }
  | { ok: false; reason: "validation_failed" | "transport_error"; run: AiRunRecord; issues?: string[] };

export class AiGateway {
  constructor(
    private readonly transport: CompletionTransport,
    private readonly ledger: CostLedger,
  ) {}

  async runExtraction(req: ExtractionRequest): Promise<ExtractionResult> {
    const route: RouteName = req.hard ? "extraction_hard" : "extraction";
    const { model, maxTokens } = MODEL_ROUTES[route];
    const fenceId = randomUUID().slice(0, 8);

    const trusted = req.trustedContext ? `Trusted context (safe): ${JSON.stringify(req.trustedContext)}\n\n` : "";
    const user = `${trusted}Extract the financial event from the following material.\n\n${wrapUntrusted(
      req.content,
      fenceId,
    )}`;

    const baseRun: Omit<AiRunRecord, "validation_ok" | "confidence_overall"> = {
      ai_run_id: `ai_${randomUUID()}`,
      route,
      model,
      prompt_version: EXTRACTION_PROMPT_VERSION,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: "0",
      correlation_id: req.correlationId,
      source_event_id: req.sourceEventId ?? null,
      company_id: req.companyId ?? null,
      latency_ms: 0,
    };

    const startedAt = Date.now();
    let resp: CompletionResponse;
    try {
      resp = await this.transport.complete({ model, system: EXTRACTION_SYSTEM_PROMPT, user, maxTokens });
    } catch (e) {
      baseRun.latency_ms = Date.now() - startedAt;
      const run: AiRunRecord = { ...baseRun, validation_ok: false, confidence_overall: null };
      await this.ledger.record(run);
      return { ok: false, reason: "transport_error", run, issues: [String((e as Error).message)] };
    }

    const withUsage = {
      ...baseRun,
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
      cost_usd: resp.cost_usd,
      latency_ms: Date.now() - startedAt,
    };

    const parsed = parseAiExtraction(safeJsonParse(resp.text));
    if (!parsed.ok) {
      const issues = parsed.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      const run: AiRunRecord = { ...withUsage, validation_ok: false, confidence_overall: null, validation_issues: issues };
      await this.ledger.record(run);
      return { ok: false, reason: "validation_failed", run, issues };
    }

    const run: AiRunRecord = {
      ...withUsage,
      validation_ok: true,
      confidence_overall: parsed.value.confidence.overall,
    };
    await this.ledger.record(run);
    return { ok: true, extraction: parsed.value, run };
  }
}

function safeJsonParse(text: string): unknown {
  try {
    // Strip accidental markdown fences some models still add.
    const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
