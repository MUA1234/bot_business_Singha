/**
 * V3.1 canonical contract — shared AI Guide (pack `06_WORK_COACHING_AND_DECISIONS.md`,
 * `34_CLAUDE_GITHUB_MASTER_COMMAND.md` STEP 2 §5).
 *
 * A persistent, shared AI supervisor/coach lives inside each task: it answers questions (Ask AI),
 * proposes the next action, helps with blockers, and shares scoped advice with authorised senior task
 * members. PROPOSAL ONLY — a guide message never executes anything. If it carries a
 * `proposedNextAction`, that action is itself routed through deterministic authority/permission
 * checks; it is not an instruction.
 *
 * `visibility` keeps private coaching private: a coaching message to an individual must not leak to
 * unauthorised seniors (guide adversarial review — "private coaching visibility").
 */
import { z } from "zod";
import { AuthorityLevel, RiskClass } from "@/schemas/management";
import { confidence01 } from "@/schemas/common";
import { TeamRole } from "@/schemas/v3_1/team-formation";

/** What kind of guidance this message is. */
export const AiGuideKind = z.enum([
  "next_action",
  "clarification",
  "blocker_help",
  "encouragement",
  "escalation",
  "answer", // response to an explicit Ask-AI question
]);
export type AiGuideKind = z.infer<typeof AiGuideKind>;

/**
 * Who may see the message.
 * - `task_team`   — all task members.
 * - `seniors`     — authorised senior task members (owner/supervisor/approver), for scoped visibility.
 * - `private`     — only the specific recipient(s) in `audienceRefs` (private coaching).
 */
export const GuideVisibility = z.enum(["task_team", "seniors", "private"]);
export type GuideVisibility = z.infer<typeof GuideVisibility>;

/** A proposed next action. Proposal only — deterministic policy decides if it may ever run. */
export const ProposedNextAction = z.object({
  action: z.string().min(1),
  reason: z.string().min(1),
  requiredAuthority: AuthorityLevel,
  risk: RiskClass,
  /** When the proposal lapses if not acted on. */
  expiresAt: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
});
export type ProposedNextAction = z.infer<typeof ProposedNextAction>;

export const AiGuideMessage = z
  .object({
    taskId: z.string().min(1),
    companyId: z.string().min(1),
    kind: AiGuideKind,
    /** The guidance text. Shown to humans; never fed back into business logic as free text. */
    body: z.string().min(1),
    visibility: GuideVisibility,
    /** Team roles the message is addressed to (advisory; the authority check is downstream). */
    audienceRoles: z.array(TeamRole).default([]),
    /** Specific recipients — REQUIRED when visibility is `private`. */
    audienceRefs: z.array(z.string().min(1)).default([]),
    /** Present only when the AI proposes a concrete next step. */
    proposedNextAction: ProposedNextAction.nullish(),
    evidenceRefs: z.array(z.string()).default([]),
    confidence: confidence01,
    promptVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .refine((m) => m.visibility !== "private" || m.audienceRefs.length > 0, {
    message: "a private coaching message must name at least one recipient in audienceRefs",
    path: ["audienceRefs"],
  });
export type AiGuideMessage = z.infer<typeof AiGuideMessage>;
