/**
 * Senior AI Manager governance schemas (Architecture V2 change plan §6.1, §6.3).
 * EVERY AI output that could affect business state must parse against one of these
 * before the deterministic policy engine looks at it (Constitution §6: schema-
 * validate; keep AI recommendations separate from execution). These schemas describe
 * PROPOSALS only — nothing here executes anything.
 */
import { z } from "zod";

/** Human-approval ladder (change plan §6.3 / diagram 9). */
export const AuthorityLevel = z.enum([
  "automatic", // informational, no approval
  "policy_controlled", // routine, within delegated limit
  "manager_approval",
  "specialist_approval", // finance / legal / HR / privacy
  "owner_approval",
]);
export type AuthorityLevel = z.infer<typeof AuthorityLevel>;

export const RiskClass = z.enum(["low", "medium", "high", "critical"]);

const MoneyLimit = z.object({
  amount: z.string().regex(/^-?\d+(\.\d+)?$/, "money must be a decimal string"),
  currency: z.string().length(3),
});

/** §6.1 — structured result of observing one or more source events. */
export const ManagementObservation = z.object({
  sourceEventId: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
  scope: z.object({
    companyId: z.string().min(1),
    divisionId: z.string().nullish(),
    departmentId: z.string().nullish(),
    siteId: z.string().nullish(),
    projectId: z.string().nullish(),
  }),
  involved: z
    .object({
      people: z.array(z.string()).default([]),
      customers: z.array(z.string()).default([]),
      suppliers: z.array(z.string()).default([]),
      vehicles: z.array(z.string()).default([]),
      assets: z.array(z.string()).default([]),
    })
    .default({}),
  confirmedFacts: z.array(z.string()).default([]),
  inferredFacts: z.array(z.string()).default([]),
  detectedTasks: z.array(z.object({ title: z.string().min(1), note: z.string().nullish() })).default([]),
  impact: z
    .object({
      financial: z.string().nullish(),
      legal: z.string().nullish(),
      operational: z.string().nullish(),
      customer: z.string().nullish(),
      safety: z.string().nullish(),
    })
    .default({}),
  confidence: z.number().min(0).max(1),
  uncertainty: z.string().nullish(),
  missingInfo: z.array(z.string()).default([]),
  suggestedActions: z.array(z.string()).default([]),
  requiredAuthority: AuthorityLevel,
  followUpDate: z.string().nullish(),
});
export type ManagementObservation = z.infer<typeof ManagementObservation>;

/** §6.3 — a single proposed action the policy engine will route. */
export const DecisionProposal = z.object({
  action: z.string().min(1),
  reason: z.string().min(1),
  expectedOutcome: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  risk: RiskClass,
  policyVersion: z.string().min(1),
  requiredPermission: z.string().min(1),
  requiredApprovers: z.array(z.string()).default([]),
  limit: MoneyLimit.nullish(),
  expiresAt: z.string().min(1),
  conditions: z.array(z.string()).default([]),
  reversalPlan: z.string().nullish(),
});
export type DecisionProposal = z.infer<typeof DecisionProposal>;
