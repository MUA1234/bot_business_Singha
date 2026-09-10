"use client";

import { useEffect, useCallback } from "react";
import { useWorkspace, useWindowActions } from "./useWorkspace";
import { WINDOW_SPECS } from "./windowSpecs";

interface ShortcutOptions {
  onOpenCommandPalette: () => void;
  onCloseCommandPalette: () => void;
  commandPaletteOpen: boolean;
  allowedTypes: string[];
}

function isMeta(e: KeyboardEvent) {
  return e.ctrlKey || e.metaKey;
}

export function useWorkspaceShortcuts({
  onOpenCommandPalette,
  onCloseCommandPalette,
  commandPaletteOpen,
  allowedTypes,
}: ShortcutOptions) {
  const { openWindow } = useWindowActions();
  const { dispatch } = useWorkspace();

  const openNewWindow = useCallback(() => {
    // Prefer a non-singleton work module; fall back to the command centre.
    const preferred = ["tasks", "ai-recommendations"];
    const type = preferred.find((t) => allowedTypes.includes(t)) ?? (allowedTypes.includes("command") ? "command" : allowedTypes[0]);
    if (!type) return;

    const spec = WINDOW_SPECS.find((s) => s.type === type);
    openWindow({
      id: `win-${type}-${Date.now()}`,
      type,
      title: spec?.label ?? type,
      x: 120,
      y: 120,
      width: spec?.defaultWidth ?? 720,
      height: spec?.defaultHeight ?? 520,
      pinned: false,
      minimised: false,
      maximised: false,
      docked: null,
      priority: spec?.defaultPriority ?? "normal",
      urgency: "visible",
      loading: true,
      stale: false,
      permissionDenied: false,
      error: null,
    });
  }, [allowedTypes, openWindow]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && isMeta(e) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (commandPaletteOpen) onCloseCommandPalette();
        else onOpenCommandPalette();
        return;
      }

      if (e.key === "N" && isMeta(e) && e.shiftKey && !e.altKey) {
        e.preventDefault();
        openNewWindow();
        return;
      }

      if (e.key === "Escape") {
        if (commandPaletteOpen) {
          e.preventDefault();
          onCloseCommandPalette();
        } else {
          dispatch({ kind: "blur" });
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandPaletteOpen, onOpenCommandPalette, onCloseCommandPalette, openNewWindow, dispatch]);
}
