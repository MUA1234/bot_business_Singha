/**
 * Spatial workspace — scale, duplicates, and honest states.
 *
 * The first campaign verified the workspace mounts and found the layout-persistence
 * defect (F-006), but did not exercise scale or the states a window must be able to be
 * in when the world goes wrong. These do, against the REAL reducer.
 *
 * The theme throughout is TRUTHFULNESS: a window that is loading, stale, failed or
 * permission-denied must say so. A workspace that shows a confident, empty panel because
 * a request failed is the same class of defect as F-002 and F-003.
 */
import { describe, it, expect } from "vitest";
import {
  workspaceReducer,
  createInitialState,
  defaultPosition,
  type WorkspaceState,
} from "@/components/spatial/reducer";
import { WINDOW_SPECS, getWindowSpec, getRequiredCapabilities } from "@/components/spatial/windowSpecs";
import type { SpatialWindowState } from "@/components/spatial/types";

const BOUNDS = { width: 1440, height: 900 };

function makeWindow(id: string, over: Partial<SpatialWindowState> = {}): SpatialWindowState {
  return {
    id,
    type: "tasks",
    title: id,
    x: 0,
    y: 0,
    width: 420,
    height: 320,
    z: 1,
    pinned: false,
    minimised: false,
    maximised: false,
    docked: null,
    priority: "normal",
    urgency: "queued",
    loading: false,
    stale: false,
    permissionDenied: false,
    error: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...over,
  };
}

function openMany(count: number): WorkspaceState {
  let state = createInitialState(BOUNDS);
  for (let i = 0; i < count; i += 1) {
    const pos = defaultPosition(i, BOUNDS);
    state = workspaceReducer(state, {
      kind: "open",
      window: makeWindow(`w-${i}`, { x: pos.x, y: pos.y }),
    });
  }
  return state;
}

describe("spatial — scale", () => {
  it("holds 25 simultaneously open windows without losing or merging any", () => {
    const state = openMany(25);
    expect(state.windows).toHaveLength(25);
    expect(new Set(state.windows.map((w) => w.id)).size).toBe(25);
  });

  it("gives every window a distinct z-order, so focus is unambiguous", () => {
    const state = openMany(25);
    const zs = state.windows.map((w) => w.z);
    expect(new Set(zs).size, "two windows share a stacking position").toBe(zs.length);
  });

  it("places windows inside the workspace bounds rather than off-screen", () => {
    // A window positioned outside the viewport is unreachable — the user cannot drag
    // something they cannot see.
    for (let i = 0; i < 25; i += 1) {
      const pos = defaultPosition(i, BOUNDS);
      expect(pos.x).toBeGreaterThanOrEqual(0);
      expect(pos.y).toBeGreaterThanOrEqual(0);
      expect(pos.x, `window ${i} starts beyond the right edge`).toBeLessThan(BOUNDS.width);
      expect(pos.y, `window ${i} starts below the bottom edge`).toBeLessThan(BOUNDS.height);
    }
  });

  it("focusing one of 25 raises exactly that window to the top", () => {
    let state = openMany(25);
    state = workspaceReducer(state, { kind: "focus", id: "w-7" });
    const focused = state.windows.find((w) => w.id === "w-7")!;
    const maxZ = Math.max(...state.windows.map((w) => w.z));
    expect(focused.z).toBe(maxZ);
    expect(state.focusedId).toBe("w-7");
  });
});

describe("spatial — duplicate window requests", () => {
  it("opening the SAME window id twice does not create a second window", () => {
    let state = createInitialState(BOUNDS);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("dup") });
    state = workspaceReducer(state, { kind: "open", window: makeWindow("dup") });
    expect(state.windows.filter((w) => w.id === "dup"), "a duplicate request opened a second window").toHaveLength(1);
  });

  it("re-opening an existing window focuses it instead of stacking a copy", () => {
    let state = createInitialState(BOUNDS);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    state = workspaceReducer(state, { kind: "open", window: makeWindow("b") });
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    expect(state.windows).toHaveLength(2);
    expect(state.focusedId).toBe("a");
  });

  it("the same RECORD opened by two different routes is one window when the id matches", () => {
    // Opening a task from the arrivals rail and from the project panel must land on the
    // same window, not two views of one record that can drift apart.
    const recordId = "0000f1de-0000-4000-8000-000000000400";
    let state = createInitialState(BOUNDS);
    state = workspaceReducer(state, { kind: "open", window: makeWindow(`task:${recordId}`, { recordId }) });
    state = workspaceReducer(state, { kind: "open", window: makeWindow(`task:${recordId}`, { recordId }) });
    expect(state.windows).toHaveLength(1);
  });
});

describe("spatial — honest states when the world goes wrong", () => {
  it("a slow request is shown as LOADING, not as an empty result", () => {
    let state = createInitialState(BOUNDS);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("slow") });
    state = workspaceReducer(state, { kind: "setLoading", id: "slow", loading: true });
    expect(state.windows[0]!.loading).toBe(true);
  });

  it("a FAILED request is shown as an error, never as no data", () => {
    // This is the F-002 lesson expressed in the interface: a failure must not render as
    // "there is nothing here".
    let state = createInitialState(BOUNDS);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("failed") });
    state = workspaceReducer(state, { kind: "setError", id: "failed", error: "Could not load approvals" });
    const w = state.windows[0]!;
    expect(w.error).toBe("Could not load approvals");
  });

  it("data that may be out of date is marked STALE", () => {
    let state = createInitialState(BOUNDS);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("stale") });
    state = workspaceReducer(state, { kind: "setStale", id: "stale", stale: true });
    expect(state.windows[0]!.stale).toBe(true);
  });

  it("PERMISSION REMOVED while the window is open flips it to permission-denied", () => {
    let state = createInitialState(BOUNDS);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("secret", { type: "approvals" }) });
    state = workspaceReducer(state, { kind: "setPermissionDenied", id: "secret", permissionDenied: true });
    expect(state.windows[0]!.permissionDenied).toBe(true);
  });

  it("the states are independent — being stale does not imply an error", () => {
    let state = createInitialState(BOUNDS);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("s") });
    state = workspaceReducer(state, { kind: "setStale", id: "s", stale: true });
    const w = state.windows[0]!;
    expect(w.stale).toBe(true);
    expect(w.error).toBeNull();
    expect(w.permissionDenied).toBe(false);
    expect(w.loading).toBe(false);
  });

  it("an action naming an unknown window changes nothing", () => {
    const before = openMany(3);
    const after = workspaceReducer(before, { kind: "setError", id: "does-not-exist", error: "x" });
    expect(after.windows.map((w) => ({ ...w }))).toEqual(before.windows.map((w) => ({ ...w })));
  });
});

describe("spatial — presentation modes", () => {
  it("reduced motion and flat mode are independent switches", () => {
    let state = createInitialState(BOUNDS);
    state = workspaceReducer(state, { kind: "setReducedMotion", reducedMotion: true });
    expect(state.reducedMotion).toBe(true);
    expect(state.flatMode).toBe(false);

    state = workspaceReducer(state, { kind: "setFlatMode", flatMode: true });
    expect(state.reducedMotion).toBe(true);
    expect(state.flatMode).toBe(true);

    state = workspaceReducer(state, { kind: "setReducedMotion", reducedMotion: false });
    expect(state.flatMode, "turning motion back on also cleared flat mode").toBe(true);
  });

  it("neither mode discards any open window", () => {
    let state = openMany(20);
    state = workspaceReducer(state, { kind: "setReducedMotion", reducedMotion: true });
    state = workspaceReducer(state, { kind: "setFlatMode", flatMode: true });
    expect(state.windows).toHaveLength(20);
  });
});

describe("spatial — window capability requirements", () => {
  it("every registered window type declares what it needs", () => {
    expect(WINDOW_SPECS.length).toBeGreaterThan(0);
    for (const spec of WINDOW_SPECS) {
      expect(getWindowSpec(spec.type), `${spec.type} is not resolvable`).toBeTruthy();
      expect(Array.isArray(getRequiredCapabilities(spec.type))).toBe(true);
    }
  });

  it("an unknown window type requires capabilities rather than defaulting to open access", () => {
    // Fail closed: an unregistered type must not resolve to "no capability needed".
    const spec = getWindowSpec("not-a-real-window-type");
    expect(spec).toBeUndefined();
  });
});
