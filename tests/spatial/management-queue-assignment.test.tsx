/**
 * What the queue says about giving work to a person.
 *
 * The system RECOMMENDS and never assigns. So the screen offers a suggestion with the evidence
 * behind it, and choosing anyone else is permitted and must be explained — because "the manager
 * knew better" is only reviewable if it was written down.
 *
 * The rule these tests exist for is what the screen must NOT say. A missing control and a
 * deliberately withheld one look identical to the manager in front of it, so every state renders a
 * sentence saying which it is, and only one state renders a button.
 *
 * Hiding the button is not the boundary; the RPC is, and it re-checks the assigner's authority, the
 * target's membership, the target's own capability, their availability and both freshness digests
 * inside its own transaction.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  ManagementQueuePanelContent,
  type ManagementQueueData,
  type QueueAssignment,
  type QueueItem,
} from "@/components/spatial/panels/ManagementQueuePanelContent";
import type { AssignmentState } from "@/app/app/_actions/assignment-messages";

const candidate = (over: Partial<QueueAssignment["candidates"][number]> = {}) => ({
  membershipId: "mem-1",
  label: "member mem-1",
  rank: 1,
  eligibilityDigest: "elig-1",
  reasons: ["holds the operations capability", "has free capacity this week"],
  ...over,
});

const assignment = (over: Partial<QueueAssignment> = {}): QueueAssignment => ({
  state: "assignable",
  candidates: [candidate()],
  assignedToLabel: null,
  conditionDigest: "cond-1",
  ...over,
});

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: "item-1",
  department: "operations",
  summary: "missing estimate",
  stage: "needs_routing",
  priority: "high",
  confidence: 0.9,
  evidence: [{ sourceTable: "tasks", sourceId: "t-1", facts: {} }],
  evidenceQuality: "sufficient",
  proposedAction: "ops.task.create_internal",
  requiredAuthority: "manager_approval",
  accountableOwner: null,
  routingReason: "the task was created unassigned and needs a human to route it",
  businessDeadline: null,
  reviewBy: null,
  reviewPolicyConfigured: false,
  monitoringState: null,
  timeline: [],
  execution: { status: "executed", refusalReason: null, effectRef: "task-9", at: null, retryable: false },
  evidenceDigest: "digest-1",
  assignment: assignment(),
  ...over,
});

const render = (over: Partial<QueueItem> = {}) => {
  const data: ManagementQueueData = {
    items: [item(over)],
    unobservedDepartments: [],
    completeSweep: true,
  };
  return renderToString(
    <ManagementQueuePanelContent data={data} error={null} focusId={null} />,
  );
};

describe("the assignment control appears only where a manager may actually assign", () => {
  it("renders the control when the server resolved the state to assignable", () => {
    const html = render();
    expect(html).toContain('data-testid="mq-assign"');
    expect(html).toContain('data-testid="mq-assignee-select"');
  });

  const withheld: AssignmentState[] = [
    "not_applicable",
    "unavailable",
    "no_effect_yet",
    "capability_missing",
    "state_not_assignable",
    "assigned",
  ];

  it.each(withheld)("renders NO control, and says why, for %s", (state) => {
    const html = render({ assignment: assignment({ state }) });
    expect(html).not.toContain('data-testid="mq-assign"');
    // Every withheld state says something. A silent absence is the failure mode this rules out.
    expect(html).toContain(`data-state="${state}"`);
  });

  it("reports UNAVAILABLE when the assignment data could not be read at all", () => {
    const html = render({ assignment: undefined });
    expect(html).toContain('data-state="unavailable"');
    expect(html).not.toContain('data-testid="mq-assign"');
  });
});

describe("what the screen claims about a recommendation", () => {
  it("marks the top-ranked person as recommended, not as chosen", () => {
    const html = render();
    expect(html).toMatch(/recommended/);
    // Never "assigned to", "will do" or any wording implying the decision is already made.
    expect(html).not.toMatch(/\bwill do\b/i);
  });

  it("shows the evidence behind the suggestion, so it can be argued with", () => {
    const html = render();
    expect(html).toContain('data-testid="mq-candidate-reasons"');
    expect(html).toMatch(/holds the operations capability/);
  });

  it("says plainly when nobody could be recommended, and still allows an assignment", () => {
    const html = render({ assignment: assignment({ candidates: [] }) });
    expect(html).toContain('data-testid="mq-no-candidates"');
    expect(html).toMatch(/Nobody could be recommended/);
    // The control is still there — a manager may assign somebody the resolver could not rank.
    expect(html).toContain('data-testid="mq-assign"');
  });

  it("warns that a reason is required BEFORE the click when nobody was ranked", () => {
    const html = render({ assignment: assignment({ candidates: [] }) });
    expect(html).toMatch(/required — this differs from the recommendation/);
  });

  it("says an assignment does not start the work or solve the problem", () => {
    const html = render();
    expect(html).toContain('data-testid="mq-assignment-caveat"');
    expect(html).toMatch(/does not start the work/i);
    expect(html).toMatch(/does not say the problem is solved/i);
  });

  it("names who holds it once somebody does", () => {
    const html = render({
      assignment: assignment({ state: "assigned", assignedToLabel: "user abcd1234" }),
    });
    expect(html).toMatch(/user abcd1234/);
    expect(html).not.toContain('data-testid="mq-assign"');
  });
});
