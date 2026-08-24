"use client";

import { useState } from "react";
import { useWorkspace } from "./useWorkspace";
import { SpatialWindow } from "./SpatialWindow";
import { FocusStage } from "./FocusStage";
import { PeripheralRail } from "./PeripheralRail";
import { SpatialDock } from "./SpatialDock";
import { WorkspaceToolbar } from "./WorkspaceToolbar";
import { SpatialCommandPalette } from "./SpatialCommandPalette";
import { WindowRenderer } from "./WindowRegistry";
import { WindowErrorBoundary } from "./WindowErrorBoundary";
import { useWorkspaceShortcuts } from "./useWorkspaceShortcuts";
import type { SpatialArrival } from "./types";

/**
 * The top-level spatial workspace component. It renders the focus stage, the floating
 * windows, the peripheral arrival rail, the dock, the toolbar, and the command palette.
 */
export function SpatialWorkspace({
  companyId,
  userId,
  allowedTypes,
  initialArrivals,
}: {
  companyId: string;
  userId: string;
  allowedTypes: string[];
  initialArrivals?: SpatialArrival[];
}) {
  const { state, ready } = useWorkspace();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useWorkspaceShortcuts({
    onOpenCommandPalette: () => setPaletteOpen(true),
    onCloseCommandPalette: () => setPaletteOpen(false),
    commandPaletteOpen: paletteOpen,
    allowedTypes,
  });

  if (!ready) {
    return (
      <div className="spatial-workspace loading" aria-busy="true" aria-label="Loading spatial workspace">
        <div className="spatial-loading">Loading workspace…</div>
      </div>
    );
  }

  const focused = state.windows.find((w) => w.id === state.focusedId) ?? null;

  return (
    <div className={`spatial-workspace${state.flatMode ? " flat" : ""}`} aria-label="Spatial operations workspace">
      <WorkspaceToolbar onOpenCommandPalette={() => setPaletteOpen(true)} />
      <FocusStage focused={focused} />
      <div className="spatial-windows" role="region" aria-label="Open windows">
        {state.windows
          .filter((w) => !w.minimised)
          .map((w) => (
            <WindowErrorBoundary key={w.id} windowId={w.id}>
              <SpatialWindow window={w}>
                {w.content ?? (
                  <WindowRenderer
                    windowId={w.id}
                    type={w.type}
                    recordId={w.recordId}
                    title={w.title}
                    companyId={companyId}
                    userId={userId}
                    isMinimised={w.minimised}
                    isMaximised={w.maximised}
                    isFocused={state.focusedId === w.id}
                  />
                )}
              </SpatialWindow>
            </WindowErrorBoundary>
          ))}
      </div>
      <PeripheralRail initialArrivals={initialArrivals ?? []} allowedTypes={allowedTypes} />
      <SpatialDock companyId={companyId} userId={userId} allowedTypes={allowedTypes} />
      {paletteOpen && <SpatialCommandPalette allowedTypes={allowedTypes} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
