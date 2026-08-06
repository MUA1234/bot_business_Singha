/**
 * Approved INTERNAL WhatsApp message templates (NEXT_PHASE_DEVELOPER_BRIEF §WP4.7).
 *
 * These are the staff-facing notifications the AI manager may send through the outbox:
 * task assignment, estimate request, overdue reminder, clarification, verification
 * request, escalation. Pure builders — the outbox worker actually sends them.
 *
 * Meta's 24-hour customer-service window (§WP4.8): outside an open session you may only
 * send a pre-approved TEMPLATE message, not free text. Each builder declares `kind`:
 *   - "template" — safe to send anytime (must map to an approved Meta template name);
 *   - "session"  — free text, only valid inside an open 24h session.
 * Internal staff reminders are modelled as approved templates so they are deliverable
 * outside a session. `templateName` is the Meta-registered name to wire at send time.
 */
export type TemplateKind = "template" | "session";

export type InternalTemplateId =
  | "task_assignment"
  | "estimate_request"
  | "overdue_reminder"
  | "clarification"
  | "verification_request"
  | "escalation";

export interface BuiltMessage {
  id: InternalTemplateId;
  kind: TemplateKind;
  templateName: string; // Meta-approved template name to register/use
  body: string; // rendered text (also the template body preview)
}

const REGISTRY: Record<InternalTemplateId, { templateName: string; kind: TemplateKind }> = {
  task_assignment: { templateName: "singha_task_assignment", kind: "template" },
  estimate_request: { templateName: "singha_estimate_request", kind: "template" },
  overdue_reminder: { templateName: "singha_overdue_reminder", kind: "template" },
  clarification: { templateName: "singha_clarification", kind: "template" },
  verification_request: { templateName: "singha_verification_request", kind: "template" },
  escalation: { templateName: "singha_escalation", kind: "template" },
};

function build(id: InternalTemplateId, body: string): BuiltMessage {
  const meta = REGISTRY[id];
  return { id, kind: meta.kind, templateName: meta.templateName, body };
}

export interface TaskRef {
  title: string;
  taskUrl?: string;
  dueDate?: string | null;
}

export const InternalTemplates = {
  taskAssignment(name: string, task: TaskRef): BuiltMessage {
    return build(
      "task_assignment",
      `Hi ${name}, a task has been assigned to you: "${task.title}"${task.dueDate ? ` (due ${task.dueDate})` : ""}.` +
        `${task.taskUrl ? ` Open: ${task.taskUrl}` : ""} Please accept and add your estimate.`,
    );
  },
  estimateRequest(name: string, task: TaskRef): BuiltMessage {
    return build("estimate_request", `Hi ${name}, please submit your estimated hours and expected completion date for "${task.title}".`);
  },
  overdueReminder(name: string, task: TaskRef): BuiltMessage {
    return build("overdue_reminder", `Hi ${name}, "${task.title}"${task.dueDate ? ` was due ${task.dueDate}` : " is overdue"}. Please update its status or report a blocker.`);
  },
  clarification(name: string, task: TaskRef, question: string): BuiltMessage {
    return build("clarification", `Hi ${name}, a question on "${task.title}": ${question}`);
  },
  verificationRequest(managerName: string, task: TaskRef): BuiltMessage {
    return build("verification_request", `Hi ${managerName}, "${task.title}" is ready for your verification.${task.taskUrl ? ` Review: ${task.taskUrl}` : ""}`);
  },
  escalation(managerName: string, task: TaskRef, reason: string): BuiltMessage {
    return build("escalation", `Hi ${managerName}, "${task.title}" needs attention: ${reason}.`);
  },
};

/** All approved internal template names (for registration / validation). */
export function approvedTemplateNames(): string[] {
  return Object.values(REGISTRY).map((r) => r.templateName);
}
