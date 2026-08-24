"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useWorkspace, useWindowActions } from "./useWorkspace";
import { TouchDragHandle } from "./TouchDragHandle";
import { Icon } from "@/components/Icon";
import type { SpatialWindowState } from "./types";

interface SpatialWindowProps {
  window: SpatialWindowState;
  children: ReactNode;
}

type DragMode = "move" | "resize" | null;

const DRAG_THRESHOLD = 8;
const GRID = 16;
const EDGE_SNAP = 16;

/**
 * A floating glass window inside the spatial workspace.
 *
 * - Pointer-based drag and resize (mouse, touch, pen).
 * - Touch-friendly title bar and 48×48 controls.
 * - Focus, minimise, maximise, restore, pin, dock and close.
 * - Reduced-motion / flat-mode aware.
 * - Accidental-touch protection: a small movement threshold before drag starts.
 * - Snap-to-grid and edge docking when released.
 */
export function SpatialWindow({ window: w, children }: SpatialWindowProps) {
  const { state } = useWorkspace();
  const { focusWindow, closeWindow, minimiseWindow, maximiseWindow, restoreWindow, pinWindow, dockWindow, moveWindow, resizeWindow } = useWindowActions();
  const ref = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number; w: number; h: number; mode: DragMode } | null>(null);
  const movedRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const isFocused = state.focusedId === w.id;
  const reducedMotion = state.reducedMotion;
  const flatMode = state.flatMode;

  const handleFocus = useCallback(() => {
    if (!isFocused) focusWindow(w.id);
  }, [focusWindow, isFocused, w.id]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      // Ignore buttons inside the window body unless they are the drag handle.
      if (e.target instanceof HTMLElement && e.target.closest(".window-body") && !e.target.closest(".touch-drag-handle")) {
        handleFocus();
        return;
      }
      handleFocus();
    },
    [handleFocus],
  );

  const startDrag = useCallback(
    (e: PointerEvent<HTMLButtonElement>, mode: DragMode) => {
      e.preventDefault();
      e.stopPropagation();
      if (w.maximised || w.minimised) return;
      const target = e.currentTarget;
      target.setPointerCapture?.(e.pointerId);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        w: w.width,
        h: w.height,
        mode,
      };
      movedRef.current = false;
      setDragging(true);
    },
    [w.height, w.maximised, w.minimised, w.width],
  );

  useEffect(() => {
    const onMove = (e: globalThis.PointerEvent) => {
      if (!dragStart.current) return;
      const { x, y, w: sw, h: sh, mode } = dragStart.current;
      const dx = e.clientX - x;
      const dy = e.clientY - y;

      if (!movedRef.current) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        movedRef.current = true;
      }

      if (mode === "move") {
        moveWindow(w.id, w.x + dx, w.y + dy);
      } else if (mode === "resize") {
        resizeWindow(w.id, Math.max(240, sw + dx), Math.max(160, sh + dy));
      }
    };
    const onUp = (e: globalThis.PointerEvent) => {
      if (!dragStart.current) return;
      const target = e.target instanceof Element ? e.target : null;
      try {
        target?.releasePointerCapture?.(e.pointerId);
      } catch {
        // releasePointerCapture may throw if not captured.
      }
      dragStart.current = null;
      setDragging(false);
      if (!w.maximised && !w.minimised) {
        // Edge docking / snap-to-grid.
        let nextX = w.x;
        let nextY = w.y;
        if (w.x < EDGE_SNAP) {
          nextX = 0;
        } else if (state.bounds.width - w.x - w.width < EDGE_SNAP) {
          nextX = state.bounds.width - w.width;
        } else {
          nextX = Math.round(w.x / GRID) * GRID;
        }
        if (w.y < EDGE_SNAP) {
          nextY = 0;
        } else if (state.bounds.height - w.y - w.height < EDGE_SNAP) {
          nextY = state.bounds.height - w.height;
        } else {
          nextY = Math.round(w.y / GRID) * GRID;
        }
        if (nextX !== w.x || nextY !== w.y) {
          moveWindow(w.id, nextX, nextY);
        }
      }
      movedRef.current = false;
    };
    if (dragging) {
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
    }
  }, [dragging, moveWindow, resizeWindow, state.bounds.height, state.bounds.width, w.height, w.id, w.maximised, w.minimised, w.width, w.x, w.y]);

  const style: React.CSSProperties = {
    position: "absolute",
    left: w.maximised ? 0 : w.x,
    top: w.maximised ? 0 : w.y,
    width: w.maximised ? "100%" : w.width,
    height: w.maximised ? "100%" : w.height,
    zIndex: w.z,
    transform: dragging && movedRef.current ? "scale(1.01)" : "scale(1)",
    transition: reducedMotion ? "none" : "transform 0.1s ease, box-shadow 0.2s ease",
  };

  const glassDepth = flatMode ? 0 : 8;
  const boxShadow = `0 ${10 + glassDepth}px ${40 + glassDepth * 3}px -${8 + glassDepth}px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,${isFocused ? 0.18 : 0.08})`;

  if (w.minimised) {
    return null; // minimised windows are represented in the dock.
  }

  return (
    <div
      ref={ref}
      className={`spatial-window${isFocused ? " focused" : ""}${flatMode ? " flat" : ""}${reducedMotion ? " reduced-motion" : ""}`}
      style={style}
      onPointerDown={onPointerDown}
      role="dialog"
      aria-labelledby={`win-title-${w.id}`}
      aria-modal={isFocused ? "true" : undefined}
      data-priority={w.priority}
      data-urgency={w.urgency}
    >
      <div className="window-frame" style={{ boxShadow }}>
        <div className="window-titlebar">
          <TouchDragHandle onPointerDown={(e) => startDrag(e, "move")} className="titlebar-drag" />
          <span className="window-title" id={`win-title-${w.id}`}>
            <Icon name={w.priority === "critical" ? "alert-triangle" : "layout"} size={16} />
            <span className="window-title-text">{w.title}</span>
          </span>
          <div className="window-controls">
            <button
              type="button"
              className="window-btn pin"
              onClick={() => pinWindow(w.id, !w.pinned)}
              aria-label={w.pinned ? "Unpin window" : "Pin window"}
              title={w.pinned ? "Pinned" : "Pin"}
            >
              <Icon name={w.pinned ? "pin-off" : "pin"} size={16} />
            </button>
            {w.maximised ? (
              <button
                type="button"
                className="window-btn"
                onClick={() => restoreWindow(w.id)}
                aria-label="Restore window"
                title="Restore"
              >
                <Icon name="minimize-2" size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="window-btn"
                onClick={() => maximiseWindow(w.id)}
                aria-label="Maximise window"
                title="Maximise"
              >
                <Icon name="maximize-2" size={16} />
              </button>
            )}
            <button
              type="button"
              className="window-btn minimise"
              onClick={() => minimiseWindow(w.id)}
              aria-label="Minimise window"
              title="Minimise"
            >
              <Icon name="minus" size={16} />
            </button>
            <button
              type="button"
              className="window-btn dock"
              onClick={() => dockWindow(w.id, "right")}
              aria-label="Dock window"
              title="Dock"
            >
              <Icon name="panel-right" size={16} />
            </button>
            <button
              type="button"
              className="window-btn close"
              onClick={() => closeWindow(w.id)}
              aria-label="Close window"
              title="Close"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
        <div className="window-body">
          {w.loading && (
            <div className="window-state-overlay" aria-live="polite">
              <span className="window-state-text">Loading…</span>
            </div>
          )}
          {w.error && !w.loading && (
            <div className="window-state-overlay error" role="alert">
              <span className="window-state-text">{w.error}</span>
            </div>
          )}
          {w.permissionDenied && !w.loading && (
            <div className="window-state-overlay warn" role="alert">
              <span className="window-state-text">Permission denied</span>
            </div>
          )}
          {w.stale && !w.loading && (
            <div className="window-state-overlay stale" role="status">
              <span className="window-state-text">This record may be stale.</span>
            </div>
          )}
          <div className={`window-content${w.loading ? " loading" : ""}`}>{children}</div>
        </div>
        <button
          type="button"
          className="window-resize"
          onPointerDown={(e) => startDrag(e, "resize")}
          aria-label="Resize window"
          title="Resize"
        >
          <Icon name="move-diagonal" size={12} />
        </button>
      </div>
    </div>
  );
}
