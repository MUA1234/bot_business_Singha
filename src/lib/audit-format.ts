/**
 * Human-readable labels for audit action codes (Architecture V2 change plan §13).
 * Pure and deterministic — used by the admin Audit Log. Action codes are
 * "<entity>.<verb>" (e.g. "journal.posted", "customer_invoice.receipt_recorded").
 */
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const VERB_LABEL: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  deleted: "Deleted",
  posted: "Posted",
  reversed: "Reversed",
  approved: "Approved",
  rejected: "Rejected",
  reimbursed: "Reimbursed",
  assigned: "Assigned",
  activated: "Activated",
  deactivated: "Deactivated",
  password_reset: "Reset password for",
  analyzed: "AI analysed",
};

/** e.g. "journal.posted" → "Posted journal"; "employee.deactivated" → "Deactivated employee". */
export function describeAction(action: string): string {
  const [entityRaw, ...verbParts] = action.split(".");
  const entity = (entityRaw ?? action).replace(/_/g, " ");
  const verbKey = verbParts.join(".");
  const verb = VERB_LABEL[verbKey] ?? cap(verbParts.join(" ").replace(/_/g, " "));
  return verb ? `${verb} ${entity}` : cap(entity);
}
