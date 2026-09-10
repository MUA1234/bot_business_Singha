/**
 * R2B checkpoint 5 — capability recommendations on the existing spatial management-item window.
 *
 * Renders the REAL component and asserts what the markup actually says. The rules under test are
 * the owner's: the surface must show who is suggested, why, on what evidence, with what
 * availability and what is missing; it must show the no-suitable-candidate state honestly; and
 * it must never read as though the assignment has been made.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  ManagementQueuePanelContent,
  type ManagementQueueData,
  type QueueCandidate,
  type QueueItem,
  type QueueFeedbackEntry,
  type QueueRecommendation,
} from "@/components/spatial/panels/ManagementQueuePanelContent";

const candidate = (over: Partial<QueueCandidate> = {}): QueueCandidate => ({
  membershipId: "m1",
  displayName: "A. Perera",
  role: "assignee",
  candidateType: "staff",
  confidence: 0.82,
  availability: { available: true, onLeave: false, availableHours: 18, capacityStatus: "healthy" },
  capabilities: ["finance.collect"],
  skills: [{ skill: "collections", verified: false }],
  reasons: ["holds finance.collect", "18h free this week (healthy)"],
  missingInformation: [],
  requiresHumanReview: [],
  evidence: [{ sourceTable: "memberships", sourceId: "m1" }],
  delegation: null,
  engagement: null,
  ...over,
});

const recommendation = (over: Partial<QueueRecommendation> = {}): QueueRecommendation => ({
  outcome: "candidates",
  candidates: [candidate()],
  routing: null,
  missingInformation: [],
  signalRuleVersion: "r2b.signals.1",
  ...over,
});

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: "item-1",
  department: "finance",
  summary: "receivable overdue",
  stage: "recommended",
  priority: "critical",
  confidence: 0.9,
  evidence: [{ sourceTable: "customer_invoices", sourceId: "inv-1", facts: { aging_bucket: "d90_plus" } }],
  evidenceQuality: "sufficient",
  proposedAction: "finance.invoice.flag_for_review",
  requiredAuthority: "policy_controlled",
  accountableOwner: null,
  routingReason: null,
  businessDeadline: "2026-05-01",
  reviewBy: null,
  reviewPolicyConfigured: false,
  monitoringState: null,
  timeline: [],
  // Not eligible: these fixtures propose actions that are draft-only, so R2E can never act on
  // them — which is the honest default for almost every item.
  execution: {
    status: "not_eligible" as const,
    refusalReason: null, effectRef: null, at: null, retryable: false,
  },
  // Fail-closed since R2-F-016: a fixture that wants the decision view must ask for it.
  viewerMayDecide: true,
  ...over,
});

const data = (items: QueueItem[]): ManagementQueueData => ({
  items, unobservedDepartments: [], completeSweep: true,
});

/**
 * React SSR inserts `<!-- -->` between adjacent interpolations, so `{a}:{b}` renders as
 * `a<!-- -->:<!-- -->b`. Stripping the markers lets these tests assert what a READER sees
 * rather than what the serialiser emits.
 */
const render = (it_: QueueItem) =>
  renderToString(<ManagementQueuePanelContent data={data([it_])} />).replaceAll("<!-- -->", "");

describe("what the manager is shown", () => {
  it("names the suggested assignee, their availability, capabilities and evidence", () => {
    const html = render(item({ recommendation: recommendation() }));
    expect(html).toContain("A. Perera");
    expect(html).toContain("18h free (healthy)");
    expect(html).toContain("finance.collect");
    expect(html).toContain("memberships:m1");
  });

  it("shows confidence as a statement about the EVIDENCE, not about the person", () => {
    const html = render(item({ recommendation: recommendation() }));
    expect(html).toContain("evidence confidence 82%");
  });

  it("shows NO numeric suitability score or rating beside a person", () => {
    const html = render(item({ recommendation: recommendation() }));
    // A person-level score printed on a screen becomes a rating, and a rating becomes the
    // universal employee rank the owner forbade. Order and reasons carry the meaning instead.
    expect(html).not.toMatch(/suitability/i);
    expect(html).not.toMatch(/score/i);
    expect(html).not.toMatch(/rating/i);
  });

  it("keeps skill provenance visible — an unverified claim never reads as fact", () => {
    const html = render(item({
      recommendation: recommendation({
        candidates: [candidate({ skills: [{ skill: "collections", verified: false }, { skill: "forklift", verified: true }] })],
      }),
    }));
    expect(html).toContain("(unverified claim)");
    expect(html).toContain("(verified)");
  });

  it("states the reasons behind the suggestion", () => {
    const html = render(item({ recommendation: recommendation() }));
    expect(html).toContain("holds finance.collect");
    expect(html).toContain("Why (2)");
  });

  it("states what is MISSING rather than leaving a silent gap", () => {
    const html = render(item({
      recommendation: recommendation({
        candidates: [candidate({ missingInformation: ["no skills are recorded for this person"] })],
        missingInformation: ["capacity snapshot is out of date"],
      }),
    }));
    expect(html).toContain("Missing information");
    expect(html).toContain("no skills are recorded for this person");
    expect(html).toContain("capacity snapshot is out of date");
  });

  it("surfaces anything that needs the manager's own judgement", () => {
    const html = render(item({
      recommendation: recommendation({
        candidates: [candidate({ requiresHumanReview: ["past outcomes point in opposite directions"] })],
      }),
    }));
    expect(html).toContain("Needs your judgement");
    expect(html).toContain("opposite directions");
  });

  it("names the ranking rule version so a suggestion can be challenged", () => {
    const html = render(item({ recommendation: recommendation() }));
    expect(html).toContain("r2b.signals.1");
    expect(html).toContain("disagree");
  });
});

describe("the four roles read differently", () => {
  it("labels an advisor as owning no delivery and holding no authority", () => {
    const html = render(item({
      recommendation: recommendation({ candidates: [candidate({ role: "advisor", displayName: "B. Silva" })] }),
    }));
    expect(html).toContain("guidance only");
    expect(html).toContain("owns no delivery and holds no authority");
  });

  it("shows a delegate's scope and expiry TOGETHER — a scope with no end is not a delegation", () => {
    const html = render(item({
      recommendation: recommendation({
        candidates: [candidate({
          role: "delegate",
          delegation: { fromMembership: "boss", domain: "expense", endsAt: "2026-09-30T00:00:00.000Z" },
        })],
      }),
    }));
    expect(html).toContain("scope expense");
    expect(html).toContain("expires 2026-09-30T00:00:00.000Z");
  });

  it("states plainly that an external consultant gets NO internal access", () => {
    const html = render(item({
      recommendation: recommendation({
        candidates: [candidate({
          role: "external_consultant", candidateType: "external_consultant", capabilities: [],
          engagement: { domains: ["legal"], endsAt: "2026-12-31" },
        })],
      }),
    }));
    expect(html).toContain("NO internal access");
    expect(html).toContain("no internal access");
    expect(html).toContain("scope legal");
  });
});

describe("the no-suitable-candidate state", () => {
  const routed = recommendation({
    outcome: "needs_routing",
    candidates: [],
    routing: {
      department: "procurement",
      reasonCode: "temporarily_unavailable:on_approved_leave",
      detail: "everyone who qualifies is on approved leave on the requested date (3 considered)",
    },
    missingInformation: ["no verified skill record exists"],
  });

  it("says NO SUITABLE CANDIDATE with the precise reason", () => {
    const html = render(item({ recommendation: routed }));
    expect(html).toContain("No suitable candidate");
    expect(html).toContain("everyone who qualifies is on approved leave");
    expect(html).toContain("3 considered");
  });

  it("routes to the DEPARTMENT and never names an administrator or the owner", () => {
    const html = render(item({ recommendation: routed }));
    expect(html).toContain("procurement");
    expect(html).toContain("department for a human to route");
    expect(html).not.toMatch(/administrator|the owner/i);
  });

  it("still offers the human an override", () => {
    const html = render(item({ recommendation: routed }));
    expect(html).toContain("Assignment and routing are not yet available");
    expect(html).toContain("Assignment and routing are not yet available");
  });

  it("distinguishes 'no resolution has been run' from 'nobody is suitable'", () => {
    const notRun = render(item({ recommendation: null }));
    expect(notRun).toContain("No capability recommendation has been run");
    expect(notRun).not.toContain("No suitable candidate");

    const absent = render(item({}));
    expect(absent).toContain("No capability recommendation has been run");
  });
});

describe("the panel never implies the assignment was made", () => {
  it("offers an override on EVERY state and says the decision is the human's", () => {
    for (const rec of [recommendation(), recommendation({ outcome: "needs_routing", candidates: [], routing: { department: "finance", reasonCode: "x", detail: "y" } })]) {
      const html = render(item({ recommendation: rec }));
      // The panel always says the decision is the human's. On a needs_routing item there is no
      // suggestion to approve, so the wording comes from the panel rather than from the controls.
      expect(html).toContain('data-testid="mq-human-decides"');
    }
  });

  it("calls them SUGGESTIONS, never assignments", () => {
    const html = render(item({ recommendation: recommendation() }));
    expect(html).toContain("suggestions only, you decide");
    expect(html).not.toMatch(/has been assigned|was assigned to/i);
  });

  it("links out rather than acting in place — the panel performs nothing", () => {
    const html = render(item({ recommendation: recommendation() }));
    expect(html).not.toContain('href="/app/command/queue/item-1/assign"');
    // No form, no button that could submit from the panel itself.
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="submit"');
  });

  it("keeps the accountable-owner row honest while a suggestion is only a suggestion", () => {
    const html = render(item({ recommendation: recommendation(), accountableOwner: null }));
    expect(html).toContain("Nobody yet");
  });
});

describe("no protected or sensitive attribute reaches the screen", () => {
  it("renders nothing resembling a protected characteristic", () => {
    const html = render(item({ recommendation: recommendation() }));
    // Whole words only. An earlier version of this test used substrings and matched "healthy"
    // (a capacity status) and "manage" (a capability) - it would have failed for the right
    // reason by accident and passed for the wrong one later.
    for (const word of [
      "ethnicity", "race", "religion", "marital", "gender", "disability", "health",
      "age", "salary", "pay", "address", "postcode", "photo", "birth", "dependants",
    ]) {
      expect(html.toLowerCase()).not.toMatch(new RegExp(`\b${word}\b`));
    }
  });
});

describe("existing behaviour is unchanged", () => {
  it("still renders the item's own stage, evidence and deadline rows", () => {
    const html = render(item({ recommendation: recommendation() }));
    expect(html).toContain("Recommended — not yet decided");
    expect(html).toContain("customer_invoices:inv-1");
    expect(html).toContain("2026-05-01");
    expect(html).toContain("proposed only; nothing has been carried out");
  });

  it("renders an item with no recommendation exactly as before, plus one honest line", () => {
    const html = render(item({}));
    expect(html).toContain('data-testid="mq-item"');
    expect(html).toContain('data-testid="mq-candidates-none-run"');
  });
});

describe("human accept, override and reject controls (R2B Decision 3)", () => {
  const withRec = (over: Partial<QueueItem> = {}) =>
    item({ recommendation: recommendation(), ...over });

  it("offers ACCEPT, REJECT and OVERRIDE when a suggestion exists", () => {
    const html = render(withRec());
    expect(html).toContain('data-testid="mq-approve"');
    expect(html).toContain('data-testid="mq-reject"');
    expect(html).toContain('data-testid="mq-human-decides"');
  });

  it("offers only an override when NOBODY is suitable — there is nothing to accept", () => {
    const html = render(withRec({
      recommendation: recommendation({
        outcome: "needs_routing", candidates: [],
        routing: { department: "finance", reasonCode: "capability_missing", detail: "nobody holds it" },
      }),
    }));
    expect(html).toContain('data-testid="mq-human-decides"');
    expect(html).not.toContain('data-testid="mq-approve"');
  });

  it("the controls are real and connected, and still perform no ACTION", () => {
    // This test used to assert every control was a LINK and the markup contained no <button>.
    // That protected a real property — the panel executes nothing — but it did so by requiring
    // the controls to be inert, and they were: the hrefs pointed at routes that were never built
    // (R2-F-015). The controls are now buttons that call the decision server action.
    //
    // The property is therefore asserted directly: a decision is recorded, and the panel says in
    // words that recording it does not carry the action out.
    const html = render(withRec());
    expect(html).toContain('data-testid="mq-approve"');
    expect(html).toContain('data-testid="mq-reject"');
    expect(html).toContain("Approving records a decision. It does not carry the action out.");
    // No dead links remain, and nothing on the panel executes.
    expect(html).not.toContain('href="/app/command/queue/item-1/assign"');
    expect(html).not.toContain('href="/app/command/queue/item-1/accept"');
    expect(html).not.toContain("Execute");
  });

  it("HIDES the controls and the history from a viewer who may not decide", () => {
    const html = render(withRec({ viewerMayDecide: false, feedback: [feedbackEntry()] }));
    expect(html).toContain('data-testid="mq-no-decision-rights"');
    expect(html).not.toContain('data-testid="mq-approve"');
    expect(html).not.toContain('data-testid="mq-human-override"');
    // Private learning inputs are not theirs to see.
    expect(html).not.toContain('data-testid="mq-feedback-list"');
    expect(html).not.toContain("slow to respond");
  });
});

const feedbackEntry = (over: Partial<QueueFeedbackEntry> = {}): QueueFeedbackEntry => ({
  id: "f1",
  event: "outcome_successful",
  actorLabel: "R. Fernando",
  at: "2026-09-02T10:00:00Z",
  reason: "confirmed by re-observation",
  comment: null,
  supersededByCorrection: false,
  ...over,
});

describe("feedback and outcome history", () => {
  it("lists what was recorded, oldest first, with who and when", () => {
    const html = render(item({
      recommendation: recommendation(),
      feedback: [feedbackEntry(), feedbackEntry({ id: "f2", event: "recommendation_rejected" })],
    }));
    expect(html).toContain("Feedback and outcomes (2)");
    expect(html).toContain("outcome successful");
    expect(html).toContain("R. Fernando");
    expect(html).toContain("2026-09-02T10:00:00Z");
  });

  it("keeps a superseded entry VISIBLE and marked, never deleted", () => {
    const html = render(item({
      recommendation: recommendation(),
      feedback: [feedbackEntry({ supersededByCorrection: true, reason: "slow to respond" })],
    }));
    expect(html).toContain("later corrected; kept for the record");
    expect(html).toContain("slow to respond");
  });

  it("renders a comment as TEXT — markup is escaped, never injected", () => {
    const html = render(item({
      recommendation: recommendation(),
      feedback: [feedbackEntry({ comment: "<img src=x onerror=alert(1)>" })],
    }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("says so plainly when nothing has been recorded", () => {
    const html = render(item({ recommendation: recommendation(), feedback: [] }));
    expect(html).toContain("No outcome or feedback has been recorded");
  });

  it("shows history even when no recommendation was ever run", () => {
    const html = render(item({ feedback: [feedbackEntry()] }));
    expect(html).toContain("No capability recommendation has been run");
    expect(html).toContain("Feedback and outcomes (1)");
  });

  it("does NOT display the derived learning signal itself", () => {
    const html = render(item({
      recommendation: recommendation(),
      feedback: [feedbackEntry()],
    }));
    // What was RECORDED is disputable evidence; the fold's output is a number about a person
    // and would recreate the universal rank by another route.
    for (const w of ["weightedSuccessRate", "successRate", "outcomeCount", "confirmedOutcome"]) {
      expect(html).not.toContain(w);
    }
  });
});
