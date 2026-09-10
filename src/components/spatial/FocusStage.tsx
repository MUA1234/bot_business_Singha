"use client";

import { useWorkspace } from "./useWorkspace";
import type { SpatialWindowState } from "./types";

/**
 * The central focus area. Shows the title of the focused window and a subtle
 * drop-zone cue. On large touch displays this is the main active-work area.
 */
export function FocusStage({ focused }: { focused: SpatialWindowState | null }) {
  const { state } = useWorkspace();
  const count = state.windows.length;
  const minimised = state.windows.filter((w) => w.minimised).length;

  return (
    <div className="focus-stage" aria-label="Focus stage">
      <div className="focus-stage-content">
        {focused ? (
          <div className="focus-info">
            <span className="focus-title">{focused.title}</span>
            <span className="focus-meta">{focused.priority} · {focused.urgency}</span>
          </div>
        ) : (
          <div className="focus-info empty">
            <span className="focus-title">No active window</span>
            <span className="focus-meta">Open a record from the command palette or arrivals.</span>
          </div>
        )}
      </div>
      <div className="focus-stage-stats" aria-live="polite">
        <span>{count} open</span>
        {minimised > 0 && <span> · {minimised} minimised</span>}
      </div>
    </div>
  );
}
