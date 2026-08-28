/**
 * Regression — the saved layout must serialise, and must contain NO record content.
 *
 * Finding F-006. `makeSnapshot` shallow-copied each window, which carried the window's
 * rendered React tree in `content`. Every window opened from the server has one, so:
 *
 *   - `JSON.stringify` hit the circular element graph and threw "Converting circular
 *     structure to JSON" before `setItem` ran, and `saveLayout`'s catch — written for
 *     quota and private-mode errors — swallowed it. "Save layout" was silently
 *     inoperative and "Restore layout" had nothing to restore. Confirmed in a real
 *     browser against the running application: all 6 open windows carried content and
 *     `Storage.setItem` was never called.
 *   - Where it did NOT throw, it wrote the rendered record text — customer names, money
 *     amounts, task titles — into localStorage, which is exactly what layout state must
 *     never hold.
 *
 * These tests discriminate. Against the old `{ ...w }` the first THROWS and the third
 * FAILS; against the fix all three pass.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { makeSnapshot } from "@/components/spatial/WorkspaceProvider";
import type { WorkspaceState } from "@/components/spatial/reducer";
import type { SpatialWindowState } from "@/components/spatial/types";

const USER = "11111111-1111-4111-8111-111111111111";
const RECORD_TEXT = "LKR 1,840,000.00 payable to FIXTURE Northwind supplier";

function windowState(overrides: Partial<SpatialWindowState> = {}): SpatialWindowState {
  return {
    id: "w-approvals",
    type: "approvals",
    recordId: "0000f1de-0000-4000-8000-000000000590",
    title: "Approvals",
    x: 20,
    y: 30,
    width: 480,
    height: 360,
    z: 3,
    pinned: false,
    minimised: false,
    maximised: false,
    docked: null,
    priority: "critical",
    urgency: "interrupt",
    loading: false,
    stale: false,
    permissionDenied: false,
    error: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A window as it actually exists after the server opens it: state PLUS a rendered tree.
 *
 * The tree is deliberately built the way React builds one at runtime — a parent holding
 * children that reference it — because a freshly created standalone element is NOT
 * circular and would not reproduce the fault.
 */
function windowWithRenderedContent(): SpatialWindowState {
  // The real content is a rendered React tree whose module/owner graph closes a cycle —
  // observed in the browser as: "Converting circular structure to JSON … property
  // 'default' closes the circle". React elements are frozen, so the cycle is modelled
  // here on a plain wrapper that holds the element AND refers back to itself. What
  // matters for the contract is that `content` is dropped whatever shape it has.
  const tree = createElement("section", null, createElement("p", null, RECORD_TEXT));
  const circular: Record<string, unknown> = { element: tree, text: RECORD_TEXT };
  circular.default = circular;
  return windowState({ content: circular as unknown as SpatialWindowState["content"] });
}

function stateWith(windows: SpatialWindowState[]): WorkspaceState {
  return {
    windows,
    nextZ: windows.length + 1,
    focusedId: windows[0]?.id ?? null,
    reducedMotion: false,
    flatMode: false,
  } as WorkspaceState;
}

describe("spatial layout persistence (F-006)", () => {
  it("a snapshot of windows carrying rendered content is serialisable", () => {
    const snapshot = makeSnapshot(stateWith([windowWithRenderedContent()]), USER);
    // This is the exact call `saveLayout` makes. On the old code it threw, and the
    // swallowing catch meant nothing was ever written.
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it("the snapshot preserves the geometry a layout exists to remember", () => {
    const snapshot = makeSnapshot(stateWith([windowWithRenderedContent()]), USER);
    const w = snapshot.windows.find((x) => x.id === "w-approvals");
    expect(w).toBeTruthy();
    expect(w!.x).toBe(20);
    expect(w!.y).toBe(30);
    expect(w!.width).toBe(480);
    expect(w!.height).toBe(360);
    expect(w!.priority).toBe("critical");
    expect(w!.docked).toBeNull();
  });

  it("the snapshot contains NO rendered record content", () => {
    const snapshot = makeSnapshot(stateWith([windowWithRenderedContent()]), USER);
    for (const w of snapshot.windows) {
      expect(
        Object.prototype.hasOwnProperty.call(w, "content"),
        "the rendered tree was copied into the layout snapshot",
      ).toBe(false);
    }
    const serialised = JSON.stringify(snapshot);
    expect(serialised).not.toContain(RECORD_TEXT);
    expect(serialised).not.toContain("1,840,000");
    expect(serialised).not.toContain("Northwind");
  });
});
