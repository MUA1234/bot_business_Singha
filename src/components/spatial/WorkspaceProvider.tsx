"use client";

import { createContext, useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import type { SpatialWindowState, WorkspaceAction, SpatialLayoutSnapshot } from "./types";
import { createInitialState, workspaceReducer, type WorkspaceState } from "./reducer";

export interface WorkspaceContextValue {
  state: WorkspaceState;
  dispatch: React.Dispatch<WorkspaceAction>;
  /** Persist the current layout to localStorage. */
  saveLayout: () => void;
  /** Restore a previously saved layout. */
  restoreLayout: () => void;
  /** True while the provider is measuring the container and loading persisted state. */
  ready: boolean;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function storageKey(userId: string) {
  return `singha-spatial-layout:${userId}`;
}

function makeSnapshot(state: WorkspaceState, userId: string): SpatialLayoutSnapshot {
  return {
    version: 2,
    windows: state.windows.map((w) => ({ ...w })),
    nextZ: state.nextZ,
    focusedId: state.focusedId,
    reducedMotion: state.reducedMotion,
    flatMode: state.flatMode,
    generatedAt: new Date().toISOString(),
  };
}

function migrateSnapshot(s: Partial<SpatialLayoutSnapshot>): SpatialLayoutSnapshot | null {
  if (!Array.isArray(s.windows)) return null;
  const version = typeof s.version === "number" ? s.version : 1;
  if (version !== 1 && version !== 2) return null;
  return {
    version: 2,
    windows: s.windows as SpatialWindowState[],
    nextZ: typeof s.nextZ === "number" ? s.nextZ : 1,
    focusedId: version === 2 && (typeof s.focusedId === "string" || s.focusedId === null) ? s.focusedId : null,
    reducedMotion: !!s.reducedMotion,
    flatMode: !!s.flatMode,
    generatedAt: typeof s.generatedAt === "string" ? s.generatedAt : new Date().toISOString(),
  };
}

function parseSnapshot(raw: string): SpatialLayoutSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return migrateSnapshot(parsed as Partial<SpatialLayoutSnapshot>);
  } catch {
    return null;
  }
}

export interface InitialWindow {
  state: Omit<SpatialWindowState, "createdAt" | "updatedAt">;
  content: ReactNode;
}

export function WorkspaceProvider({
  userId,
  initialWindows,
  children,
}: {
  userId: string;
  initialWindows?: InitialWindow[];
  children: ReactNode;
}) {
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null);
  const [ready, setReady] = useState(false);

  const initialBounds = useMemo(
    () => bounds ?? { width: typeof window !== "undefined" ? window.innerWidth : 1024, height: typeof window !== "undefined" ? window.innerHeight : 768 },
    [bounds],
  );

  const [state, dispatch] = useReducer(workspaceReducer, null, () => createInitialState(initialBounds));

  // Measure the workspace container.
  useEffect(() => {
    if (!containerRef) return;
    const measure = () => {
      const rect = containerRef.getBoundingClientRect();
      setBounds({ width: rect.width, height: rect.height });
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(containerRef);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [containerRef]);

  // Once bounds are known, hydrate from localStorage and mark ready.
  useEffect(() => {
    if (!bounds || ready) return;
    try {
      const raw = localStorage.getItem(storageKey(userId));
      if (raw) {
        const snapshot = parseSnapshot(raw);
        if (snapshot) {
          dispatch({
            kind: "snapshot",
            windows: snapshot.windows,
            nextZ: snapshot.nextZ,
            focusedId: snapshot.focusedId,
          });
          dispatch({ kind: "setReducedMotion", reducedMotion: snapshot.reducedMotion });
          dispatch({ kind: "setFlatMode", flatMode: snapshot.flatMode });
        }
      }
    } catch {
      // localStorage may be disabled in private mode — degrade gracefully.
    }
    setReady(true);
  }, [bounds, ready, userId]);

  // Open any initial windows provided by the server once the workspace is ready.
  useEffect(() => {
    if (!ready || !initialWindows) return;
    for (const iw of initialWindows) {
      if (state.windows.some((w) => w.id === iw.state.id)) continue;
      dispatch({
        kind: "open",
        window: { ...iw.state, content: iw.content } as any,
      });
    }
  }, [ready, initialWindows, state.windows, dispatch]);

  const saveLayout = useCallback(() => {
    try {
      localStorage.setItem(storageKey(userId), JSON.stringify(makeSnapshot(state, userId)));
    } catch {
      // ignore quota/private-mode errors.
    }
  }, [state, userId]);

  const restoreLayout = useCallback(() => {
    try {
      const raw = localStorage.getItem(storageKey(userId));
      const snapshot = raw ? parseSnapshot(raw) : null;
      if (snapshot) {
        dispatch({
          kind: "snapshot",
          windows: snapshot.windows,
          nextZ: snapshot.nextZ,
          focusedId: snapshot.focusedId,
        });
        dispatch({ kind: "setReducedMotion", reducedMotion: snapshot.reducedMotion });
        dispatch({ kind: "setFlatMode", flatMode: snapshot.flatMode });
      }
    } catch {
      // degrade gracefully.
    }
  }, [userId]);

  const value = useMemo(
    () => ({ state, dispatch, saveLayout, restoreLayout, ready }),
    [state, dispatch, saveLayout, restoreLayout, ready],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      <div ref={setContainerRef} className="spatial-workspace-root">
        {children}
      </div>
    </WorkspaceContext.Provider>
  );
}
