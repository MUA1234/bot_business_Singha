/**
 * V3.1 canonical contract — Task Intelligence Profile (pack `16_AI_LEAD_TASK_ORCHESTRATION.md`,
 * `34_CLAUDE_GITHUB_MASTER_COMMAND.md` STEP 2 §2).
 *
 * When the AI detects a candidate task from one or more source events, it produces a deduplicated,
 * versioned profile + brief describing what the task is, its scope, its evidence and its confidence.
 * PROPOSAL ONLY — a profile never creates a task by itself; linked subtasks are only created after
 * authorised confirmation (guide: no free-text AI output triggers sensitive actions).
 *
 * The `dedupeKey` is the anti-duplication anchor: a duplicate source event must never create a
 * second task (CLAUDE.md core principle — "a duplicate event must never create a duplicate task").
 */
import { z } from "zod";
import { AuthorityLevel, RiskClass } from "@/schemas/management";
import { confidence01 } from "@/schemas/common";

/** Candidate lifecycle for a detected task profile (proposal-side only). */
export const TaskCandidateStatus = z.enum([
  "candidate", // detected, awaiting human confirmation
  "confirmed", // a human confirmed it should become a task
  "dismissed", // a human rejected it
  "duplicate", // merged into an existing task/candidate via dedupeKey
]);
export type TaskCandidateStatus = z.infer<typeof TaskCandidateStatus>;

/** Organisational scope. Every profile is company-scoped; finer scope is optional. */
export const TaskScope = z.object({
  companyId: z.string().min(1),
  divisionId: z.string().nullish(),
  departmentId: z.string().nullish(),
  siteId: z.string().nullish(),
  projectId: z.string().nullish(),
});
export type TaskScope = z.infer<typeof TaskScope>;

export const TaskIntelligenceProfile = z.object({
  candidateId: z.string().min(1),
  scope: TaskScope,
  title: z.string().min(1),
  /** The versioned working brief. `briefVersion` increments as the brief is refined. */
  brief: z.string().min(1),
  briefVersion: z.number().int().min(1),
  /** Source events this profile was derived from. At least one — profiles are evidence-backed. */
  sourceEventIds: z.array(z.string().min(1)).min(1),
  evidenceRefs: z.array(z.string()).default([]),
  /** Stable key that prevents a duplicate event creating a duplicate task/candidate. */
  dedupeKey: z.string().min(1),
  status: TaskCandidateStatus.default("candidate"),
  /** Set when `status === "duplicate"`. */
  possibleDuplicateOf: z.string().min(1).nullish(),
  confidence: confidence01,
  risk: RiskClass,
  /** Authority the resulting work is expected to require — informational at detection time. */
  requiredAuthority: AuthorityLevel,
  openQuestions: z.array(z.string()).default([]),
  missingInfo: z.array(z.string()).default([]),
  detectedAt: z.string().min(1),
});
export type TaskIntelligenceProfile = z.infer<typeof TaskIntelligenceProfile>;
