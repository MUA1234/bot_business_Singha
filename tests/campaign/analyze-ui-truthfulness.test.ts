/**
 * AIM-003 — the Analyze UI may not claim a routing that did not happen.
 *
 * This inspects the rendered component source for the specific FALSE CLAIM that was there, and
 * asserts the component now renders from the routing summary. It is a narrow, targeted check on a
 * known-bad string rather than a general "does this call that" inference — the false-positive class
 * this program has already been caught by three times.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FORM = "src/app/app/command/analyze/AnalyzeForm.tsx";
const ACTIONS = "src/app/app/command/analyze/actions.ts";

describe("AIM-003 — Analyze UI truthfulness", () => {
  it("the false 'routed for human approval' claim is gone", () => {
    const src = readFileSync(FORM, "utf8");
    expect(src).not.toContain("routed for human approval");
  });

  it("the form renders the durable routing summary", () => {
    const src = readFileSync(FORM, "utf8");
    expect(src).toContain("r.routing.byState");
    expect(src).toContain("r.routing.failed");
  });

  it("it says plainly that nothing was executed and no one was notified", () => {
    const src = readFileSync(FORM, "utf8");
    expect(src).toMatch(/Nothing was executed and no one was notified/);
  });

  it("the action returns a routing summary the UI can render", () => {
    const src = readFileSync(ACTIONS, "utf8");
    expect(src).toContain("routing: RoutingSummary");
    expect(src).toContain("routeCapturedTasks");
  });

  // AIM-002 wiring — the same class of truthfulness defect. "0 tasks captured" without saying the
  // work already exists reads as "nothing was found", which is a different and untrue statement.
  it("the action supplies AIM-002 identity on every proposed task", () => {
    const src = readFileSync(ACTIONS, "utf8");
    expect(src).toContain("taskIdentityPartsForPlan(");
    expect(src).toContain("manualIdentity(contentKey)");
  });

  it("the thread-analysis path supplies identity scoped to the conversation", () => {
    const src = readFileSync("src/management/ai-manager/analyze-conversation.ts", "utf8");
    expect(src).toContain("taskIdentityPartsForPlan(");
    expect(src).toContain("threadIdentity(opts.conversationId)");
    // The thread path must ROUTE what it captures too — it previously did not, so tasks captured
    // from a conversation reached nobody and appeared in no routing state.
    expect(src).toContain("routeCapturedTasks(");
  });

  it("the form reports deduplicated work instead of silently showing zero", () => {
    const src = readFileSync(FORM, "utf8");
    expect(src).toContain("r.deduplicatedTasks");
    expect(src).toMatch(/not created again/);
  });
});
