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