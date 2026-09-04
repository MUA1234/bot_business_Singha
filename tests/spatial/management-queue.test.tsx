/**
 * Management queue presentation — behavioural tests (R1 checkpoint 5).
 *
 * Renders the REAL component and asserts what the markup says. The single most important
 * rule under test: the surface must never imply that a recommendation has been executed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import {
  ManagementQueuePanelContent,
  type ManagementQueueData,
  type QueueItem,
  type QueueStage,
} from "@/components/spatial/panels/ManagementQueuePanelContent";
import { WINDOW_SPECS, getWindowSpec } from "@/components/spatial/windowSpecs";
import { getWindowRenderer } from "@/components/spatial/WindowRegistry";

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
  timeline: [{ at: "2026-09-02T09:00:00Z", from: null, to: "observed", actorType: "system", reason: "detected" }],
  // `finance.invoice.flag_for_review` is draft-only, so R2E can never act on it. That is the
  // honest default for this fixture and for 14 of the 15 registered actions.
  execution: { status: "not_eligible", refusalReason: null, effectRef: null, at: null, retryable: false },
  ...over,
});

const data = (items: QueueItem[], over: Partial<ManagementQueueData> = {}): ManagementQueueData => ({
  items,
  unobservedDepartments: [],
  completeSweep: true,
  ...over,
});

const render = (props: Parameters<typeof ManagementQueuePanelContent>[0]) =>
  renderToString(<ManagementQueuePanelContent {...props} />);

describe("the window is registered in the EXISTING spatial registry", () => {
  it("has a spec and a renderer, like every other window type", () => {
    const spec = getWindowSpec("management-queue");
    expect(spec).toBeTruthy();
    expect(spec!.label).toBe("Management Queue");
    expect(getWindowRenderer("management-queue")).toBeTruthy();
  });

  it("is a singleton at critical default priority — the cockpit surface", () => {
    const spec = getWindowSpec("management-queue")!;
    expect(spec.singleton).toBe(true);
    expect(spec.defaultPriority).toBe("critical");
  });

  it("did not disturb the existing window types", () => {
    for (const t of ["command", "tasks", "approvals", "ai-recommendations", "finance", "system-health"]) {
      expect(getWindowSpec(t), t).toBeTruthy();
    }
    expect(WINDOW_SPECS.length).toBeGreaterThanOrEqual(9);
  });
});

describe("NEVER implies a recommendation was executed", () => {
  it.each([
    ["observed", "Observed"],
    ["recommended", "Recommended — not yet decided"],
    ["approved", "Approved — not yet done"],
    ["assigned", "Assigned"],
    ["completed", "Reported done — not yet verified"],
    ["verified", "Verified"],
  ] as Array<[QueueStage, string]>)("labels %s distinctly and truthfully", (stage, label) => {
    const html = render({ data: data([item({ stage })]) });
    expect(html).toContain(label);
  });

  it("states plainly that a proposed action has NOT been carried out", () => {
    const html = render({ data: data([item({ stage: "recommended" })]) });
    expect(html).toMatch(/proposed only; nothing has been carried out/);
  });

  it("an APPROVED item still says nothing has been done", () => {
    const html = render({ data: data([item({ stage: "approved" })]) });
    expect(html).toContain("Approved — not yet done");
    expect(html).not.toMatch(/\bcompleted\b/i);
  });

  it("a COMPLETED item is not presented as verified", () => {
    const html = render({ data: data([item({ stage: "completed" })]) });
    expect(html).toContain("Reported done — not yet verified");
  });

  it("the six stages produce six DIFFERENT labels — none collapses into another", () => {
    const labels = (["observed", "recommended", "approved", "assigned", "completed", "verified"] as QueueStage[])
      .map((stage) => {
        const html = render({ data: data([item({ stage })]) });
        return /data-testid="mq-stage"[^>]*>(?:<[^>]+>)*([^<]+)/.exec(html)?.[1] ?? "";
      });
    expect(new Set(labels).size).toBe(6);
  });

  it("renders the item stage as a data attribute so it can never be inferred from colour alone", () => {
    const html = render({ data: data([item({ stage: "approved" })]) });
    expect(html).toContain('data-stage="approved"');
  });
});

describe("honest states", () => {
  it("LOADING is announced, not faked as empty", () => {
    const html = render({ data: null, loading: true });
    expect(html).toContain("mq-loading");
    expect(html).toContain('aria-busy="true"');
  });

  it("EMPTY says nothing needs attention — and only when the sweep was complete", () => {
    const html = render({ data: data([]) });
    expect(html).toContain("Nothing needs attention right now");
    expect(html).toContain("Every registered department was observed");
  });

  it("EMPTY with a failed detector refuses to give an all-clear", () => {
    const html = render({
      data: data([], { completeSweep: false, unobservedDepartments: ["finance"] }),
    });
    expect(html).toContain("Some departments were not observed");
    expect(html).toContain("no all-clear can be given");
    expect(html).not.toContain("Every registered department was observed");
  });

  it("PERMISSION DENIED is explained, not blank", () => {
    const html = render({ data: null, permissionDenied: true });
    expect(html).toContain("mq-permission-denied");
    expect(html).toContain("do not have access");
  });

  it("STALE is flagged rather than silently shown as current", () => {
    const html = render({ data: data([item()]), stale: true });
    expect(html).toContain("mq-stale");
    expect(html).toContain("stale");
  });

  it("ERROR distinguishes failure from emptiness and offers retry", () => {
    const html = render({ data: null, error: "connection refused" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("No all-clear can be given");
    expect(html).toContain("connection refused");
    expect(html).toContain('data-action="retry"');
  });

  it("UNAVAILABLE data is not presented as an empty queue", () => {
    const html = render({ data: null });
    expect(html).toContain("This is not the same as an empty queue");
  });

  it("EVIDENCE UNAVAILABLE is stated on the item itself", () => {
    const html = render({ data: data([item({ evidence: [], evidenceQuality: "insufficient" })]) });
    expect(html).toContain("cannot be recommended or approved");
  });

  it("low-confidence and contradictory evidence are shown truthfully", () => {
    expect(render({ data: data([item({ evidenceQuality: "low_confidence" })]) })).toContain("Low confidence");
    expect(render({ data: data([item({ evidenceQuality: "contradictory" })]) })).toContain("Contradictory evidence");
  });
});

describe("accountability, deadlines and routing are truthful", () => {
  it("an unrouted item says nobody holds it — never an administrator's name", () => {
    const html = render({
      data: data([item({ accountableOwner: null, routingReason: "no finance officer available" })]),
    });
    expect(html).toContain("Nobody yet");
    expect(html).toContain("no finance officer available");
    expect(html).not.toMatch(/administrator|admin\b/i);
  });

  it("says 'review timing not configured' rather than inventing one (R1-D-4)", () => {
    const html = render({ data: data([item({ reviewPolicyConfigured: false, reviewBy: null })]) });
    expect(html).toContain("review timing not configured");
  });

  it("shows a configured review time when a policy exists", () => {
    const html = render({
      data: data([item({ reviewPolicyConfigured: true, reviewBy: "2026-09-05T00:00:00Z" })]),
    });
    expect(html).toContain("2026-09-05");
    expect(html).not.toContain("review timing not configured");
  });

  it("shows 'none recorded' when no business deadline came from evidence or policy", () => {
    const html = render({ data: data([item({ businessDeadline: null })]) });
    expect(html).toContain("none recorded");
  });

  it("renders the lifecycle timeline with actor and reason", () => {
    const html = render({ data: data([item()]) });
    expect(html).toContain("mq-timeline");
    expect(html).toContain("observed");
    expect(html).toContain("system");
  });

  it("renders evidence as a REFERENCE, never as copied payload", () => {
    const html = render({ data: data([item()]) });
    expect(html).toContain("customer_invoices");
    expect(html).toContain("inv-1");
    expect(html).toContain("aging_bucket=d90_plus");
  });
});

describe("accessibility and interaction", () => {
  it("actions are real links or buttons — never hover-only", () => {
    const html = render({ data: data([item()]) });
    expect(html).toMatch(/<a[^>]+data-action="review"/);
    // No element depends on :hover to be reachable: every action is in the markup.
    expect(html).not.toMatch(/onmouseover=/i);
  });

  it("evidence and history are disclosure elements, keyboard-operable by default", () => {
    const html = render({ data: data([item()]) });
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
  });

  it("every primary touch target carries the 48px class", () => {
    const html = render({ data: data([item()]) });
    const targets = html.match(/mq-touch-target/g) ?? [];
    expect(targets.length).toBeGreaterThanOrEqual(3); // evidence, history, review
  });

  it("the stylesheet enforces 48x48 targets, visible focus and reduced motion", () => {
    const css = readFileSync("src/components/spatial/styles.css", "utf8");
    expect(css).toMatch(/\.mq-touch-target\s*\{[^}]*min-height:\s*48px/);
    expect(css).toMatch(/\.mq-touch-target\s*\{[^}]*min-width:\s*48px/);
    expect(css).toMatch(/focus-visible/);
    expect(css).toMatch(/prefers-reduced-motion/);
  });

  it("guards against horizontal overflow at narrow widths", () => {
    const css = readFileSync("src/components/spatial/styles.css", "utf8");
    // Long ids must wrap, and the label/value grid must collapse on a narrow viewport.
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/@media \(max-width: 640px\)/);
    expect(css).toMatch(/min-width:\s*0/);
  });

  it("uses no fixed pixel widths that could exceed a 390px viewport", () => {
    const css = readFileSync("src/components/spatial/styles.css", "utf8");
    // Drop media-query CONDITIONS before looking for fixed widths: `@media (max-width: 640px)`
    // is a breakpoint, not a layout width, and counting it is a false positive.
    const mqBlock = css
      .slice(css.indexOf("R1 management queue"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("@media"))
      .join("\n");
    const fixedWidths = mqBlock.match(/(?<![-\w])width:\s*(\d+)px/g) ?? [];
    for (const w of fixedWidths) {
      expect(Number(/(\d+)/.exec(w)![1]), `${w} exceeds a 390px viewport`).toBeLessThanOrEqual(390);
    }
  });

  it("the focused item is marked for the focus window without relying on colour", () => {
    const html = render({ data: data([item()]), focusId: "item-1" });
    expect(html).toContain("mq-row-focused");
  });
});

describe("no sensitive evidence content reaches browser layout storage", () => {
  it("the workspace layout snapshot carries window geometry only, never item content", () => {
    const reducer = readFileSync("src/components/spatial/reducer.ts", "utf8");
    // The persisted snapshot must not reference the queue's data shape at all.
    expect(reducer).not.toMatch(/evidence|management_item|summary|facts/i);
  });

  it("the queue panel writes nothing to storage itself", () => {
    const panel = readFileSync("src/components/spatial/panels/ManagementQueuePanelContent.tsx", "utf8");
    expect(panel).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });
});
