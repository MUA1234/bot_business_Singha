import { describe, it, expect } from "vitest";
import { approvalPolicy, type ApprovalPolicy } from "@/schemas/approval-policy";
import { evaluatePolicy, checkSeparationOfDuties } from "@/policy/authority";

const COMPANY = "22222222-2222-2222-2222-222222222222";

const policy: ApprovalPolicy = approvalPolicy.parse({
  company_id: COMPANY,
  currency: "LKR",
  version: 1,
  rules: [
    {
      id: "small-auto",
      description: "Auto-approve small expenses with evidence",
      priority: 1,
      event_types: ["expense_payment"],
      max_amount: "5000.00",
      require_evidence: true,
      auto_approve: true,
    },
    {
      id: "large-dual",
      description: "Large amounts need two approvers",
      priority: 2,
      min_amount: "100000.00",
      required_approver_roles: ["accountant", "owner_management"],
      approvals_required: 2,
    },
    {
      id: "default",
      description: "Everything else: one finance reviewer",
      priority: 99,
      required_approver_roles: ["finance_reviewer"],
      approvals_required: 1,
    },
  ],
});

describe("Deterministic policy engine (guide §18)", () => {
  it("auto-approves a small expense WITH evidence", () => {
    const d = evaluatePolicy(
      { event_type: "expense_payment", amount: "1500.00", currency: "LKR", has_evidence: true, risk_flags: [] },
      policy,
    );
    expect(d.outcome).toBe("auto_approve");
    expect(d.matched_rule_id).toBe("small-auto");
  });

  it("does NOT auto-approve the same expense without evidence", () => {
    const d = evaluatePolicy(
      { event_type: "expense_payment", amount: "1500.00", currency: "LKR", has_evidence: false, risk_flags: [] },
      policy,
    );
    expect(d.outcome).toBe("require_approval");
  });

  it("blocks auto-approve when a risk flag is present", () => {
    const d = evaluatePolicy(
      { event_type: "expense_payment", amount: "1500.00", currency: "LKR", has_evidence: true, risk_flags: ["unusual"] },
      policy,
    );
    expect(d.outcome).toBe("require_approval");
  });

  it("requires dual control for large amounts", () => {
    const d = evaluatePolicy(
      { event_type: "supplier_payment", amount: "250000.00", currency: "LKR", has_evidence: true, risk_flags: [] },
      policy,
    );
    expect(d.outcome).toBe("require_approval");
    expect(d.approvals_required).toBe(2);
  });

  it("never auto-approves sensitive event types", () => {
    const d = evaluatePolicy(
      { event_type: "authorize_payment", amount: "10.00", currency: "LKR", has_evidence: true, risk_flags: [] },
      policy,
    );
    expect(d.outcome).not.toBe("auto_approve");
  });
});

describe("Separation of duties (guide §10)", () => {
  const approver = { user_id: "u-approver", roles: ["finance_reviewer" as const], permissions: ["approve" as const] };

  it("allows a qualified, independent approver", () => {
    const r = checkSeparationOfDuties(approver, ["finance_reviewer"], {
      submitter_user_id: "u-submitter",
      approver_is_beneficiary: false,
      action: null,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks self-approval of your own submission", () => {
    const r = checkSeparationOfDuties(approver, ["finance_reviewer"], {
      submitter_user_id: "u-approver",
      approver_is_beneficiary: false,
      action: null,
    });
    expect(r.allowed).toBe(false);
  });

  it("blocks approving your own reimbursement (beneficiary)", () => {
    const r = checkSeparationOfDuties(approver, ["finance_reviewer"], {
      submitter_user_id: "u-submitter",
      approver_is_beneficiary: true,
      action: null,
    });
    expect(r.allowed).toBe(false);
  });

  it("blocks an approver lacking the required role/permission", () => {
    const weak = { user_id: "u-x", roles: ["staff_submitter" as const], permissions: [] };
    const r = checkSeparationOfDuties(weak, ["finance_reviewer"], {
      submitter_user_id: "u-submitter",
      approver_is_beneficiary: false,
      action: null,
    });
    expect(r.allowed).toBe(false);
  });
});
