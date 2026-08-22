import type { CompletionRequest, CompletionResponse, CompletionTransport } from "./gateway";

export type ModelTask = "extraction" | "quotation" | "management";

export interface ModelRouteCandidate {
  provider: string;
  model: string;
  tasks: ModelTask[];
  estimatedCostUsd: string;
  latencyMs: number;
  highRisk?: boolean;
}

export interface ModelSelectionRequest {
  companyId: string;
  task: ModelTask;
  budgetRemainingUsd: string;
  highRisk?: boolean;
  lowConfidence?: boolean;
}

export type ModelSelection =
  | { ok: true; provider: string; model: string; review: "none" | "second_model" }
  | { ok: false; reason: "budget_exceeded" | "no_healthy_provider" };

export interface RegisteredModelProvider {
  candidate: ModelRouteCandidate;
  transport: CompletionTransport;
}

export interface ModelAttemptTelemetry {
  recordAttempt(attempt: {
    logicalRequestId: string;
    companyId: string;
    task: ModelTask;
    provider: string;
    model: string;
    attempt: number;
    outcome: "succeeded" | "failed";
    latencyMs: number;
    errorCategory?: "transport_error" | "budget_exceeded" | "no_healthy_provider" | "provider_not_registered";
  }): Promise<void> | void;
}

/** Server-side allowlist that binds policy candidates to their provider transports. */
export class ModelProviderRegistry {
  private readonly providers = new Map<string, RegisteredModelProvider>();

  constructor(providers: readonly RegisteredModelProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.candidate.provider)) {
        throw new Error(`duplicate model provider registration: ${provider.candidate.provider}`);
      }
      this.providers.set(provider.candidate.provider, provider);
    }
  }

  candidates(): ModelRouteCandidate[] {
    return [...this.providers.values()].map(({ candidate }) => candidate);
  }

  get(provider: string): RegisteredModelProvider | undefined {
    return this.providers.get(provider);
  }
}

export interface ModelExecutionRequest {
  logicalRequestId: string;
  selection: ModelSelectionRequest;
  completion: Omit<CompletionRequest, "model">;
  maxAttempts?: number;
}

export type ModelExecutionResult =
  | { ok: true; response: CompletionResponse; selection: Extract<ModelSelection, { ok: true }>; attempts: number }
  | { ok: false; reason: "budget_exceeded" | "no_healthy_provider" | "transport_error"; attempts: number };

export type ModelReviewResult =
  | { ok: true; response: CompletionResponse; attempts: number }
  | { ok: false; reason: "review_unavailable" | "review_disagreement" | "transport_error"; attempts: number };

/**
 * Pure, server-side route policy. It selects an approved transport target but never executes a
 * completion or authorizes a business side effect; callers still validate output and apply their
 * deterministic policy/atomic persistence boundaries.
 */
export class ModelPolicyRouter {
  private readonly unhealthyProviders = new Set<string>();

  constructor(private readonly candidates: readonly ModelRouteCandidate[]) {}

  recordFailure(provider: string): void {
    this.unhealthyProviders.add(provider);
  }

  recordSuccess(provider: string): void {
    this.unhealthyProviders.delete(provider);
  }

  select(request: ModelSelectionRequest): ModelSelection {
    const budget = Number(request.budgetRemainingUsd);
    const available = this.candidates
      .filter((candidate) => candidate.tasks.includes(request.task))
      .filter((candidate) => !this.unhealthyProviders.has(candidate.provider))
      .filter((candidate) => Number(candidate.estimatedCostUsd) <= budget)
      .sort((left, right) =>
        Number(left.estimatedCostUsd) - Number(right.estimatedCostUsd)
        || left.latencyMs - right.latencyMs
        || left.provider.localeCompare(right.provider),
      );

    if (available.length === 0) {
      const hasHealthyTaskProvider = this.candidates.some((candidate) =>
        candidate.tasks.includes(request.task) && !this.unhealthyProviders.has(candidate.provider),
      );
      return { ok: false, reason: hasHealthyTaskProvider ? "budget_exceeded" : "no_healthy_provider" };
    }

    const selected = available[0]!;
    return {
      ok: true,
      provider: selected.provider,
      model: selected.model,
      review: request.highRisk || request.lowConfidence || selected.highRisk ? "second_model" : "none",
    };
  }
}

/**
 * Executes policy-selected, read-only model attempts. It has no access to business stores, so
 * callers can persist one validated/adjudicated result at their own idempotent atomic boundary.
 */
export class ModelPolicyExecutor {
  constructor(
    private readonly registry: ModelProviderRegistry,
    private readonly router: ModelPolicyRouter,
    private readonly telemetry: ModelAttemptTelemetry,
  ) {}

  async recordRejection(input: {
    logicalRequestId: string;
    companyId: string;
    task: ModelTask;
    reason: "budget_exceeded" | "no_healthy_provider";
  }): Promise<void> {
    await this.telemetry.recordAttempt({
      logicalRequestId: input.logicalRequestId,
      companyId: input.companyId,
      task: input.task,
      provider: "policy",
      model: "unselected",
      attempt: 1,
      outcome: "failed",
      latencyMs: 0,
      errorCategory: input.reason,
    });
  }

  async execute(request: ModelExecutionRequest): Promise<ModelExecutionResult> {
    const maxAttempts = request.maxAttempts ?? 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const selection = this.router.select(request.selection);
      if (!selection.ok) {
        await this.recordRejection({
          logicalRequestId: request.logicalRequestId,
          companyId: request.selection.companyId,
          task: request.selection.task,
          reason: selection.reason,
        });
        return { ok: false, reason: selection.reason, attempts: attempt - 1 };
      }

      const provider = this.registry.get(selection.provider);
      if (!provider) {
        this.router.recordFailure(selection.provider);
        await this.telemetry.recordAttempt({
          logicalRequestId: request.logicalRequestId,
          companyId: request.selection.companyId,
          task: request.selection.task,
          provider: selection.provider,
          model: selection.model,
          attempt,
          outcome: "failed",
          latencyMs: 0,
          errorCategory: "provider_not_registered",
        });
        continue;
      }

      const startedAt = Date.now();
      try {
        const response = await provider.transport.complete({ ...request.completion, model: selection.model });
        this.router.recordSuccess(selection.provider);
        await this.telemetry.recordAttempt({
          logicalRequestId: request.logicalRequestId,
          companyId: request.selection.companyId,
          task: request.selection.task,
          provider: selection.provider,
          model: selection.model,
          attempt,
          outcome: "succeeded",
          latencyMs: Date.now() - startedAt,
        });
        return { ok: true, response, selection, attempts: attempt };
      } catch {
        this.router.recordFailure(selection.provider);
        await this.telemetry.recordAttempt({
          logicalRequestId: request.logicalRequestId,
          companyId: request.selection.companyId,
          task: request.selection.task,
          provider: selection.provider,
          model: selection.model,
          attempt,
          outcome: "failed",
          latencyMs: Date.now() - startedAt,
          errorCategory: "transport_error",
        });
      }
    }

    return { ok: false, reason: "transport_error", attempts: maxAttempts };
  }

  /** Runs a second approved provider only when policy requests it; disagreement is fail-closed. */
  async executeWithReview(
    request: ModelExecutionRequest,
    agree: (primary: CompletionResponse, reviewer: CompletionResponse) => boolean,
  ): Promise<ModelReviewResult> {
    const primary = await this.execute(request);
    if (!primary.ok) return primary.reason === "transport_error"
      ? { ok: false, reason: "transport_error", attempts: primary.attempts }
      : { ok: false, reason: "review_unavailable", attempts: primary.attempts };
    if (primary.selection.review === "none") return { ok: true, response: primary.response, attempts: primary.attempts };

    const reviewer = this.registry.candidates().find((candidate) =>
      candidate.provider !== primary.selection.provider
      && candidate.tasks.includes(request.selection.task)
      && Number(candidate.estimatedCostUsd) <= Number(request.selection.budgetRemainingUsd),
    );
    if (!reviewer) return { ok: false, reason: "review_unavailable", attempts: primary.attempts };
    const provider = this.registry.get(reviewer.provider);
    if (!provider) return { ok: false, reason: "review_unavailable", attempts: primary.attempts };
    try {
      const response = await provider.transport.complete({ ...request.completion, model: reviewer.model });
      await this.telemetry.recordAttempt({ logicalRequestId: request.logicalRequestId, companyId: request.selection.companyId, task: request.selection.task, provider: reviewer.provider, model: reviewer.model, attempt: primary.attempts + 1, outcome: "succeeded", latencyMs: 0 });
      return agree(primary.response, response)
        ? { ok: true, response: primary.response, attempts: primary.attempts + 1 }
        : { ok: false, reason: "review_disagreement", attempts: primary.attempts + 1 };
    } catch {
      this.router.recordFailure(reviewer.provider);
      await this.telemetry.recordAttempt({ logicalRequestId: request.logicalRequestId, companyId: request.selection.companyId, task: request.selection.task, provider: reviewer.provider, model: reviewer.model, attempt: primary.attempts + 1, outcome: "failed", latencyMs: 0, errorCategory: "transport_error" });
      return { ok: false, reason: "transport_error", attempts: primary.attempts + 1 };
    }
  }
}