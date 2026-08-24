"use client";

import { useCallback } from "react";
import { useWorkspace } from "./useWorkspace";
import { Icon } from "@/components/Icon";

/**
 * The peripheral rail shows high-priority and visible arrivals that are not yet
 * focused. Critical items are shown at the top with a stronger edge glow.
 */
export function PeripheralRail() {
  const { state, dispatch } = useWorkspace();
  const visible = state.windows.filter(
    (w) => !w.minimised && w.urgency !== "background" && w.priority !== "low",
  );

  const focus = useCallback(
    (id: string) => dispatch({ kind: "focus", id }),
    [dispatch],
  );

  if (visible.length === 0) return null;

  return (
    <div className="peripheral-rail" role="complementary" aria-label="Peripheral arrivals">
      <div className="rail-header">Arrivals</div>
      <div className="rail-items">
        {visible.map((w) => (
          <button
            key={w.id}
            type="button"
            className={`rail-item priority-${w.priority}`}
            onClick={() => focus(w.id)}
            aria-label={`Focus ${w.title}`}
          >
            <Icon name={w.priority === "critical" ? "alert-triangle" : "layout"} size={18} />
            <span className="rail-title">{w.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
