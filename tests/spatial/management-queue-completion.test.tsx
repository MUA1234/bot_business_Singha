/**
 * What the queue says about reporting work complete.
 *
 * The rule that matters is what it must NOT say. A missing control and a deliberately withheld one
 * look identical to the person in front of the screen, so every state below renders a sentence
 * saying which it is — and only one state renders a button.
 *
 * Hiding the button is not the boundary; the RPC is, and it re-checks the assignment, the
 * capability, the task status and the binding inside its own transaction. These tests are about
 * whether the screen tells the truth, not about whether it is secure.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  ManagementQueuePanelContent,
  type ManagementQueueData,
  type QueueCompletion,
  type QueueItem,
} from "@/components/spatial/panels/ManagementQueuePanelContent";
import type { CompletionState } from "@/app/app/_actions/completion-messages";

const completion = (over: Partial<QueueCompletion> = {}): QueueCompletion => ({
  state: "claimable",
  taskId: "task-1",
  linkKind: "originating",
  claimedAt: null,
  ...over,
});

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: "item-1",
  department: "operations",
  summary: "overdue task",
  stage: "monitoring",
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
  execution: { status: "none", refusalReason: null, effectRef: null, at: null, retryable: false },
  evidenceDigest: "digest-1",
  completion: completion(),
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

describe("the completion control appears only for the person whose work it is", () => {
  it("renders the button when the server resolved the state to claimable", () => {
    const html = render();
    expect(html).toContain('data-testid="mq-claim-completion"');
    expect(html).toContain("Report my work complete");
  });

  const withheld: CompletionState[] = [
    "not_applicable",
    "unavailable",
    "task_unassigned",
    "assigned_to_another",
    "task_not_completed",
    "evidence_required",
    "capability_missing",
    "state_not_claimable",
    "claimed_awaiting_verification",
    "verification_unavailable",
    "condition_persists",
    "contradicted",
    "verified_resolved",
  ];

  it.each(withheld)("renders NO button, and says why, for %s", (state) => {
    const html = render({ completion: completion({ state }) });
    expect(html).not.toContain('data-testid="mq-claim-completion"');
    // Every withheld state says something. A silent absence is the failure mode this rules out.
    expect(html).toContain(`data-state="${state}"`);
  });
});

describe("what the wording claims, and does not", () => {
  it("never says the work is done, resolved or closed while it is only reported", () => {
    const html = render({
      completion: completion({ state: "claimed_awaiting_verification", claimedAt: "2026-09-05T09:00:00Z" }),
    });
    expect(html).toMatch(/Nobody has checked/);
    // "Resolved" is the word reserved for a verification that actually happened. A claim that is
    // merely awaiting a check must not borrow it, even in a subordinate clause: people read the
    // words, not the grammar.
    expect(html).not.toMatch(/resolved/i);
    expect(html).not.toMatch(/\bclosed\b/i);
  });

  it("says plainly that a persisting condition is not a success", () => {
    const html = render({ completion: completion({ state: "condition_persists" }) });
    expect(html).toMatch(/the original problem is still there/i);
  });

  it("distinguishes an unverifiable outcome from a resolved one", () => {
    const unavailable = render({ completion: completion({ state: "verification_unavailable" }) });
    expect(unavailable).toMatch(/could not be checked/i);
    expect(unavailable).toMatch(/has not been closed/i);

    const resolved = render({ completion: completion({ state: "verified_resolved" }) });
    expect(resolved).toMatch(/the original problem is resolved/i);
  });

  it("says a claim does not close the item, on the control itself", () => {
    const html = render();
    expect(html).toContain('data-testid="mq-completion-caveat"');
    expect(html).toMatch(/does not close the item/i);
  });

  it("names an EFFECT task as the response, not the problem", () => {
    const html = render({ completion: completion({ linkKind: "effect" }) });
    expect(html).toMatch(/created in response to the problem, not the problem itself/i);
  });

  it("reports UNAVAILABLE when the completion data could not be read at all", () => {
    // `completion` absent entirely — the shape a database without the draft schema produces.
    const html = render({ completion: undefined });
    expect(html).toContain('data-state="unavailable"');
    expect(html).not.toContain('data-testid="mq-claim-completion"');
  });
});
