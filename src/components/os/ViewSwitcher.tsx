"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";

/**
 * View switcher.
 *
 * The spatial composition is a DEFAULT, never a cage: management may prefer to
 * see work grouped spatially, but a supervisor chasing one row wants a table
 * and a scheduler wants a board. All views are server-rendered from the same
 * records and passed in as nodes; this component only chooses which is shown,
 * so switching costs no request and loses no data.
 *
 * The choice persists per person, and the chosen view is announced to assistive
 * technology through `aria-pressed` on the controls rather than by visual state
 * alone.
 */
export interface ViewSpec {
  key: string;
  label: string;
  icon: string;
  node: ReactNode;
}

export function ViewSwitcher({
  views,
  storageKey,
  meta,
}: {
  views: ViewSpec[];
  /** Where the per-person preference is remembered. */
  storageKey: string;
  meta?: ReactNode;
}) {
  const [active, setActive] = useState(views[0]?.key ?? "");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved && views.some((v) => v.key === saved)) setActive(saved);
    } catch {
      /* storage unavailable — the default view is used */
    }
    // views identity is stable per render of the parent; only the key matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const choose = (key: string) => {
    setActive(key);
    try {
      window.localStorage.setItem(storageKey, key);
    } catch {
      /* the preference simply will not persist */
    }
  };

  const current = views.find((v) => v.key === active) ?? views[0];

  return (
    <>
      <div className="row between wrap gap-2" style={{ marginBottom: "var(--sp-4)" }}>
        <div className="views" role="group" aria-label="Change how this work is arranged">
          {views.map((v) => (
            <button
              key={v.key}
              type="button"
              aria-pressed={v.key === current?.key}
              onClick={() => choose(v.key)}
            >
              <span className="row gap-1">
                <Icon name={v.icon} size={14} aria-hidden="true" />
                {v.label}
              </span>
            </button>
          ))}
        </div>
        {meta && <span className="sec-meta">{meta}</span>}
      </div>
      {/* Only the chosen view is mounted, so a large table is not laid out
       * behind a constellation the reader is not looking at. */}
      {current?.node}
    </>
  );
}
