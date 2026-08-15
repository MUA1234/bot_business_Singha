/**
 * V3.1 canonical contract — role-first Team Formation (pack `18_TEAM_FORMATION_AND_MANAGER_VISIBILITY.md`,
 * `34_CLAUDE_GITHUB_MASTER_COMMAND.md` STEP 2 §4).
 *
 * V3.1 forms a proposed task team with explicit roles — owner, doer, adviser, supervisor, approver,
 * verifier — and recommends the right internal/external people/resources against those roles using
 * skills, capacity, authority, conflicts, credentials, expiry and separation of duties.
 *
 * ROLE-FIRST: the required roles are fixed structure; people are RECOMMENDATIONS against a role.
 * PROPOSAL ONLY — recommending a person neither assigns them nor grants them authority. Separation of
 * duties is representable so a downstream deterministic check can reject e.g. approver == doer.
 */
import { z } from "zod";
import { confidence01 } from "@/schemas/common";

/** The six fixed task-team roles. */
export const TeamRole = z.enum([
  "owner",
  "doer",
  "adviser",
  "supervisor",
  "approver",
  "verifier",
]);
export type TeamRole = z.infer<typeof TeamRole>;

/** A required role slot on the team. */
export const RoleRequirement = z.object({
  role: TeamRole,
  /** How many people this role needs. Owner/doer are typically 1. */
  count: z.number().int().min(1).default(1),
  /** Capabilities a person must hold to fill this role (matched downstream, not by the model). */
  requiredCapabilities: z.array(z.string()).default([]),
  /** False only when a role is genuinely not needed for this task (documented). */
  mandatory: z.boolean().default(true),
  rationale: z.string().nullish(),
});
export type RoleRequirement = z.infer<typeof RoleRequirement>;

/** A credential a recommended external/internal resource holds, with optional expiry. */
export const ResourceCredential = z.object({
  name: z.string().min(1),
  /** ISO date the credential expires; null = no known expiry. Expiry is enforced downstream. */
  expiresOn: z.string().nullish(),
});
export type ResourceCredential = z.infer<typeof ResourceCredential>;

/** A recommended person/resource for a specific role. A recommendation, not an assignment. */
export const ResourceRecommendation = z.object({
  role: TeamRole,
  /** Where the resource comes from. External resources always carry credential scrutiny. */
  source: z.enum(["internal", "external"]),
  /** Stable reference (staff id, contact id, vendor id). */
  ref: z.string().min(1),
  displayName: z.string().min(1),
  matchedSkills: z.array(z.string()).default([]),
  /** Free-form capacity note, e.g. "60% allocated this week". */
  availability: z.string().nullish(),
  credentials: z.array(ResourceCredential).default([]),
  /** Known conflicts of interest / prior involvement that a human should weigh. */
  conflicts: z.array(z.string()).default([]),
  /** The model's view that this pick respects separation of duties; the deterministic check is final. */
  separationOfDutiesOk: z.boolean().default(true),
  confidence: confidence01,
});
export type ResourceRecommendation = z.infer<typeof ResourceRecommendation>;

/**
 * The full team proposal for one task candidate. Must be role-first: at minimum an `owner` and a
 * `doer` requirement, no duplicate role requirements, and every recommendation must target a role
 * that is actually required.
 */
export const TeamFormationProposal = z
  .object({
    candidateId: z.string().min(1),
    companyId: z.string().min(1),
    requirements: z.array(RoleRequirement).min(1),
    recommendations: z.array(ResourceRecommendation).default([]),
    /** Human-readable SoD rules the downstream check should enforce, e.g. "approver != doer". */
    separationOfDutiesRules: z.array(z.string()).default([]),
    confidence: confidence01,
    generatedAt: z.string().min(1),
  })
  .refine((t) => new Set(t.requirements.map((r) => r.role)).size === t.requirements.length, {
    message: "each role may be required at most once",
    path: ["requirements"],
  })
  .refine(
    (t) => {
      const roles = new Set(t.requirements.map((r) => r.role));
      return roles.has("owner") && roles.has("doer");
    },
    { message: "a role-first team must at least require an owner and a doer", path: ["requirements"] },
  )
  .refine(
    (t) => {
      const required = new Set(t.requirements.map((r) => r.role));
      return t.recommendations.every((rec) => required.has(rec.role));
    },
    { message: "every recommendation must target a required role", path: ["recommendations"] },
  );
export type TeamFormationProposal = z.infer<typeof TeamFormationProposal>;
