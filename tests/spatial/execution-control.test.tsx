/**
 * R2E — the execution control window's presentation.
 *
 * Renders the REAL component. The rules under test are the ones that decide whether an operator is
 * misled about what this system can do to their company: that the disabled state is stated rather
 * than implied by an absence of controls, that a refusal is shown rather than hidden, and that the
 * window offers no way to turn execution on.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import ExecutionControlWindow, {
  type ExecutionAttemptRow,
  type ExecutionPolicyRow,
} from "@/components/spatial/windows/ExecutionControlWindow";

const SOURCE = readFileSync(
  "src/components/spatial/windows/ExecutionControlWindow.tsx",
  "utf8",
);

const POLICIES: ExecutionPolicyRow[] = [
  {
    actionId: "ops.task.create_internal",
    classification: "locally_executable",
    authorityFloor: "manager_approval",
    handler: "ops.task.create_internal.v1",
    rationale: "internal, reversible",
  },
  {
    actionId: "crm.followup.draft_for_human",
    classification: "draft_only",
    authorityFloor: "manager_approval",
    handler: null,
    rationale: "no handler exists",
  },
  {
    actionId: "legal.obligation.escalate_internal",
    classification: "prohibited",
    authorityFloor: "specialist_approval",
    handler: null,
    rationale: "a legal position",
  },
];

const ATTEMPTS: ExecutionAttemptRow[] = [
  {
    id: "a1",
    actionId: "ops.task.create_internal",
    status: "refused",
    refusalReason: "approval_missing",
    effectRef: null,
    createdAt: "2026-09-04T09:00:00.000Z",
  },
];

const render = (over: Partial<Parameters<typeof ExecutionControlWindow>[0]> = {}) =>
  renderToString(
    <ExecutionControlWindow
      globallyEnabled={false}
      companyEnabled={false}
      policies={POLICIES}
      attempts={ATTEMPTS}
      {...over}
    />,
  ).replace(/<!-- -->/g, "");

describe("R2E execution control window — the disabled state is stated, not implied", () => {
  it("says plainly that nothing can be changed", () => {
    const html = render();
    expect(html).toContain("This system cannot make any change");
    // An operator must not have to infer "disabled" from the absence of a button.
    expect(html).toContain("built into this release, not a setting");
  });

  it("shows BOTH switches separately, because they are separate powers", () => {
    const html = render();
    expect(html).toContain("System-wide:");
    expect(html).toContain("This company:");
    expect(html).toContain("agreeing to be observed is not agreeing to be acted upon");
  });

  it("warns when both switches are on", () => {
    const html = render({ globallyEnabled: true, companyEnabled: true });
    expect(html).toContain("This system can make changes for this company");
  });

  it("company enablement alone does not read as enabled", () => {
    const html = render({ globallyEnabled: false, companyEnabled: true });
    expect(html).toContain("This system cannot make any change");
  });
});

describe("R2E execution control window — it cannot turn anything on", () => {
  it("has no enable, execute, run or approve control in the source", () => {
    // A control here would either be a lie — the global switch is a compile-time constant — or a
    // second way in that bypasses the executor's checks.
    const controls = SOURCE.match(/<button[^>]*>/g) ?? [];
    expect(controls.length, "buttons in the window").toBe(1); // the show/hide disclosure toggle
    for (const forbidden of [/onClick=\{[^}]*execute/i, /onClick=\{[^}]*enable/i, /fetch\(/]) {
      expect(forbidden.test(SOURCE), `source must not contain ${forbidden}`).toBe(false);
    }
  });

  it("states that nothing on the screen turns execution on", () => {
    expect(render()).toContain("Nothing on this screen turns execution on");
  });
});

describe("R2E execution control window — what it shows about actions and attempts", () => {
  it("counts the classifications so the majority is visible", () => {
    const html = render();
    expect(html).toContain("1 can run");
    expect(html).toContain("1 draft only");
    expect(html).toContain("1 never");
  });

  it("uses plain words, not code identifiers, for classification", () => {
    // Draft-only rows are collapsed by default — the count line above carries "13 of 15 can only
    // draft", which is the reassurance; the rows themselves are noise until asked for. What must
    // never appear is a raw identifier.
    const html = render();
    expect(html).toContain("Never runs");
    expect(html).toContain("Can run, with approval");
    expect(html).not.toContain("locally_executable");
    expect(html).not.toContain("draft_only");
    expect(html).toContain("manager approval"); // underscores expanded, not shown raw
  });

  it("shows the draft-only rows when they are asked for", () => {
    // The toggle is a client interaction; assert the label exists and the filter is by
    // classification rather than by an arbitrary slice.
    expect(SOURCE).toContain('draft_only: "Drafts only"');
    expect(SOURCE).toContain('p.classification !== "draft_only"');
    expect(render()).toContain("Show all 3 actions");
  });

  it("shows a refusal rather than hiding it", () => {
    const html = render();
    expect(html).toContain("Refused: approval missing");
  });

  it("says so when nothing has been attempted, rather than showing an empty list", () => {
    const html = render({ attempts: [] });
    expect(html).toContain("Nothing has been attempted for this company");
  });
});

describe("R2E execution control window — accessibility", () => {
  it("labels every section and the table", () => {
    const html = render();
    expect(html).toContain('aria-labelledby="exec-state-heading"');
    expect(html).toContain('aria-labelledby="exec-policy-heading"');
    expect(html).toContain('aria-labelledby="exec-attempts-heading"');
    expect(html).toContain("<caption");
  });

  it("does not rely on the status dot alone to convey state", () => {
    // The ● / ○ glyphs are aria-hidden; the words "on"/"off" carry the meaning.
    expect(SOURCE).toContain('aria-hidden="true"');
    const html = render();
    expect(html).toContain("not enabled");
  });

  it("scrolls the table inside its own container rather than the page", () => {
    expect(SOURCE).toContain("overflow-x-auto");
  });

  it("marks the toggle's expanded state", () => {
    expect(render()).toContain("aria-expanded");
  });
});
