"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace, useWindowActions } from "./useWorkspace";
import { Icon } from "@/components/Icon";
import { WINDOW_SPECS, getWindowSpec } from "./windowSpecs";
import { useFocusTrap } from "./useFocusTrap";
import type { SearchableRecord } from "./types";

interface SpatialCommandPaletteProps {
  allowedTypes: string[];
  onClose: () => void;
}

/**
 * A modal command palette. It can focus an already-open window or open a new module
 * window from the registered window types. Focus is trapped inside the palette while
 * it is open and Escape closes it.
 */
export function SpatialCommandPalette({ allowedTypes, onClose }: SpatialCommandPaletteProps) {
  const { state } = useWorkspace();
  const { restoreWindow, focusWindow, openWindow } = useWindowActions();
  const [query, setQuery] = useState("");
  const paletteRef = useFocusTrap<HTMLDivElement>(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const records: SearchableRecord[] = useMemo(() => {
    const openRecords = state.windows.map((w) => ({
      id: w.id,
      type: w.type,
      title: w.title,
      subtitle: w.type,
      priority: w.priority,
    }));
    const openTypes = new Set(state.windows.map((w) => w.type));
    const moduleRecords: SearchableRecord[] = WINDOW_SPECS.filter(
      (s) => allowedTypes.includes(s.type) && !openTypes.has(s.type),
    ).map((s) => ({
      id: `new-${s.type}`,
      type: s.type,
      title: s.label,
      subtitle: `Open ${s.label}`,
      priority: s.defaultPriority,
    }));
    return [...openRecords, ...moduleRecords];
  }, [state.windows, allowedTypes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return records;
    return records.filter(
      (r) => r.title.toLowerCase().includes(q) || r.type.toLowerCase().includes(q),
    );
  }, [query, records]);

  useEffect(() => {
    // Focus the input explicitly when the palette opens; useFocusTrap focuses the
    // first focusable, which is also the input, but this guarantees caret placement.
    inputRef.current?.focus();
  }, []);

  const open = useCallback(
    (record: SearchableRecord) => {
      const existing = state.windows.find((w) => w.id === record.id || w.type === record.type);
      if (existing) {
        if (existing.minimised) restoreWindow(existing.id);
        focusWindow(existing.id);
      } else {
        const spec = getWindowSpec(record.type);
        if (spec) {
          openWindow({
            id: `win-${record.type}-${Date.now()}`,
            type: record.type,
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
      }
      onClose();
    },
    [state.windows, restoreWindow, focusWindow, openWindow, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && filtered[0]) open(filtered[0]);
    },
    [filtered, onClose, open],
  );

  return (
    <div className="command-palette-backdrop" onClick={onClose} role="presentation">
      <div
        ref={paletteRef}
        className="command-palette"
        role="dialog"
        aria-label="Open window"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          placeholder="Focus a workspace…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Search windows"
        />
        <div className="command-palette-results" role="listbox">
          {filtered.length === 0 && (
            <div className="command-palette-empty">No matching window</div>
          )}
          {filtered.map((r) => (
            <button
              key={r.id}
              type="button"
              className="command-palette-item"
              onClick={() => open(r)}
              role="option"
              aria-selected={false}
              aria-label={`Open ${r.title}`}
            >
              <Icon name="layout" size={18} />
              <span className="command-palette-title">{r.title}</span>
              <span className="command-palette-subtitle">{r.subtitle}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
