"use client";

import { useState } from "react";
import { useWorkspace, useWindowActions } from "./useWorkspace";
import { WINDOW_SPECS } from "./windowSpecs";
import { Icon } from "@/components/Icon";
import type { WindowTypeSpec } from "./types";

interface SpatialDockProps {
  companyId: string;
  userId: string;
  allowedTypes: string[];
}

function getModuleState(type: string, windows: { id: string; type: string; minimised: boolean }[]) {
  const instance = windows.find((w) => w.type === type);
  return {
    instance,
    isActive: !!instance && !instance.minimised,
    isMinimised: !!instance && instance.minimised,
  };
}

export function SpatialDock({ allowedTypes }: SpatialDockProps) {
  const { state } = useWorkspace();
  const { openWindow, focusWindow, restoreWindow } = useWindowActions();
  const [sheetOpen, setSheetOpen] = useState(false);

  const specs = WINDOW_SPECS.filter((s) => allowedTypes.includes(s.type));
  const minimised = state.windows.filter((w) => w.minimised);

  const openOrFocus = (spec: WindowTypeSpec) => {
    const { instance } = getModuleState(spec.type, state.windows);
    if (instance) {
      if (instance.minimised) restoreWindow(instance.id);
      focusWindow(instance.id);
    } else {
      openWindow({
        id: `win-${spec.type}-${Date.now()}`,
        type: spec.type,
        title: spec.label,
        x: 120,
        y: 120,
        width: spec.defaultWidth,
        height: spec.defaultHeight,
        pinned: false,
        minimised: false,
        maximised: false,
        docked: null,
        priority: spec.defaultPriority,
        urgency: "visible",
        loading: true,
        stale: false,
        permissionDenied: false,
        error: null,
      });
    }
    setSheetOpen(false);
  };

  const renderModuleButton = (spec: WindowTypeSpec, keyPrefix = "dock") => {
    const { isActive, isMinimised } = getModuleState(spec.type, state.windows);
    const label = isMinimised
      ? `${spec.label} (minimised)`
      : isActive
        ? `${spec.label} (open)`
        : `Open ${spec.label}`;
    return (
      <button
        key={`${keyPrefix}-${spec.type}`}
        type="button"
        className={`dock-module${isActive ? " active" : ""}${isMinimised ? " minimised" : ""}`}
        onClick={() => openOrFocus(spec)}
        aria-label={label}
        aria-pressed={isActive || isMinimised}
        title={spec.label}
      >
        <Icon name={spec.icon} size={20} />
        <span className="dock-module-label">{spec.label}</span>
      </button>
    );
  };

  return (
    <div className="spatial-dock" role="toolbar" aria-label="Window dock and module launcher">
      <div className="dock-section dock-modules-row" aria-label="Module launcher">
        {specs.map((spec) => renderModuleButton(spec, "row"))}
      </div>

      <button
        type="button"
        className="dock-mobile-trigger"
        onClick={() => setSheetOpen(true)}
        aria-label="Open module launcher"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
      >
        <Icon name="layout" size={20} />
        <span className="dock-module-label">Modules</span>
      </button>

      {minimised.length > 0 && <div className="dock-divider" aria-hidden="true" />}

      <div className="dock-section dock-minimised" aria-label="Minimised windows">
        {minimised.length === 0 && (
          <span className="dock-empty" aria-hidden="true">
            No minimised windows
          </span>
        )}
        {minimised.map((w) => (
          <button
            key={w.id}
            type="button"
            className="dock-item minimised"
            onClick={() => restoreWindow(w.id)}
            aria-label={`Restore ${w.title}`}
            title={w.title}
          >
            <Icon name={w.priority === "critical" ? "alert-triangle" : "layout"} size={18} />
            <span className="dock-label">{w.title}</span>
          </button>
        ))}
      </div>

      {sheetOpen && (
        <>
          <div
            className="dock-sheet-backdrop"
            onClick={() => setSheetOpen(false)}
            role="presentation"
            aria-hidden="true"
          />
          <div
            className="dock-sheet"
            role="dialog"
            aria-label="Module launcher"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dock-sheet-header">
              <span className="dock-sheet-title">Modules</span>
              <button
                type="button"
                className="dock-sheet-close"
                onClick={() => setSheetOpen(false)}
                aria-label="Close module launcher"
              >
                <Icon name="x" size={20} />
              </button>
            </div>
            <div className="dock-sheet-grid">
              {specs.map((spec) => renderModuleButton(spec, "sheet"))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
