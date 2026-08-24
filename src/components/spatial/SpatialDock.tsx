"use client";

import { useWorkspace, useWindowActions } from "./useWorkspace";
import { Icon } from "@/components/Icon";

/**
 * The dock holds minimised windows and quick-open buttons. It is always reachable,
 * touch-friendly, and never overlaps the active stage.
 */
export function SpatialDock({ companyId, userId }: { companyId: string; userId: string }) {
  const { state } = useWorkspace();
  const { restoreWindow } = useWindowActions();

  const minimised = state.windows.filter((w) => w.minimised);

  return (
    <div className="spatial-dock" role="toolbar" aria-label="Window dock">
      <div className="dock-section">
        {minimised.length === 0 && (
          <span className="dock-empty" aria-hidden="true">
            No minimised windows
          </span>
        )}
        {minimised.map((w) => (
          <button
            key={w.id}
            type="button"
            className="dock-item"
            onClick={() => restoreWindow(w.id)}
            aria-label={`Restore ${w.title}`}
            title={w.title}
          >
            <Icon name={w.priority === "critical" ? "alert-triangle" : "layout"} size={18} />
            <span className="dock-label">{w.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
