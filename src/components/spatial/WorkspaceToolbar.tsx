"use client";

import { useCallback } from "react";
import { useWorkspace, useWindowActions } from "./useWorkspace";
import { Icon } from "@/components/Icon";

/**
 * Fixed toolbar at the top of the workspace. Provides:
 * - Command palette launcher
 * - Save / restore layout
 * - Reduced-motion toggle
 * - Flat-mode toggle
 * - Close all non-pinned windows
 */
export function WorkspaceToolbar({ onOpenCommandPalette }: { onOpenCommandPalette: () => void }) {
  const { state, dispatch, saveLayout, restoreLayout } = useWorkspace();
  const { closeWindow } = useWindowActions();

  const toggleReducedMotion = useCallback(
    () => dispatch({ kind: "setReducedMotion", reducedMotion: !state.reducedMotion }),
    [dispatch, state.reducedMotion],
  );

  const toggleFlatMode = useCallback(
    () => dispatch({ kind: "setFlatMode", flatMode: !state.flatMode }),
    [dispatch, state.flatMode],
  );

  const closeAllUnpinned = useCallback(() => {
    for (const w of state.windows) {
      if (!w.pinned) closeWindow(w.id);
    }
  }, [state.windows, closeWindow]);

  return (
    <>
      <div className="workspace-toolbar" role="toolbar" aria-label="Workspace tools">
        <div className="toolbar-left">
          <button
            type="button"
            className="toolbar-btn"
            onClick={onOpenCommandPalette}
            aria-label="Open command palette"
            title="Command palette"
          >
            <Icon name="search" size={18} />
            <span className="toolbar-label">Open</span>
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={saveLayout}
            aria-label="Save layout"
            title="Save layout"
          >
            <Icon name="download" size={18} />
            <span className="toolbar-label">Save</span>
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={restoreLayout}
            aria-label="Restore layout"
            title="Restore layout"
          >
            <Icon name="pie-chart" size={18} />
            <span className="toolbar-label">Restore</span>
          </button>
        </div>
        <div className="toolbar-right">
          <button
            type="button"
            className={`toolbar-btn${state.reducedMotion ? " active" : ""}`}
            onClick={toggleReducedMotion}
            aria-pressed={state.reducedMotion}
            aria-label="Toggle reduced motion"
            title="Reduced motion"
          >
            <Icon name="check-circle" size={18} />
            <span className="toolbar-label">Reduced motion</span>
          </button>
          <button
            type="button"
            className={`toolbar-btn${state.flatMode ? " active" : ""}`}
            onClick={toggleFlatMode}
            aria-pressed={state.flatMode}
            aria-label="Toggle flat mode"
            title="Flat mode"
          >
            <Icon name="table" size={18} />
            <span className="toolbar-label">Flat mode</span>
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={closeAllUnpinned}
            aria-label="Close all unpinned windows"
            title="Close all unpinned"
          >
            <Icon name="x" size={18} />
            <span className="toolbar-label">Close all</span>
          </button>
        </div>
      </div>
    </>
  );
}
