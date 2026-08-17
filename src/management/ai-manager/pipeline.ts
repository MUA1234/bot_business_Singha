/**
 * Observation → plan (Architecture V2 change plan §6.2). Pure and deterministic:
 * turns a validated ManagementObservation into a plan the app can act on SAFELY —
 * concrete tasks to capture, whether human approval is required, and open questions.
 * It decides nothing sensitive: it only ever proposes `captured` tasks (a low-risk
 * informational action) and flags everything else for a human (Constitution §6).
 */
import type { ManagementObservation, AuthorityLevel } from "@/schemas/management";

export interface PlannedTask {
  title: string;
  note: string | null;
  /** Task requires human evidence to complete when the observation carries risk/impact. */
  requiresEvidence: boolean;
}

export interface ManagerPlan {
  tasks: PlannedTask[];
  requiredAuthority: AuthorityLevel;
  needsApproval: boolean; // anything above policy_controlled
  clarifications: string[]; // missing info to resolve first
  suggestedActions: string[]; // for the human to consider — never auto-run
  confidence: number;
}

const APPROVAL_LEVELS = new Set<AuthorityLevel>(["manager_approval", "specialist_approval", "owner_approval"]);

/** The ladder, lowest → highest. Mirrors AuthorityLevel and route-decision's LEVELS. */
const LADDER: AuthorityLevel[] = [
  "automatic",
  "policy_controlled",
  "manager_approval",
  "specialist_approval",
  "owner_approval",
];
const rank = (l: AuthorityLevel) => LADDER.indexOf(l);
const higher = (a: AuthorityLevel, b: AuthorityLevel): AuthorityLevel => (rank(a) >= rank(b) ? a : b);

/**
 * Deterministic authority FLOOR computed from the observation's own content.
 *
 * Why this exists: `requiredAuthority` is a field the MODEL fills in, and the model reads
 * untrusted text. Until this floor was added, the level recorded against a case — and the
 * "needs a human" flag derived from it — was whatever the model said, with only a sentence in
 * the prompt asking it to be careful. That inverts the constitution's order (schema validation →
 * DETERMINISTIC authority rules → permission → audit): a prompt instruction is not a control.
 *
 * The floor never LOWERS what the model asked for; it raises it when the observation's own
 * structured fields show money, legal, safety or people impact. It is intentionally small and
 * content-based — it is not the full decision ladder (`routeDecision`), which remains unwired.
 */
export function authorityFloor(o: ManagementObservation): AuthorityLevel {
  const i = o.impact ?? {};
  let floor: AuthorityLevel = "automatic";

  // Money, legal exposure or safety are specialist matters by policy (CLAUDE.md financial
  // controls, and the same floor the prompt asks the model to apply — now enforced).
  if (i.financial || i.legal || i.safety) floor = higher(floor, "specialist_approval");
  // Anything with a stated operational or customer impact is at least a manager's call.
  if (i.operational || i.customer) floor = higher(floor, "manager_approval");
  // Named people mean a person is affected by whatever follows.
  if ((o.involved?.people?.length ?? 0) > 0) floor = higher(floor, "manager_approval");
  // A low-confidence reading must never present itself as routine.
  if (o.confidence < 0.3) floor = higher(floor, "manager_approval");

  return floor;
}

/** Any material impact means a completed task should require evidence. */
function hasImpact(o: ManagementObservation): boolean {
  const i = o.impact ?? {};
  return Boolean(i.financial || i.legal || i.operational || i.safety);
}

export function planFromObservation(o: ManagementObservation): ManagerPlan {
  const requiresEvidence = hasImpact(o);
  const tasks: PlannedTask[] = (o.detectedTasks ?? []).map((t) => ({
    title: t.title,
    note: t.note ?? null,
    requiresEvidence,
  }));

  // The model's claim is a PROPOSAL; the floor is the control. Take whichever is higher, so a
  // model that under-reports (through error, or because untrusted text told it to) cannot make a
  // material matter look routine — and a model that over-reports is still respected.
  const requiredAuthority = higher(o.requiredAuthority, authorityFloor(o));

  return {
    tasks,
    requiredAuthority,
    needsApproval: APPROVAL_LEVELS.has(requiredAuthority),
    clarifications: o.missingInfo ?? [],
    suggestedActions: o.suggestedActions ?? [],
    confidence: o.confidence,
  };
}
