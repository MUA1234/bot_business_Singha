import { describe, it, expect } from "vitest";
import { createInitialState, workspaceReducer } from "@/components/spatial/reducer";
import type { SpatialWindowState } from "@/components/spatial/types";

const bounds = { width: 1920, height: 1080 };

function makeWindow(id: string, x = 0, y = 0): SpatialWindowState {
  return {
    id,
    type: "test",
    title: id,
    x,
    y,
    width: 400,
    height: 300,
    z: 0,
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("workspace reducer", () => {
  it("opens a new window and assigns a z-index", () => {
    const state = createInitialState(bounds);
    const next = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    expect(next.windows).toHaveLength(1);
    expect(next.windows[0]!.z).toBe(1);
    expect(next.focusedId).toBe("a");
    expect(next.nextZ).toBe(2);
  });

  it("focuses a window and moves it to the top", () => {
    let state = createInitialState(bounds);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    state = workspaceReducer(state, { kind: "open", window: makeWindow("b") });
    expect(state.windows[0]!.z).toBe(1);
    expect(state.windows[1]!.z).toBe(2);

    state = workspaceReducer(state, { kind: "focus", id: "a" });
    expect(state.windows[0]!.z).toBe(3);
    expect(state.focusedId).toBe("a");
  });

  it("closes a window and removes focus", () => {
    let state = createInitialState(bounds);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    state = workspaceReducer(state, { kind: "open", window: makeWindow("b") });
    state = workspaceReducer(state, { kind: "close", id: "a" });
    expect(state.windows).toHaveLength(1);
    expect(state.focusedId).toBe("b");
  });

  it("minimises a window and clears focus", () => {
    let state = createInitialState(bounds);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    state = workspaceReducer(state, { kind: "minimise", id: "a" });
    expect(state.windows[0]!.minimised).toBe(true);
    expect(state.focusedId).toBeNull();
  });

  it("maximises a window", () => {
    let state = createInitialState(bounds);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    state = workspaceReducer(state, { kind: "maximise", id: "a" });
    expect(state.windows[0]!.maximised).toBe(true);
    expect(state.focusedId).toBe("a");
  });

  it("restores a minimised window", () => {
    let state = createInitialState(bounds);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    state = workspaceReducer(state, { kind: "minimise", id: "a" });
    state = workspaceReducer(state, { kind: "restore", id: "a" });
    expect(state.windows[0]!.minimised).toBe(false);
    expect(state.windows[0]!.maximised).toBe(false);
    expect(state.focusedId).toBe("a");
  });

  it("moves a window within bounds", () => {
    let state = createInitialState(bounds);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    state = workspaceReducer(state, { kind: "move", id: "a", x: -100, y: 2000 });
    expect(state.windows[0]!.x).toBe(0);
    expect(state.windows[0]!.y).toBeLessThan(bounds.height);
  });

  it("enforces a minimum size on resize", () => {
    let state = createInitialState(bounds);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    state = workspaceReducer(state, { kind: "resize", id: "a", width: 10, height: 10 });
    expect(state.windows[0]!.width).toBeGreaterThanOrEqual(240);
    expect(state.windows[0]!.height).toBeGreaterThanOrEqual(160);
  });

  it("batches arrivals sorted by urgency", () => {
    let state = createInitialState(bounds);
    const arrivals: SpatialWindowState[] = [
      { ...makeWindow("low"), urgency: "background" },
      { ...makeWindow("crit"), urgency: "interrupt" },
      { ...makeWindow("vis"), urgency: "visible" },
    ];
    state = workspaceReducer(state, { kind: "batchArrive", arrivals });
    expect(state.windows).toHaveLength(3);
    // highest urgency should be focused / on top.
    expect(state.focusedId).toBe("crit");
    expect(state.windows.find((w) => w.id === "crit")!.z).toBe(3);
  });

  it("preserves reduced-motion and flat-mode settings", () => {
    let state = createInitialState(bounds);
    state = workspaceReducer(state, { kind: "setReducedMotion", reducedMotion: true });
    state = workspaceReducer(state, { kind: "setFlatMode", flatMode: true });
    expect(state.reducedMotion).toBe(true);
    expect(state.flatMode).toBe(true);
  });

  it("blurs the focused window safely", () => {
    let state = createInitialState(bounds);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    expect(state.focusedId).toBe("a");
    state = workspaceReducer(state, { kind: "blur" });
    expect(state.focusedId).toBeNull();
    state = workspaceReducer(state, { kind: "blur" });
    expect(state.focusedId).toBeNull();
  });

  it("restores focusedId from a snapshot", () => {
    let state = createInitialState(bounds);
    state = workspaceReducer(state, { kind: "open", window: makeWindow("a") });
    state = workspaceReducer(state, { kind: "open", window: makeWindow("b") });
    state = workspaceReducer(state, {
      kind: "snapshot",
      windows: state.windows,
      nextZ: state.nextZ,
      focusedId: "a",
    });
    expect(state.focusedId).toBe("a");
  });

  it("handles many windows with deterministic z-order and focus", () => {
    let state = createInitialState(bounds);
    for (let i = 0; i < 25; i++) {
      state = workspaceReducer(state, { kind: "open", window: makeWindow(String(i)) });
    }
    expect(state.windows).toHaveLength(25);
    expect(state.nextZ).toBe(26);
    expect(state.focusedId).toBe("24");
    const zs = state.windows.map((w) => w.z).sort((a, b) => a - b);
    expect(zs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });
});
