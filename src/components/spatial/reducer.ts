"use client";

import type { SpatialWindowState, WorkspaceAction } from "./types";

/** Layout bounds used for clamping new windows. */
export interface WorkspaceBounds {
  width: number;
  height: number;
}

/** Default starting position for a new window, staggered slightly. */
export function defaultPosition(index: number, bounds: WorkspaceBounds) {
  const margin = 48;
  const x = margin + (index % 8) * 24;
  const y = margin + (index % 8) * 24;
  return {
    x,
    y,
    width: Math.min(640, Math.max(320, bounds.width - margin * 2)),
    height: Math.min(480, Math.max(280, bounds.height - margin * 2)),
  };
}

/** Clamp a window inside the given bounds with a small minimum size. */
function clamp(w: SpatialWindowState, bounds: WorkspaceBounds): SpatialWindowState {
  const minW = 240;
  const minH = 160;
  const maxW = Math.max(minW, bounds.width);
  const maxH = Math.max(minH, bounds.height);
  return {
    ...w,
    x: Math.max(0, Math.min(w.x, maxW - minW)),
    y: Math.max(0, Math.min(w.y, maxH - minH)),
    width: Math.max(minW, Math.min(w.width, maxW)),
    height: Math.max(minH, Math.min(w.height, maxH)),
  };
}

/** Find the highest z and return the next one. */
function nextZ(windows: SpatialWindowState[]): number {
  if (windows.length === 0) return 1;
  return Math.max(...windows.map((w) => w.z)) + 1;
}

/** Place a new window in a non-overlapping-ish spot. */
function placeNewWindow(
  window: SpatialWindowState,
  windows: SpatialWindowState[],
  bounds: WorkspaceBounds,
): SpatialWindowState {
  const placed = clamp({ ...window, z: nextZ(windows) }, bounds);
  // stagger by existing count
  const index = windows.length;
  placed.x = 48 + (index % 8) * 24;
  placed.y = 64 + (index % 8) * 24;
  return clamp(placed, bounds);
}

/** Sort windows by priority/urgency for arrival ordering. */
export function urgencyScore(u: string): number {
  switch (u) {
    case "interrupt":
      return 4;
    case "visible":
      return 3;
    case "queued":
      return 2;
    case "background":
    default:
      return 1;
  }
}

export interface WorkspaceState {
  windows: SpatialWindowState[];
  nextZ: number;
  focusedId: string | null;
  reducedMotion: boolean;
  flatMode: boolean;
  bounds: WorkspaceBounds;
}

export function createInitialState(bounds: WorkspaceBounds): WorkspaceState {
  return {
    windows: [],
    nextZ: 1,
    focusedId: null,
    reducedMotion: false,
    flatMode: false,
    bounds,
  };
}

function touchWindow(w: SpatialWindowState): SpatialWindowState {
  return { ...w, updatedAt: new Date().toISOString() };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  const now = new Date().toISOString();

  switch (action.kind) {
    case "open": {
      const existing = state.windows.find((w) => w.id === action.window.id);
      if (existing) {
        // reopen existing window by focusing and restoring it.
        return {
          ...state,
          windows: state.windows.map((w) =>
            w.id === action.window.id
              ? touchWindow({
                  ...w,
                  minimised: false,
                  maximised: false,
                  z: state.nextZ,
                  updatedAt: now,
                })
              : w,
          ),
          nextZ: state.nextZ + 1,
          focusedId: action.window.id,
        };
      }
      const hasValidGeometry =
        action.window.width > 0 &&
        action.window.height > 0 &&
        action.window.x >= 0 &&
        action.window.y >= 0;
      const placed = hasValidGeometry
        ? clamp({ ...action.window, z: state.nextZ }, state.bounds)
        : placeNewWindow(action.window, state.windows, state.bounds);
      const withZ = { ...placed, z: state.nextZ };
      return {
        ...state,
        windows: [...state.windows, touchWindow(withZ)],
        nextZ: state.nextZ + 1,
        focusedId: withZ.id,
      };
    }

    case "close": {
      const nextWindows = state.windows.filter((w) => w.id !== action.id);
      return {
        ...state,
        windows: nextWindows,
        focusedId: state.focusedId === action.id ? nextWindows[nextWindows.length - 1]?.id ?? null : state.focusedId,
      };
    }

    case "focus": {
      const target = state.windows.find((w) => w.id === action.id);
      if (!target || state.focusedId === action.id) return state;
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id ? touchWindow({ ...w, z: state.nextZ }) : w,
        ),
        nextZ: state.nextZ + 1,
        focusedId: action.id,
      };
    }

    case "move": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id
            ? touchWindow(clamp({ ...w, x: action.x, y: action.y }, state.bounds))
            : w,
        ),
      };
    }

    case "resize": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id
            ? touchWindow(clamp({ ...w, width: action.width, height: action.height }, state.bounds))
            : w,
        ),
      };
    }

    case "minimise": {
      const focused = state.focusedId === action.id ? null : state.focusedId;
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id ? touchWindow({ ...w, minimised: true, maximised: false }) : w,
        ),
        focusedId: focused,
      };
    }

    case "maximise": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id
            ? touchWindow({ ...w, maximised: true, minimised: false, docked: null })
            : w,
        ),
        focusedId: action.id,
      };
    }

    case "restore": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id
            ? touchWindow({ ...w, minimised: false, maximised: false })
            : w,
        ),
        focusedId: action.id,
      };
    }

    case "pin": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id ? touchWindow({ ...w, pinned: action.pinned }) : w,
        ),
      };
    }

    case "dock": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id
            ? touchWindow({ ...w, docked: action.position, minimised: true, maximised: false })
            : w,
        ),
      };
    }

    case "undock": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id ? touchWindow({ ...w, docked: null, minimised: false }) : w,
        ),
      };
    }

    case "setPriority": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id
            ? touchWindow({ ...w, priority: action.priority, urgency: action.urgency })
            : w,
        ),
      };
    }

    case "setLoading": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id ? touchWindow({ ...w, loading: action.loading }) : w,
        ),
      };
    }

    case "setStale": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id ? touchWindow({ ...w, stale: action.stale }) : w,
        ),
      };
    }

    case "setPermissionDenied": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id ? touchWindow({ ...w, permissionDenied: action.permissionDenied }) : w,
        ),
      };
    }

    case "setError": {
      return {
        ...state,
        windows: state.windows.map((w) =>
          w.id === action.id ? touchWindow({ ...w, error: action.error }) : w,
        ),
      };
    }

    case "setReducedMotion": {
      return { ...state, reducedMotion: action.reducedMotion };
    }

    case "setFlatMode": {
      return { ...state, flatMode: action.flatMode };
    }

    case "snapshot": {
      return {
        ...state,
        windows: action.windows.map((w) => clamp({ ...w }, state.bounds)),
        nextZ: Math.max(state.nextZ, action.nextZ),
        focusedId: action.focusedId ?? null,
      };
    }

    case "blur": {
      if (state.focusedId === null) return state;
      return { ...state, focusedId: null };
    }

    case "batchArrive": {
      let nextState = state;
      // Sort arrivals by urgency ascending so the highest urgency window is opened last,
      // ends on top and receives focus.
      const arrivals = [...action.arrivals].sort(
        (a, b) => urgencyScore(a.urgency) - urgencyScore(b.urgency),
      );
      for (const arrival of arrivals) {
        nextState = workspaceReducer(nextState, { kind: "open", window: arrival });
      }
      return nextState;
    }

    case "reorder": {
      const order = new Map(action.ids.map((id, i) => [id, i]));
      return {
        ...state,
        windows: [...state.windows].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
      };
    }

    default:
      return state;
  }
}
