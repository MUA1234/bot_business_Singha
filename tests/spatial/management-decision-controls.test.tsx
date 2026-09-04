/**
 * The management decision controls — the runtime path for a human approval.
 *
 * Two defects are pinned here.
 *
 * **R2-F-015: the controls were dead.** `Accept suggestion`, `Reject suggestion` and
 * `Assign someone` were `<a href>` links to `/app/command/queue/{id}/accept`, `/reject` and
 * `/assign` — routes that do not exist. The queue offered a person a decision and led them to a
 * 404, which is worse than offering nothing: it teaches people the system is broken and hides that
 * nothing was recorded.
 *
 * **R2-F-016: permission defaulted to yes.** `viewerMayDecide` was optional, the panel never set
 * it, and the component read `!== false` — so an unset flag meant permission. Every viewer,
 * including staff with no approval capability, was shown decision controls.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import DecisionControls from "@/components/spatial/panels/DecisionControls";
import { evidenceDigest } from "@/components/spatial/panels/evidence-digest";

const CONTROLS_SOURCE = readFileSync(
  "src/components/spatial/panels/DecisionControls.tsx",
  "utf8",
);
const CONTENT_SOURCE = readFileSync(
  "src/components/spatial/panels/ManagementQueuePanelContent.tsx",
  "utf8",
);
const PANEL_SOURCE = readFileSync(
  "src/components/spatial/panels/ManagementQueuePanel.tsx",
  "utf8",
);
const ACTION_SOURCE = readFileSync("src/app/app/_actions/management-decision.ts", "utf8");
// The refusal wording lives in its own module: a `"use server"` file may only export async
// functions, so the pure lookup could not stay beside the action.
const MESSAGES_SOURCE = readFileSync("src/app/app/_actions/decision-messages.ts", "utf8");

const render = (over: Partial<Parameters<typeof DecisionControls>[0]> = {}) =>
  renderToString(
    <DecisionControls
      itemId="item-1"
      seenState="awaiting_approval"
      seenActionId="ops.task.create_internal"
      seenEvidenceDigest="digest-1"
      seenParameterDigest={null}
      mayDecide
      {...over}
    />,
  ).replace(/<!-- -->/g, "");

describe("R2-F-016 — permission fails closed", () => {
  it("shows no controls, and says why, when the viewer may not decide", () => {
    const html = render({ mayDecide: false });
    expect(html).toContain("may not decide it");
    expect(html).not.toContain('data-testid="mq-approve"');
    expect(html).not.toContain('data-testid="mq-reject"');
  });

  it("the panel treats an UNSET flag as no", () => {
    // `!== false` made "not stated" mean permission, and the server never stated it.
    expect(CONTENT_SOURCE).not.toContain("viewerMayDecide !== false");
    expect(CONTENT_SOURCE).toContain("viewerMayDecide === true");
  });

  it("the server resolves it from the real capability, and fails closed on error", () => {
    expect(PANEL_SOURCE).toContain("let viewerMayDecide = false;");
    expect(PANEL_SOURCE).toContain(`db.rpc("has_capability"`);
    expect(PANEL_SOURCE).toContain(`capability: "approve"`);
    expect(PANEL_SOURCE).toContain(`capability: "reject"`);
    // A throw must not become permission.
    const block = PANEL_SOURCE.slice(
      PANEL_SOURCE.indexOf("let viewerMayDecide = false;"),
      PANEL_SOURCE.indexOf("data = {"),
    );
    expect(block).toContain("} catch {");
    expect(block).toContain("viewerMayDecide = false;");
  });
});

describe("R2-F-015 — every displayed control is really connected", () => {
  it("no dead link to a route that does not exist survives", () => {
    for (const dead of ["/accept", "/reject", "/assign"]) {
      expect(
        CONTENT_SOURCE.includes(`/app/command/queue/\${itemId}${dead}`),
        `dead link ${dead} must be gone`,
      ).toBe(false);
    }
  });

  it("the controls call the decision server action", () => {
    expect(CONTROLS_SOURCE).toContain("recordManagementDecision");
    expect(CONTROLS_SOURCE).toContain('from "@/app/app/_actions/management-decision"');
  });

  it("renders real buttons rather than navigation", () => {
    const html = render();
    expect(html).toContain('data-testid="mq-approve"');
    expect(html).toContain('data-testid="mq-reject"');
    expect(html).not.toContain("<a ");
  });
});

describe("the decision is bound to what the person saw", () => {
  it("submits the state, action and evidence digest it was rendered with", () => {
    expect(CONTROLS_SOURCE).toContain("seenState: props.seenState");
    expect(CONTROLS_SOURCE).toContain("seenActionId: props.seenActionId");
    expect(CONTROLS_SOURCE).toContain("seenEvidenceDigest: props.seenEvidenceDigest");
  });

  it("uses one idempotency key per item and decision, so a double click is a retry", () => {
    expect(CONTROLS_SOURCE).toContain("idempotencyKey: `${props.itemId}:${decision}`");
  });

  it("the panel supplies the digest of the evidence it actually rendered", () => {
    expect(PANEL_SOURCE).toContain("evidenceDigest: evidenceDigest(");
  });
});

describe("approval is not execution, and the interface says so", () => {
  it("states that approving does not carry the action out", () => {
    expect(render()).toContain("Approving records a decision. It does not carry the action out.");
  });

  it("warns BEFORE the click when there is no handler for the action", () => {
    // 14 of 15 registered actions have no executable handler, so approving them is real and
    // recorded but cannot be carried out. Saying so afterwards would be too late to matter.
    expect(CONTROLS_SOURCE).toContain("approvedWouldBeUnavailable");
    expect(CONTROLS_SOURCE).toContain(
      "There is no automated handler for this action, so someone has to carry it out.",
    );
  });

  it("the panel decides that from the canonical action id", () => {
    expect(CONTENT_SOURCE).toContain(
      `item.proposedAction !== "ops.task.create_internal"`,
    );
  });

  it("offers no execute control anywhere", () => {
    for (const forbidden of ["Execute", "Run now", "Carry out"]) {
      expect(CONTROLS_SOURCE.includes(forbidden), forbidden).toBe(false);
    }
  });
});

describe("refusals are shown honestly", () => {
  it("has wording for every refusal the boundary can return", () => {
    // A refusal with no message would render as a silent no-op, which is how a person concludes
    // their decision was recorded when it was not.
    for (const refusal of [
      "unauthenticated", "not_found", "insufficient_capability", "unresolved_authority",
      "reason_required", "stale_item", "action_changed", "evidence_changed",
      "state_does_not_admit_decision", "conflicting_retry", "unavailable",
    ]) {
      expect(MESSAGES_SOURCE.includes(`${refusal}:`), `no message for ${refusal}`).toBe(true);
    }
  });

  it("distinguishes a stale screen from a lack of permission, in words", () => {
    expect(MESSAGES_SOURCE).toContain("Someone changed this while you were looking at it");
    expect(MESSAGES_SOURCE).toContain("You do not have permission to decide this");
    expect(MESSAGES_SOURCE).toContain("The evidence changed since this was recommended");
  });

  it("an unknown refusal does not leak a raw database message", () => {
    expect(MESSAGES_SOURCE).toContain("That decision could not be recorded.");
    // The detail is logged, not returned to the browser.
    expect(ACTION_SOURCE).toContain('event: "management_decision.rpc_failed"');
  });

  it("reports an unreachable database as `unavailable`, not as a refusal", () => {
    // "We could not ask" and "the answer is no" are different things to tell someone.
    expect(ACTION_SOURCE).toContain(`refusal: "unavailable"`);
  });
});

describe("the runtime path uses the authenticated client", () => {
  it("never uses the admin client", () => {
    expect(ACTION_SOURCE).toContain("supabaseServer()");
    // Asserted on the CODE, with comments stripped. The file explains at length why the admin
    // client is wrong here, and a test that forbade the words would forbid the explanation —
    // which is how a codebase ends up unable to say why it does something.
    const code = ACTION_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("supabaseAdmin");
    expect(code).toContain("supabaseServer()");
  });

  it("sends no company, membership, actor or authority", () => {
    const call = ACTION_SOURCE.slice(
      ACTION_SOURCE.indexOf("db.rpc("),
      ACTION_SOURCE.indexOf("if (error)"),
    );
    for (const forbidden of ["company", "membership", "actor", "authority"]) {
      expect(call.includes(forbidden), `must not send ${forbidden}`).toBe(false);
    }
  });

  it("re-reads from the database after a decision rather than patching state", () => {
    expect(ACTION_SOURCE).toContain("revalidatePath");
  });
});

describe("accessibility", () => {
  it("labels the reason field and ties it to its control", () => {
    const html = render();
    expect(html).toContain('for="mq-reason-item-1"');
    expect(html).toContain('id="mq-reason-item-1"');
  });

  it("announces the outcome to assistive technology", () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("disables reject until a reason is given, rather than failing after the click", () => {
    const html = render();
    // Rendered with an empty reason, so reject starts disabled.
    const reject = html.slice(html.indexOf('data-testid="mq-reject"') - 200);
    expect(reject).toContain("disabled");
  });

  it("uses the existing touch-target class rather than a new one", () => {
    expect(CONTROLS_SOURCE).toContain("mq-touch-target");
  });
});

describe("the evidence digest matches the SQL definition", () => {
  it("is empty-safe", () => {
    expect(evidenceDigest([])).toBe("empty");
  });

  it("orders by the TUPLE, not by the joined string", () => {
    // ('a','b:c') and ('a:b','c') sort differently as tuples than as "a:b:c" strings. Only the
    // tuple order is what PostgreSQL's `order by source_table, source_id` does.
    const a = evidenceDigest([
      { sourceTable: "a", sourceId: "b:c" },
      { sourceTable: "a:b", sourceId: "c" },
    ]);
    const b = evidenceDigest([
      { sourceTable: "a:b", sourceId: "c" },
      { sourceTable: "a", sourceId: "b:c" },
    ]);
    expect(a).toBe(b);
  });

  it("changes when the content changes", () => {
    const one = evidenceDigest([{ sourceTable: "tasks", sourceId: "t-1" }]);
    const two = evidenceDigest([{ sourceTable: "tasks", sourceId: "t-2" }]);
    const both = evidenceDigest([
      { sourceTable: "tasks", sourceId: "t-1" },
      { sourceTable: "tasks", sourceId: "t-2" },
    ]);
    expect(new Set([one, two, both]).size).toBe(3);
  });
});
