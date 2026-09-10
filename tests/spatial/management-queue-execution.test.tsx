/**
 * R2E-F-012 — the management queue tells the truth about what R2E did.
 *
 * The record R2E exists to produce was invisible to the people it is for: the queue showed
 * management state and no execution state at all. These tests assert what the panel now says, and —
 * more importantly — what it must never say.
 *
 * The central rule: **there is no execution control here.** Execution is switched off in this
 * build, so a button would either be permanently inert, which teaches people to ignore it, or a
 * second way in that bypasses the executor's boundary, policy, authority, approval, evidence and
 * idempotency checks.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import {
  ManagementQueuePanelContent,
  type ManagementQueueData,
  type QueueExecution,
  type QueueItem,
} from "@/components/spatial/panels/ManagementQueuePanelContent";

const CONTENT_SOURCE = readFileSync(
  "src/components/spatial/panels/ManagementQueuePanelContent.tsx",
  "utf8",
);
const PANEL_SOURCE = readFileSync(
  "src/components/spatial/panels/ManagementQueuePanel.tsx",
  "utf8",
);

const execution = (over: Partial<QueueExecution> = {}): QueueExecution => ({
  status: "none",
  refusalReason: null,
  effectRef: null,
  at: null,
  retryable: false,
  ...over,
});

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: "item-1",
  department: "operations",
  summary: "overdue task",
  stage: "approved",
  priority: "high",
  confidence: 0.9,
  evidence: [{ sourceTable: "tasks", sourceId: "t-1", facts: {} }],
  evidenceQuality: "sufficient",
  proposedAction: "ops.task.create_internal",
  requiredAuthority: "automatic",
  accountableOwner: null,
  routingReason: null,
  businessDeadline: null,
  reviewBy: null,
  reviewPolicyConfigured: false,
  monitoringState: null,
  timeline: [],
  execution: execution(),
  ...over,
});

const data = (items: QueueItem[]): ManagementQueueData => ({
  items,
  unobservedDepartments: [],
  completeSweep: true,
});

const render = (e: Partial<QueueExecution>) =>
  renderToString(
    <ManagementQueuePanelContent data={data([item({ execution: execution(e) })])} />,
  ).replace(/<!-- -->/g, "");

describe("R2E — every execution state is displayed as itself", () => {
  it("distinguishes 'can never run' from 'could run and has not'", () => {
    // The two facts a single "nothing happened" would merge. Reporting an ineligible action as
    // merely disabled would imply that turning the switches on would change it.
    expect(render({ status: "not_eligible" })).toContain("Never runs automatically");
    expect(render({ status: "none" })).toContain("Eligible — nothing attempted");
  });

  it("says when execution is switched off", () => {
    expect(render({ status: "disabled" })).toContain("Automatic execution is switched off");
  });

  it("shows a refusal WITH its reason, in words", () => {
    const html = render({ status: "refused", refusalReason: "evidence_stale", retryable: true });
    expect(html).toContain("Refused");
    expect(html).toContain("evidence stale");
    expect(html).toContain("can be tried again");
  });

  it("shows what an execution actually created", () => {
    const html = render({ status: "executed", effectRef: "task-42" });
    expect(html).toContain("Done");
    expect(html).toContain("created task-42");
  });

  it("shows a claimed attempt as in progress, not as done", () => {
    const html = render({ status: "claimed" });
    expect(html).toContain("In progress");
    expect(html).not.toContain(">Done<");
  });

  it("a failure is not retryable and does not read as nothing having happened", () => {
    const html = render({ status: "failed" });
    expect(html).toContain("Failed");
    expect(html).not.toContain("can be tried again");
    expect(html).not.toContain("nothing attempted");
  });

  it("an unreadable ledger says so rather than showing a reassuring blank", () => {
    // R2D-F-006's lesson in a different place: absence of a record and inability to read the
    // record are different facts, and only one of them is reassuring.
    const html = render({ status: "unavailable" });
    expect(html).toContain("Execution history unavailable");
    expect(html).not.toContain("nothing attempted");
  });

  it("marks each state on the element, so a status cannot be inferred from prose alone", () => {
    for (const status of [
      "not_eligible", "disabled", "none", "claimed", "executed", "refused", "failed", "unavailable",
    ] as const) {
      expect(render({ status }), status).toContain(`data-status="${status}"`);
    }
  });
});

describe("R2E — the queue offers no way to execute anything", () => {
  it("renders no execution, approve, reject or run control", () => {
    const html = render({ status: "none" });
    for (const forbidden of [/<button[^>]*>\s*(Execute|Run|Approve|Reject)/i, /Execute now/i]) {
      expect(forbidden.test(html), `must not render ${forbidden}`).toBe(false);
    }
  });

  it("the execution section contains no interactive element at all", () => {
    // Asserted on the component's SOURCE as well as its output, because a control added behind a
    // condition would not appear in one render.
    const section = CONTENT_SOURCE.slice(
      CONTENT_SOURCE.indexOf("function ExecutionSection"),
      CONTENT_SOURCE.indexOf("function CandidateSection"),
    );
    expect(section.length).toBeGreaterThan(100);
    for (const forbidden of ["<button", "<form", "onClick", "onSubmit", "action="]) {
      expect(section.includes(forbidden), `ExecutionSection must not contain ${forbidden}`).toBe(
        false,
      );
    }
  });
});

describe("R2E — the panel reads execution state honestly", () => {
  it("reads the ledger through the SAME RLS-enforced client as everything else", () => {
    // Never `supabaseAdmin`: a service-role read here would make the company filter the only thing
    // between a bug in it and another company's execution history.
    expect(PANEL_SOURCE).toContain("supabaseReadClient");
    expect(PANEL_SOURCE).not.toContain("supabaseAdmin");
  });

  it("scopes both execution reads to the company, and the attempts read to the loaded items", () => {
    expect(PANEL_SOURCE).toContain(`.from("management_execution_enablement")`);
    expect(PANEL_SOURCE).toContain(`.from("management_execution_attempts")`);
    const attempts = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf("management_execution_attempts"));
    expect(attempts).toContain(`.eq("company_id", companyId)`);
    expect(attempts).toContain(`.in("item_id", ids)`);
  });

  it("treats an unreadable ledger as unavailable rather than failing the whole queue", () => {
    expect(PANEL_SOURCE).toContain("executionUnavailable = true");
  });

  it("decides ineligibility from the POLICY, not from the switches", () => {
    // Order matters: "this can never run automatically" is true regardless of the boundary state.
    const fn = PANEL_SOURCE.slice(
      PANEL_SOURCE.indexOf("function executionFor"),
      PANEL_SOURCE.indexOf("unobservedDepartments:"),
    );
    expect(fn.indexOf("not_eligible")).toBeLessThan(fn.indexOf("bothBoundariesOpen"));
    expect(fn).toContain("classificationFor");
  });

  it("requires BOTH boundaries before reporting an action as merely un-attempted", () => {
    expect(PANEL_SOURCE).toContain(
      "EXECUTION_GLOBALLY_ENABLED && companyExecutionEnabled",
    );
  });
});
