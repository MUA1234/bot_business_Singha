"use client";

import { useContext, useCallback, useMemo } from "react";
import { WorkspaceContext } from "./WorkspaceProvider";
import type { SpatialWindowState, SpatialPriority, SpatialUrgency } from "./types";

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}

/** Convenience helpers for common window operations. */
export function useWindowActions() {
  const { dispatch } = useWorkspace();

  const openWindow = useCallback(
    (window: Omit<SpatialWindowState, "createdAt" | "updatedAt" | "z">) => {
      const now = new Date().toISOString();
      dispatch({
        kind: "open",
        window: {
          ...window,
          createdAt: now,
          updatedAt: now,
          z: 0,
        },
      });
    },
    [dispatch],
  );

  const closeWindow = useCallback((id: string) => dispatch({ kind: "close", id }), [dispatch]);
  const focusWindow = useCallback((id: string) => dispatch({ kind: "focus", id }), [dispatch]);
  const minimiseWindow = useCallback((id: string) => dispatch({ kind: "minimise", id }), [dispatch]);
  const maximiseWindow = useCallback((id: string) => dispatch({ kind: "maximise", id }), [dispatch]);
  const restoreWindow = useCallback((id: string) => dispatch({ kind: "restore", id }), [dispatch]);
  const pinWindow = useCallback((id: string, pinned: boolean) => dispatch({ kind: "pin", id, pinned }), [dispatch]);
  const dockWindow = useCallback(
    (id: string, position: "left" | "right" | "bottom" | null) =>
      dispatch({ kind: "dock", id, position }),
    [dispatch],
  );
  const undockWindow = useCallback((id: string) => dispatch({ kind: "undock", id }), [dispatch]);
  const moveWindow = useCallback(
    (id: string, x: number, y: number) => dispatch({ kind: "move", id, x, y }),
    [dispatch],
  );
  const resizeWindow = useCallback(
    (id: string, width: number, height: number) => dispatch({ kind: "resize", id, width, height }),
    [dispatch],
  );
  const setPriority = useCallback(
    (id: string, priority: SpatialPriority, urgency: SpatialUrgency) =>
      dispatch({ kind: "setPriority", id, priority, urgency }),
    [dispatch],
  );
  const batchArrive = useCallback(
    (arrivals: Omit<SpatialWindowState, "createdAt" | "updatedAt" | "z">[]) => {
      const now = new Date().toISOString();
      dispatch({
        kind: "batchArrive",
        arrivals: arrivals.map((w) => ({
          ...w,
          createdAt: now,
          updatedAt: now,
          z: 0,
        })),
      });
    },
    [dispatch],
  );

  return useMemo(
    () => ({
      openWindow,
      closeWindow,
      focusWindow,
      minimiseWindow,
      maximiseWindow,
      restoreWindow,
      pinWindow,
      dockWindow,
      undockWindow,
      moveWindow,
      resizeWindow,
      setPriority,
      batchArrive,
    }),
    [openWindow, closeWindow, focusWindow, minimiseWindow, maximiseWindow, restoreWindow, pinWindow, dockWindow, undockWindow, moveWindow, resizeWindow, setPriority, batchArrive],
  );
}
