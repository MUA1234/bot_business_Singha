/**
 * Logical AI routes (NEXT_PHASE_DEVELOPER_BRIEF §WP5.5).
 *
 * Business code asks for an INTENT (classify / draft / analyze / specialist); this
 * table maps each intent to a gateway model route + a cost tier, and flags the
 * specialist route as always requiring human review. Real model ids stay in the
 * gateway routing table (`gateway.ts`) — this layer never names a provider model.
 *
 * Routing an intent to a cheaper tier is a config change here, not a code change at
 * the call sites. Today every gateway route resolves to the owner-mandated model
 * (D-015); when a cheaper model is approved, only `gateway.MODEL_ROUTES` changes.
 */
import type { RouteName } from "./gateway";

export type AiIntent = "classify" | "draft" | "analyze" | "specialist";
export type CostTier = "low" | "standard" | "high";

export interface RouteSpec {
  intent: AiIntent;
  /** The gateway route (owns the real model id). */
  gatewayRoute: RouteName;
  costTier: CostTier;
  /** Specialist financial/legal analysis must ALWAYS go to a human (Brief §WP5.5). */
  requiresHumanReview: boolean;
  description: string;
}

export const AI_ROUTES: Record<AiIntent, RouteSpec> = {
  // Low-cost classification / extraction (high volume, routine).
  classify: { intent: "classify", gatewayRoute: "extraction", costTier: "low", requiresHumanReview: false, description: "classification / structured extraction" },
  // Ordinary communication drafting (for human review before sending).
  draft: { intent: "draft", gatewayRoute: "quotation", costTier: "standard", requiresHumanReview: false, description: "communication drafting" },
  // Complex managerial analysis.
  analyze: { intent: "analyze", gatewayRoute: "management", costTier: "high", requiresHumanReview: false, description: "managerial analysis" },
  // Specialist financial / legal analysis — NEVER acted on without a human.
  specialist: { intent: "specialist", gatewayRoute: "management", costTier: "high", requiresHumanReview: true, description: "specialist financial/legal analysis (human review required)" },
};

export function resolveRoute(intent: AiIntent): RouteSpec {
  return AI_ROUTES[intent];
}

/** True if the intent's output must be reviewed by a human before any action. */
export function requiresHumanReview(intent: AiIntent): boolean {
  return AI_ROUTES[intent].requiresHumanReview;
}

/** Routine, high-volume work should never silently use the most expensive tier. */
export function isHighCost(intent: AiIntent): boolean {
  return AI_ROUTES[intent].costTier === "high";
}
