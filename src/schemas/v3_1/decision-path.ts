/**
 * V3.1 canonical contract — Decision Path Ladder (pack `17_DECISION_PATHS_AND_IMPROVEMENTS.md`,
 * `34_CLAUDE_GITHUB_MASTER_COMMAND.md` STEP 2 §3).
 *
 * For a task the AI proposes a LADDER of four decision paths, ordered from the simplest safe option
 * to the most ambitious, marking exactly one as the recommended balance. This schema describes
 * PROPOSALS ONLY — nothing here executes. Each rung declares the human authority it would require;
 * selection is routed through deterministic authority/permission checks downstream, never chosen by
 * the model (guide §2 rule 3 / §6: schema → authority → permission → audit).
 *
 * Reuses the shared `AuthorityLevel` and `RiskClass` from `src/schemas/management.ts` — V3.1
 * introduces no competing authority vocabulary.
 */
import { z } from "zod";
import { AuthorityLevel, RiskClass } from "@/schemas/management";
import { confidence01 } from "@/schemas/common";

/** The four fixed rungs, ordered simplest-safe → most-ambitious. */
export const DecisionRung = z.enum(["quick_and_safe", "balanced", "robust", "strategic"]);
export type DecisionRung = z.infer<typeof DecisionRung>;

/** Human-readable label for a rung (UI convenience; not authoritative). */
export const DECISION_RUNG_LABEL: Record<DecisionRung, string> = {
  quick_and_safe: "Quick & Safe",
  balanced: "Balanced",
  robust: "Robust",
  strategic: "Strategic",
};

/** One rung of the ladder. A proposed path, not an executable command. */
export const DecisionPath = z.object({
  rung: DecisionRung,
  title: z.string().min(1),
  summary: z.string().min(1),
  /** Ordered proposed steps. */
  steps: z.array(z.string().min(1)).min(1),
  expectedOutcome: z.string().min(1),
  /** Trade-offs / why a manager might not pick this rung. */
  tradeoffs: z.array(z.string()).default([]),
  /** Authority this path would require if selected — enforced downstream, not by the model. */
  requiredAuthority: AuthorityLevel,
  risk: RiskClass,
  /** Free-form estimate, e.g. "~2 days" or "1 sprint". Optional. */
  estimatedEffort: z.string().nullish(),
  evidenceRefs: z.array(z.string()).default([]),
  /** How to undo this path if it goes wrong. Null only for genuinely irreversible-by-nature work. */
  reversalPlan: z.string().nullish(),
  /** Exactly one rung across the ladder carries `true` (enforced by `DecisionPathLadder`). */
  recommended: z.boolean(),
});
export type DecisionPath = z.infer<typeof DecisionPath>;

/**
 * The complete ladder for one task candidate. Must contain each of the four rungs exactly once, with
 * exactly one marked as the recommended balance.
 */
export const DecisionPathLadder = z
  .object({
    candidateId: z.string().min(1),
    companyId: z.string().min(1),
    rungs: z.array(DecisionPath).length(4),
    /** Versioning so a stored ladder is reproducible / auditable. */
    promptVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
    confidence: confidence01,
    generatedAt: z.string().min(1),
  })
  .refine((l) => new Set(l.rungs.map((r) => r.rung)).size === 4, {
    message: "ladder must contain each of the four rungs exactly once",
    path: ["rungs"],
  })
  .refine((l) => l.rungs.filter((r) => r.recommended).length === 1, {
    message: "exactly one rung must be marked as the recommended balance",
    path: ["rungs"],
  });
export type DecisionPathLadder = z.infer<typeof DecisionPathLadder>;
