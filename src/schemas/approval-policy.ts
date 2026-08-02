/**
 * Approval-policy schema. Guide §10 (roles / separation of duties) and §18
 * (owner-configured thresholds). Policies are DATA, evaluated by the
 * deterministic engine in src/policy/authority.ts — never by free-text AI.
 */
import { z } from "zod";
import { companyId, currencyCode, decimalString } from "./common";

/** Permissions map 1:1 to guide §10. */
export const permission = z.enum([
  "view",
  "create_draft",
  "edit_draft",
  "upload_evidence",
  "submit_for_approval",
  "approve",
  "reject",
  "post",
  "reconcile",
  "reverse",
  "close_period",
  "reopen_period",
  "export",
  "administer_accounts",
  "change_supplier_bank_details",
  "initiate_payment",
  "authorize_payment",
]);
export type Permission = z.infer<typeof permission>;

export const role = z.enum([
  "staff_submitter",
  "project_manager",
  "finance_reviewer",
  "accountant",
  "payment_initiator",
  "payment_approver",
  "auditor_readonly",
  "system_administrator",
  "owner_management",
]);
export type Role = z.infer<typeof role>;

/**
 * A single approval rule. Evaluated in `priority` order; first match wins.
 * `auto_approve` is only ever honoured for low-risk rules the owner explicitly
 * enabled (guide §18 "small-transaction auto-approval rules, if any").
 */
export const approvalRule = z.object({
  id: z.string().min(1),
  description: z.string(),
  priority: z.number().int(),
  /** Match conditions (all must hold). */
  event_types: z.array(z.string()).nullable().default(null),
  currency: currencyCode.nullable().default(null),
  /** Inclusive amount band in the policy currency. */
  min_amount: decimalString.nullable().default(null),
  max_amount: decimalString.nullable().default(null),
  require_evidence: z.boolean().default(true),
  /** Outcome. */
  auto_approve: z.boolean().default(false),
  required_approver_roles: z.array(role).default(["finance_reviewer"]),
  /** How many distinct approvers are needed (dual control for large amounts). */
  approvals_required: z.number().int().min(0).default(1),
  /** Reject any event carrying these risk flags into auto-approval. */
  block_auto_approve_risk_flags: z.array(z.string()).default([
    "large_amount",
    "unusual",
    "foreign_currency",
    "tax_related",
    "related_party",
    "multi_company",
    "possible_duplicate",
    "prompt_injection_detected",
  ]),
});
export type ApprovalRule = z.infer<typeof approvalRule>;

export const approvalPolicy = z.object({
  company_id: companyId,
  currency: currencyCode,
  version: z.number().int().min(1),
  rules: z.array(approvalRule).min(1),
  /** Actions that can NEVER auto-approve regardless of rules (guide §2 rule 8). */
  never_auto: z
    .array(z.string())
    .default(["change_supplier_bank_details", "initiate_payment", "authorize_payment", "reverse"]),
});
export type ApprovalPolicy = z.infer<typeof approvalPolicy>;
