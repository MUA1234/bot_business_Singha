/**
 * The registered action catalogue (R1 checkpoint 4 — KRN-003).
 *
 * The kernel may only ever SELECT from this list. It cannot invent an action, and free-text
 * model output can never reach business state, because the only thing an interpretation can
 * influence is WHICH registered entry is proposed — never what that entry does.
 *
 * EVERY R1 ENTRY IS INTERNAL, LOW-RISK AND REVERSIBLE. Not one of them sends a customer
 * message, moves money, posts a journal, settles anything, changes a permission, or calls an
 * external system. Those remain the existing human-operated workflows, untouched by R1:
 * a recommendation about an overdue invoice produces an internal review task for a person
 * who already holds the finance capability — it does not, and cannot, chase the customer.
 *
 * Owner decision D-9 sets the ceiling: only `automatic` entries may ever run unattended, and
 * only when they are also reversible.
 */
import type { DomainAction, Department } from "./types";
import type { ActionCategory } from "./observation";

export const ACTION_CATALOGUE: readonly DomainAction[] = [
  {
    id: "ops.task.create_internal",
    department: "operations",
    capability: "operations.task.manage",
    authorityFloor: "automatic",
    reversible: true,
    automaticSafe: true,
    internalOnly: true,
    description: "Create an internal task for a person in this company.",
  },
  {
    id: "ops.task.reminder_internal",
    department: "operations",
    capability: "operations.task.work",
    authorityFloor: "automatic",
    reversible: true,
    automaticSafe: true,
    internalOnly: true,
    description: "Send an internal reminder about existing internal work.",
  },
  {
    id: "ops.task.request_progress_update",
    department: "operations",
    capability: "operations.task.work",
    authorityFloor: "automatic",
    reversible: true,
    automaticSafe: true,
    internalOnly: true,
    description: "Ask the accountable person for a progress update.",
  },
  {
    id: "ops.task.escalate_internal",
    department: "operations",
    capability: "operations.task.manage",
    authorityFloor: "automatic",
    reversible: true,
    automaticSafe: true,
    internalOnly: true,
    description: "Escalate overdue internal work under an approved playbook.",
  },
  {
    id: "finance.invoice.flag_for_review",
    department: "finance",
    capability: "finance.invoice.create",
    authorityFloor: "policy_controlled",
    reversible: true,
    automaticSafe: false,
    internalOnly: true,
    description: "Flag a receivable for a finance officer to review. Posts nothing, settles nothing, chases nobody.",
  },
  {
    id: "crm.followup.draft_for_human",
    department: "crm",
    capability: "sales.pipeline.manage",
    authorityFloor: "manager_approval",
    reversible: true,
    automaticSafe: false,
    internalOnly: true,
    description: "Prepare a DRAFT follow-up for a human to review and send. R1 never sends it.",
  },
  {
    id: "workforce.capacity.review_allocation",
    department: "workforce",
    capability: "operations.task.manage",
    authorityFloor: "manager_approval",
    reversible: true,
    automaticSafe: false,
    internalOnly: true,
    description: "Review how work is allocated for an overloaded membership.",
  },
  // ── R2A: one internal, reversible action per newly connected domain ────────────────
  // Each keeps its department's own capability so authority resolves through the existing
  // matrix, and every one is internal-only: none chases an owner, launches a campaign,
  // raises a purchase order, renews a licence or engages a provider. They open internal work
  // for a person who already holds the relevant capability.
  {
    id: "governance.directive.chase_internal",
    department: "governance",
    capability: "admin.directive.manage",
    authorityFloor: "manager_approval",
    reversible: true,
    automaticSafe: false,
    internalOnly: true,
    description: "Raise an internal task to chase an unanswered owner directive. Never answers or closes it.",
  },
  {
    id: "objectives.objective.review_internal",
    department: "objectives",
    capability: "operations.objective.manage",
    authorityFloor: "manager_approval",
    reversible: true,
    automaticSafe: false,
    internalOnly: true,
    description: "Raise an internal review of an objective that is slipping. Changes no target.",
  },
  {
    id: "marketing.campaign.review_internal",
    department: "marketing",
    capability: "marketing.campaign.manage",
    authorityFloor: "manager_approval",
    reversible: true,
    automaticSafe: false,
    internalOnly: true,
    description: "Raise an internal review of a stalled campaign. Sends nothing and launches nothing.",
  },
  {
    id: "procurement.stock.review_internal",
    department: "procurement",
    capability: "procurement.request.create",
    authorityFloor: "manager_approval",
    reversible: true,
    automaticSafe: false,
    internalOnly: true,
    description: "Raise an internal review of low stock. Creates no purchase order and commits no spend.",
  },
  {
    id: "assets.document.schedule_renewal_internal",
    department: "assets",
    capability: "operations.fleet.manage",
    authorityFloor: "manager_approval",
    reversible: true,
    automaticSafe: false,
    internalOnly: true,
    description: "Raise an internal task to renew an expiring vehicle document. Renews nothing itself.",
  },
  {
    id: "legal.obligation.escalate_internal",
    department: "legal",
    capability: "legal.compliance.manage",
    authorityFloor: "specialist_approval",
    reversible: true,
    automaticSafe: false,
    internalOnly: true,
    description: "Raise an internal task for a human reviewer on an expiring legal obligation. Gives no legal advice.",
  },
  {
    id: "providers.provider.review_internal",
    department: "providers",
    capability: "procurement.service_provider.manage",
    authorityFloor: "manager_approval",
    reversible: true,
    automaticSafe: false,
    internalOnly: true,
    description: "Raise an internal review of a provider whose compliance or insurance has lapsed. Engages nobody.",
  },
  {
    id: "system.health.investigate_internal",
    department: "system",
    capability: "operations.task.manage",
    authorityFloor: "automatic",
    reversible: true,
    automaticSafe: true,
    internalOnly: true,
    description: "Raise an internal investigation of a system or provider health signal.",
  },
] as const;

/**
 * Which catalogue entries can serve a suggested category, within a department.
 *
 * The mapping is data, not code branching on a department name — that is what keeps the
 * kernel domain-agnostic. Adding a department means adding entries, never editing the kernel.
 */
const CATEGORY_ACTIONS: Record<ActionCategory, readonly string[]> = {
  review: [
    "finance.invoice.flag_for_review", "workforce.capacity.review_allocation",
    "objectives.objective.review_internal", "marketing.campaign.review_internal",
    "procurement.stock.review_internal", "providers.provider.review_internal",
    "ops.task.create_internal",
  ],
  chase: [
    "ops.task.request_progress_update", "crm.followup.draft_for_human",
    "governance.directive.chase_internal", "finance.invoice.flag_for_review",
  ],
  reassign: ["workforce.capacity.review_allocation"],
  escalate: [
    "ops.task.escalate_internal", "governance.directive.chase_internal",
    "legal.obligation.escalate_internal", "assets.document.schedule_renewal_internal",
    "finance.invoice.flag_for_review",
  ],
  schedule: [
    "assets.document.schedule_renewal_internal", "legal.obligation.escalate_internal",
    "ops.task.create_internal",
  ],
  investigate: ["system.health.investigate_internal", "ops.task.create_internal"],
  none: [],
};

export function actionById(id: string): DomainAction | null {
  return ACTION_CATALOGUE.find((a) => a.id === id) ?? null;
}

/**
 * The single action this department should propose for this category.
 *
 * Returns null when nothing registered fits — which is a legitimate answer, and becomes a
 * clarification for a human rather than an improvised action.
 */
export function actionFor(department: Department, category: ActionCategory): DomainAction | null {
  const candidates = CATEGORY_ACTIONS[category] ?? [];
  // Prefer an entry belonging to the observing department; fall back to a generic one.
  const own = candidates.map(actionById).find((a) => a && a.department === department);
  if (own) return own;
  return candidates.map(actionById).find((a): a is DomainAction => a !== null) ?? null;
}

/** Every action R1 registers is internal-only. Asserted so a future addition cannot slip. */
export function catalogueIsInternalOnly(): boolean {
  return ACTION_CATALOGUE.every((a) => a.internalOnly === true);
}
