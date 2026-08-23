/**
 * GOV-002 — Directive acknowledgement and escalation.
 *
 * Management directives may carry an optional escalation chain. Unacknowledged
 * directives past their response window are advanced up the chain by a cron sweep,
 * with each transition recorded as an audit event. Once the chain is exhausted the
 * directive becomes overdue.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateDirectiveEscalation } from "@/modules/governance/directive-escalation";

const PAGE = "src/app/app/admin/directives/page.tsx";
const ACTIONS = "src/app/app/admin/directives/actions.ts";
const MIGRATION = "src/db/migrations/0099_directive_escalation.sql";
const HELPER = "src/modules/governance/directive-escalation.ts";
const CRON = "src/app/api/cron/directive-escalation/route.ts";

describe("GOV-002 — Directive acknowledgement and escalation", () => {
  const page = readFileSync(PAGE, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");
  const helper = readFileSync(HELPER, "utf8");
  const cron = readFileSync(CRON, "utf8");

  it("extends management_directives with escalation tracking in the migration", () => {
    expect(migration).toContain("escalation_chain jsonb");
    expect(migration).toContain("escalation_level int");
    expect(migration).toContain("escalated_at timestamptz");
    expect(migration).toContain("escalation_reason text");
    expect(migration).toContain("escalated_to uuid");
  });

  it("adds 'escalated' to the status check constraint", () => {
    expect(migration).toContain("management_directives_status_check");
    expect(migration).toContain("'escalated'");
  });

  it("updates RLS so the current escalated_to can see and update the directive", () => {
    expect(migration).toContain("escalated_to = auth.uid()");
  });

  it("has a pure escalation decision helper", () => {
    expect(helper).toContain("export function evaluateDirectiveEscalation");
    expect(helper).toContain("management_directive.escalated");
    expect(helper).toContain("management_directive.overdue");
  });

  it("has a CRON_SECRET-gated cron route that updates rows and writes audit events", () => {
    expect(cron).toContain("CRON_SECRET");
    expect(cron).toContain("timingSafeEqual");
    expect(cron).toContain("management_directives");
    expect(cron).toContain("evaluateDirectiveEscalation");
    expect(cron).toContain("management_directive.escalated");
    expect(cron).toContain("management_directive.overdue");
    expect(cron).toContain("writeAudit");
  });

  it("exposes an escalation-chain input on the new-directive form", () => {
    expect(page).toContain('name="escalation_chain"');
    expect(page).toContain("Escalation chain");
  });

  it("shows escalation level / recipient and overdue badges in the directives list", () => {
    expect(page).toContain("escalation_level");
    expect(page).toContain("escalated_to");
    expect(page).toContain("overdue");
  });

  it("provides a manual escalate action and keeps audited acknowledge/close actions", () => {
    expect(actions).toContain("export async function escalateDirective");
    expect(actions).toContain('action: "management_directive.escalated"');
    expect(actions).toContain("export async function acknowledgeDirective");
    expect(actions).toContain("export async function closeDirective");
  });

  it("escalates a directive one level when the response window has expired", () => {
    const chain = ["user-a", "user-b", "user-c"];
    const directive = {
      id: "dir-1",
      status: "issued" as const,
      response_required_by: "2026-01-01T00:00:00.000Z",
      escalation_chain: chain,
      escalation_level: 0,
    };
    const decision = evaluateDirectiveEscalation(directive, new Date("2026-01-02T00:00:00.000Z"));
    expect(decision).not.toBeNull();
    expect(decision?.newStatus).toBe("escalated");
    expect(decision?.escalation_level).toBe(1);
    expect(decision?.escalated_to).toBe("user-a");
    expect(decision?.auditAction).toBe("management_directive.escalated");
    expect(decision?.escalation_reason).toContain("2026-01-01T00:00:00.000Z");
  });

  it("escalates to the next level on a subsequent cron run", () => {
    const chain = ["user-a", "user-b", "user-c"];
    const directive = {
      id: "dir-1",
      status: "escalated" as const,
      response_required_by: "2026-01-01T00:00:00.000Z",
      escalation_chain: chain,
      escalation_level: 1,
    };
    const decision = evaluateDirectiveEscalation(directive, new Date("2026-01-03T00:00:00.000Z"));
    expect(decision?.newStatus).toBe("escalated");
    expect(decision?.escalation_level).toBe(2);
    expect(decision?.escalated_to).toBe("user-b");
  });

  it("becomes overdue once the escalation chain is exhausted", () => {
    const chain = ["user-a"];
    const directive = {
      id: "dir-1",
      status: "escalated" as const,
      response_required_by: "2026-01-01T00:00:00.000Z",
      escalation_chain: chain,
      escalation_level: 1,
    };
    const decision = evaluateDirectiveEscalation(directive, new Date("2026-01-03T00:00:00.000Z"));
    expect(decision?.newStatus).toBe("overdue");
    expect(decision?.escalation_level).toBe(1);
    expect(decision?.escalated_to).toBeNull();
    expect(decision?.auditAction).toBe("management_directive.overdue");
  });

  it("does not escalate an acknowledged directive", () => {
    const directive = {
      id: "dir-1",
      status: "issued" as const,
      response_required_by: "2026-01-01T00:00:00.000Z",
      escalation_chain: ["user-a"],
      escalation_level: 0,
      acknowledged_at: "2026-01-01T12:00:00.000Z",
    };
    expect(evaluateDirectiveEscalation(directive, new Date("2026-01-02T00:00:00.000Z"))).toBeNull();
  });

  it("does not escalate a directive whose due date is in the future", () => {
    const directive = {
      id: "dir-1",
      status: "issued" as const,
      response_required_by: "2026-01-05T00:00:00.000Z",
      escalation_chain: ["user-a"],
      escalation_level: 0,
    };
    expect(evaluateDirectiveEscalation(directive, new Date("2026-01-02T00:00:00.000Z"))).toBeNull();
  });

  it("becomes overdue when there is no escalation chain", () => {
    const directive = {
      id: "dir-1",
      status: "issued" as const,
      response_required_by: "2026-01-01T00:00:00.000Z",
      escalation_chain: [] as string[],
      escalation_level: 0,
    };
    const decision = evaluateDirectiveEscalation(directive, new Date("2026-01-02T00:00:00.000Z"));
    expect(decision?.newStatus).toBe("overdue");
    expect(decision?.auditAction).toBe("management_directive.overdue");
  });

  it("does not transition an already-overdue directive again", () => {
    const directive = {
      id: "dir-1",
      status: "overdue" as const,
      response_required_by: "2026-01-01T00:00:00.000Z",
      escalation_chain: [] as string[],
      escalation_level: 0,
    };
    expect(evaluateDirectiveEscalation(directive, new Date("2026-01-02T00:00:00.000Z"))).toBeNull();
  });
});
