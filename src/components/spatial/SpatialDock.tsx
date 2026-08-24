"use client";

import { useState } from "react";
import { useWorkspace, useWindowActions } from "./useWorkspace";
import { WINDOW_SPECS } from "./windowSpecs";
import { useFocusTrap } from "./useFocusTrap";
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

function Sheet({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useFocusTrap<HTMLDivElement>(open);
  if (!open) return null;
  return (
    <>
      <div className="dock-sheet-backdrop" onClick={onClose} role="presentation" aria-hidden="true" />
      <div
        ref={ref}
        className="dock-sheet"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dock-sheet-header">
          <span className="dock-sheet-title">{title}</span>
          <button
            type="button"
            className="dock-sheet-close"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

export function SpatialDock({ allowedTypes }: SpatialDockProps) {
  const { state } = useWorkspace();
  const { openWindow, focusWindow, restoreWindow } = useWindowActions();
  const [moduleSheetOpen, setModuleSheetOpen] = useState(false);
  const [windowSheetOpen, setWindowSheetOpen] = useState(false);

  const specs = WINDOW_SPECS.filter((s) => allowedTypes.includes(s.type));
  const minimised = state.windows.filter((w) => w.minimised);
  const openWindows = state.windows.filter((w) => !w.minimised);

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
    setModuleSheetOpen(false);
  };

  const focusWindowById = (id: string) => {
    restoreWindow(id);
    focusWindow(id);
    setWindowSheetOpen(false);
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
        onClick={() => setModuleSheetOpen(true)}
        aria-label="Open module launcher"
        aria-haspopup="dialog"
        aria-expanded={moduleSheetOpen}
      >
        <Icon name="layout" size={20} />
        <span className="dock-module-label">Modules</span>
      </button>

      <button
        type="button"
        className="dock-mobile-trigger dock-windows-trigger"
        onClick={() => setWindowSheetOpen(true)}
        aria-label="Open window switcher"
        aria-haspopup="dialog"
        aria-expanded={windowSheetOpen}
        disabled={openWindows.length === 0}
      >
        <Icon name="gauge" size={20} />
        <span className="dock-module-label">Windows</span>
        {openWindows.length > 0 && <span className="dock-badge">{openWindows.length}</span>}
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

      <Sheet title="Module launcher" open={moduleSheetOpen} onClose={() => setModuleSheetOpen(false)}>
        <div className="dock-sheet-grid">
          {specs.map((spec) => renderModuleButton(spec, "sheet"))}
        </div>
      </Sheet>

      <Sheet title="Window switcher" open={windowSheetOpen} onClose={() => setWindowSheetOpen(false)}>
        {openWindows.length === 0 ? (
          <div className="dock-sheet-empty">No open windows</div>
        ) : (
          <div className="dock-sheet-list" role="list">
            {openWindows.map((w) => (
              <button
                key={`switcher-${w.id}`}
                type="button"
                className={`dock-sheet-list-item${state.focusedId === w.id ? " focused" : ""}`}
                onClick={() => focusWindowById(w.id)}
                role="listitem"
                aria-label={`Focus ${w.title}`}
              >
                <Icon name={w.priority === "critical" ? "alert-triangle" : "layout"} size={18} />
                <span className="dock-sheet-list-title">{w.title}</span>
              </button>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}
