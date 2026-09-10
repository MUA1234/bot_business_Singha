/**
 * R2F-F-001 — the cockpit shows the management system's own output.
 *
 * The screen the owner looks at first read tasks, capacity, invoices, bills, purchase orders and
 * commitments, and none of what the management kernel itself noticed, recommended or is waiting on
 * a person for.
 *
 * `CommandCentrePanel` is an async server component that opens a Supabase client at module scope,
 * so it cannot be rendered in a unit test without asserting the mock instead of the panel. The
 * QUERY shape is therefore checked against the source — which client, how it is scoped, what it
 * selects — and the DECISION is checked by asking `summariseManagement` questions.
 *
 * That split exists because the first version of this file got it wrong. Every assertion was a
 * source-level `toContain`, and a mutation replacing the whole unavailable-branch condition with
 * `false` passed all eleven of them: both strings were still in the file. Asserting that text is
 * present says nothing about when it is shown, so the decision was extracted into a pure function
 * and is now exercised rather than read.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { summariseManagement } from "@/components/spatial/panels/management-summary";

const SOURCE = readFileSync("src/components/spatial/panels/CommandCentrePanel.tsx", "utf8");

/** The management read, from its comment to the end of the call. */
const READ = SOURCE.slice(
  SOURCE.indexOf("const managementItems = await safeSelect"),
  SOURCE.indexOf('"management_items");') + 20,
);

describe("R2F-F-001 — the cockpit reads real management items", () => {
  it("reads `management_items` at all", () => {
    expect(READ).toContain('.from("management_items")');
  });

  it("uses the RLS-enforced client, never the service role", () => {
    // A service-role read here would make the company filter the only thing between a bug in it
    // and another company's management state.
    expect(SOURCE).toContain("supabaseReadClient");
    expect(SOURCE).not.toContain("supabaseAdmin");
  });

  it("is company-scoped and bounded", () => {
    expect(READ).toContain('.eq("company_id", companyId)');
    expect(READ).toContain(".limit(");
  });

  it("excludes terminal items, so 'open' means open", () => {
    expect(READ).toContain('.not("state", "in", "(verified,rejected,dismissed,expired)")');
  });

  it("selects no evidence, facts, reasons or free text", () => {
    // The cockpit is a summary. Evidence and reasons belong to the queue, behind its own
    // authorisation — a count does not need them, and pulling them here would widen what this
    // screen exposes for no gain.
    for (const forbidden of ["facts", "routing_reason", "reason", "evidence"]) {
      expect(READ.includes(forbidden), `must not select ${forbidden}`).toBe(false);
    }
  });
});

describe("R2F-F-001 — an unread queue is never shown as an empty one", () => {
  it("goes through the same observed-select helper as every other source", () => {
    // `safeSelect` records a failure in `failedSources`, which the panel already reports above
    // every figure. That is what stops a failed read from rendering as a clean bill of health.
    expect(READ).toContain("safeSelect");
    expect(READ).toContain('"management_items"');
  });

  it("the panel renders the unavailable branch from the summary's own verdict", () => {
    // The wording lives in the panel; the DECISION lives in `summariseManagement` and is asserted
    // behaviourally below. This checks only that the panel branches on that verdict rather than
    // recomputing it — two places deciding the same thing is how they come to disagree.
    expect(SOURCE).toContain('management.kind === "unavailable"');
    expect(SOURCE).toContain("Management data unavailable");
    expect(SOURCE).toContain("it is an unread");
    expect(SOURCE).not.toContain("AWAITING_HUMAN");
  });

  it("distinguishes genuinely-nothing-open from unreadable — BEHAVIOURALLY", () => {
    // The earlier version of this test asserted that the file CONTAINED the string "Management
    // data unavailable" and that it appeared before "Nothing open". A mutation that replaced the
    // whole condition with `false` passed all eleven tests, because both strings were still in
    // the file. Asserting presence says nothing about when something is shown.
    expect(summariseManagement([], ["management_items"]).kind).toBe("unavailable");
    expect(summariseManagement([], []).kind).toBe("empty");
    expect(summariseManagement(null, []).kind).toBe("empty");
  });

  it("reports unavailable EVEN WHEN rows came back, because a partial read is not a whole one", () => {
    // The failure check must come first. If it were tested after the rows, a source that failed
    // partway would report whatever it managed to read as the complete picture.
    const rows = [{ department: "finance", state: "recommended" }];
    expect(summariseManagement(rows, ["management_items"]).kind).toBe("unavailable");
  });

  it("a DIFFERENT source failing does not make management unavailable", () => {
    const rows = [{ department: "finance", state: "recommended" }];
    const out = summariseManagement(rows, ["tasks", "customer_invoices"]);
    expect(out.kind).toBe("open");
  });
});

describe("R2F-F-001 — the summary is derived, not asserted", () => {
  it("counts 'waiting on a person' from the STATE", () => {
    const out = summariseManagement(
      [
        { department: "finance", state: "recommended" },
        { department: "finance", state: "awaiting_approval" },
        { department: "operations", state: "needs_routing" },
        { department: "operations", state: "escalated" },
        // Not waiting on anyone: the system is proceeding.
        { department: "operations", state: "assigned" },
        { department: "crm", state: "monitoring" },
      ],
      [],
    );
    expect(out.kind).toBe("open");
    if (out.kind !== "open") return;
    expect(out.total).toBe(6);
    expect(out.waitingOnAPerson).toBe(4);
  });

  it("groups by department, busiest first, with a stable tie-break", () => {
    const out = summariseManagement(
      [
        { department: "operations", state: "assigned" },
        { department: "operations", state: "assigned" },
        { department: "crm", state: "assigned" },
        { department: "finance", state: "assigned" },
      ],
      [],
    );
    if (out.kind !== "open") throw new Error("expected open");
    expect(out.byDepartment).toEqual([["operations", 2], ["crm", 1], ["finance", 1]]);
  });

  it("does not invent a department for a row that has none", () => {
    const out = summariseManagement([{ state: "assigned" }], []);
    if (out.kind !== "open") throw new Error("expected open");
    expect(out.byDepartment).toEqual([["unknown", 1]]);
  });

  it("adds no control, form or action to the cockpit", () => {
    const section = SOURCE.slice(
      SOURCE.indexOf('data-testid="cc-management"'),
      SOURCE.indexOf("THE SIGNATURE COMPOSITION"),
    );
    expect(section.length).toBeGreaterThan(200);
    for (const forbidden of ["<button", "<form", "onClick", "onSubmit"]) {
      expect(section.includes(forbidden), `must not contain ${forbidden}`).toBe(false);
    }
  });
});
