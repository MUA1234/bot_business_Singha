"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import type { ResolvedDestination } from "@/lib/os-navigation";
import type { NavItem } from "@/lib/departments";

/**
 * The global command palette.
 *
 * Keyboard (Ctrl/⌘+K) and touch (the strip's command control) reach the same
 * surface. It searches only what the user is already entitled to reach — the
 * destinations and routes resolved from their own department nav — so the
 * palette can never become a way around a permission.
 *
 * It is deliberately literal: it navigates and it opens the AI room. It does
 * not execute business actions, because a fuzzy-matched string is not an
 * adequate authorisation for anything that touches business state.
 */
export interface PaletteEntry {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  group: string;
  /** Extra words that should match this entry without being displayed. */
  keywords?: string;
  run: () => void;
}

function score(query: string, entry: PaletteEntry): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const label = entry.label.toLowerCase();
  const hay = `${label} ${entry.hint ?? ""} ${entry.keywords ?? ""}`.toLowerCase();
  if (label.startsWith(q)) return 100;
  if (label.includes(q)) return 60;
  if (hay.includes(q)) return 30;
  // Subsequence match, so "opfin" finds "Open Finance".
  let i = 0;
  for (const ch of hay) {
    if (ch === q[i]) i++;
    if (i === q.length) return 10;
  }
  return 0;
}

export function CommandPalette({
  open,
  onClose,
  destinations,
  routes,
  onAskAi,
  contextLabel,
}: {
  open: boolean;
  onClose: () => void;
  destinations: ResolvedDestination[];
  routes: NavItem[];
  onAskAi: () => void;
  contextLabel?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const entries = useMemo<PaletteEntry[]>(() => {
    const out: PaletteEntry[] = [];

    out.push({
      id: "ai",
      label: contextLabel ? `Ask the AI Manager about ${contextLabel}` : "Ask the AI Manager",
      hint: "Opens the AI Management Room with this screen as context",
      icon: "sparkles",
      group: "AI Manager",
      keywords: "ask ai analyse explain what needs attention next actions",
      run: onAskAi,
    });

    for (const dest of destinations) {
      out.push({
        id: `dest:${dest.key}`,
        label: dest.title,
        hint: dest.href,
        icon: dest.icon,
        group: "Go to",
        keywords: `open ${dest.label} ${dest.key}`,
        run: () => router.push(dest.href),
      });
    }

    for (const item of routes) {
      out.push({
        id: `route:${item.href}`,
        label: item.label,
        hint: item.href,
        icon: item.icon,
        group: "Screens",
        keywords: `open ${item.href.replace(/\//g, " ")}`,
        run: () => router.push(item.href),
      });
    }

    return out;
  }, [destinations, routes, router, onAskAi, contextLabel]);

  const results = useMemo(() => {
    const scored = entries
      .map((entry) => ({ entry, s: score(query, entry) }))
      .filter((r) => r.s > 0);
    // Stable: score first, then original order, so an empty query shows the
    // natural rail order rather than an arbitrary shuffle.
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 40).map((r) => r.entry);
  }, [entries, query]);

  // Reset and focus when it opens; restore focus to the trigger when it closes.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setIndex(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(id);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  // Keep the active row in view for keyboard users.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const commit = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(results[index]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      // The palette is the whole interaction while open; keep focus inside it.
      event.preventDefault();
    }
  };

  let lastGroup = "";

  return (
    <div
      className="palette-scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Go to a screen, or ask the AI Manager…"
          aria-label="Search destinations and screens"
          aria-controls="palette-results"
          aria-activedescendant={results[index] ? `palette-${results[index].id}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="palette-list" id="palette-results" role="listbox" ref={listRef}>
          {results.length === 0 && (
            <div className="palette-empty">
              Nothing you can reach matches “{query}”.
            </div>
          )}
          {results.map((entry, i) => {
            const showGroup = entry.group !== lastGroup;
            lastGroup = entry.group;
            return (
              <div key={entry.id}>
                {showGroup && <div className="palette-group-label">{entry.group}</div>}
                <button
                  type="button"
                  id={`palette-${entry.id}`}
                  className="palette-item"
                  role="option"
                  aria-selected={i === index}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => commit(entry)}
                >
                  <span className="palette-ico" aria-hidden="true">
                    <Icon name={entry.icon} size={16} strokeWidth={1.75} />
                  </span>
                  <span className="palette-label">{entry.label}</span>
                  {entry.hint && <span className="palette-hint">{entry.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑↓</kbd>move
          </span>
          <span>
            <kbd>↵</kbd>open
          </span>
          <span>
            <kbd>esc</kbd>close
          </span>
        </div>
      </div>
    </div>
  );
}
