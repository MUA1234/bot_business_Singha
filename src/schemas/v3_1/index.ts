/**
 * V3.1 canonical contracts — barrel export.
 *
 * Every AI output that could affect V3.1 business state must parse against one of these schemas
 * BEFORE the deterministic policy engine looks at it (guide §2 rule 3 / §6). These schemas describe
 * PROPOSALS ONLY — nothing here executes anything. They reuse the shared `AuthorityLevel` / `RiskClass`
 * vocabulary from `src/schemas/management.ts`; V3.1 introduces no competing authority model.
 *
 * In this foundation slice the contracts are imported by tests only (shadow); no runtime path
 * consumes them yet.
 */

/** Bump when a contract's shape changes in a way stored payloads must be versioned against. */
export const V3_1_CONTRACTS_VERSION = "3.1.0" as const;

export * from "@/schemas/v3_1/decision-path";
export * from "@/schemas/v3_1/task-intelligence-profile";
export * from "@/schemas/v3_1/team-formation";
export * from "@/schemas/v3_1/ai-guide";
