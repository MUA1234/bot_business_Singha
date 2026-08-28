"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Brand } from "@/components/Brand";
import {
  SECTION_LABEL,
  currentDestination,
  type ResolvedDestination,
} from "@/lib/os-navigation";
import type { NavItem } from "@/lib/departments";

/**
 * The command rail.
 *
 * DESKTOP / TABLET — a thin structural element along one edge: anodised metal,
 * not a floating glass panel, because it is part of the frame of the room
 * rather than a surface inside it. Collapsed it is a column of 44 px glyphs
 * with flyout labels; open it is a labelled index.
 *
 * PHONE — the rail moves to the bottom edge, because a thumb cannot reach a
 * top-left rail. It is NOT the same list shrunk: sixteen horizontally
 * scrolling tabs is a list nobody reads. Instead four primary destinations sit
 * on the bar and everything else lives one tap away in a full-height sheet,
 * grouped exactly as the desktop rail groups it. Nothing is removed.
 *
 * Counts are REAL unattended-item counts passed in by the server. A destination
 * with nothing outstanding shows no badge — never a dot that cannot say how
 * many.
 */
export interface RailCounts {
  [destinationKey: string]: { count: number; band?: "critical" | "warn" } | undefined;
}

const OPEN_KEY = "singha.os.rail.open";

/**
 * The destinations that earn a place on a phone's bottom bar, in preference
 * order. Whichever of these the user is entitled to are used; if fewer than
 * four match, the rail fills up from the front of their own destination list,
 * so a user with an unusual entitlement set still gets a full bar.
 */
const PHONE_PRIMARY = ["command", "me", "work", "comms", "finance", "customers"];

export function CommandRail({
  destinations,
  unclaimed,
  pathname,
  counts = {},
}: {
  destinations: ResolvedDestination[];
  unclaimed: NavItem[];
  pathname: string;
  counts?: RailCounts;
}) {
  const [open, setOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  // The open/collapsed choice is a per-person preference, so it persists. It is
  // read after mount to keep the server and first client render identical.
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(OPEN_KEY) === "1");
    } catch {
      /* storage unavailable (private mode, blocked cookies) — stay collapsed */
    }
  }, []);

  // The sheet is a modal layer: Escape closes it and focus stays inside it.
  useEffect(() => {
    if (!sheetOpen) return;
    const node = sheetRef.current;
    node?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSheetOpen(false);
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const focusable = node.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [sheetOpen]);

  // Moving to another screen closes the sheet.
  useEffect(() => setSheetOpen(false), [pathname]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
      } catch {
        /* preference simply will not persist */
      }
      return next;
    });
  };

  const current = currentDestination(destinations, pathname);

  // Group consecutive destinations by section, preserving order within each.
  // The React key is the group's INDEX, not the section name: a section that
  // legitimately appears twice would otherwise collide and React would reuse
  // the wrong subtree.
  const sections: { key: string; label: string; items: ResolvedDestination[] }[] = [];
  for (const dest of destinations) {
    const last = sections[sections.length - 1];
    if (last && last.label === SECTION_LABEL[dest.section]) last.items.push(dest);
    else
      sections.push({
        key: `${dest.section}-${sections.length}`,
        label: SECTION_LABEL[dest.section],
        items: [dest],
      });
  }

  // Phone bar: four primaries, chosen from preference order then topped up.
  const primary: ResolvedDestination[] = [];
  for (const key of PHONE_PRIMARY) {
    const found = destinations.find((d) => d.key === key);
    if (found && !primary.includes(found)) primary.push(found);
    if (primary.length === 4) break;
  }
  for (const dest of destinations) {
    if (primary.length === 4) break;
    if (!primary.includes(dest)) primary.push(dest);
  }
  const currentIsSecondary = Boolean(current) && !primary.some((d) => d.key === current!.key);

  const renderItem = (dest: ResolvedDestination, opts: { inSheet?: boolean } = {}) => {
    const isCurrent = current?.key === dest.key;
    const count = counts[dest.key];
    return (
      <Link
        key={dest.key}
        href={dest.href}
        className={`rail-item${isCurrent ? " is-current" : ""}`}
        aria-current={isCurrent ? "page" : undefined}
        title={dest.title}
        onClick={() => opts.inSheet && setSheetOpen(false)}
      >
        <span className="rail-ico" aria-hidden="true">
          <Icon name={dest.icon} size={19} strokeWidth={1.75} />
        </span>
        <span className="rail-label">{dest.label}</span>
        {count && count.count > 0 && (
          <span
            className={`rail-count${
              count.band === "critical" ? " is-critical" : count.band === "warn" ? " is-warn" : ""
            }`}
          >
            {count.count > 99 ? "99+" : count.count}
            <span className="sr-only"> items need attention</span>
          </span>
        )}
        <span className="rail-fly" aria-hidden="true">
          {dest.title}
        </span>
      </Link>
    );
  };

  const renderUnclaimed = (item: NavItem, inSheet = false) => {
    const isCurrent = pathname === item.href || pathname.startsWith(item.href + "/");
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`rail-item${isCurrent ? " is-current" : ""}`}
        aria-current={isCurrent ? "page" : undefined}
        title={item.label}
        onClick={() => inSheet && setSheetOpen(false)}
      >
        <span className="rail-ico" aria-hidden="true">
          <Icon name={item.icon} size={19} strokeWidth={1.75} />
        </span>
        <span className="rail-label">{item.label}</span>
        <span className="rail-fly" aria-hidden="true">
          {item.label}
        </span>
      </Link>
    );
  };

  return (
    <>
      <nav
        className={`rail${open ? " is-open" : ""}`}
        aria-label="Primary destinations"
        data-open={open}
      >
        <div className="rail-brand">
          <Link href="/app" aria-label="Singha Central — home">
            <Brand size={open ? 26 : 24} nameHidden={!open} />
          </Link>
        </div>

        {/* Desktop / tablet: the full grouped index. */}
        <div className="rail-nav">
          {sections.map((section) => (
            <div className="rail-group" key={section.key}>
              <div className="rail-section" aria-hidden="true">
                {section.label}
              </div>
              {section.items.map((dest) => renderItem(dest))}
            </div>
          ))}

          {/* A route the destination map does not claim is shown here rather
           * than silently dropped — a new department route can never vanish
           * from the interface just because this map has not caught up. */}
          {unclaimed.length > 0 && (
            <div className="rail-group">
              <div className="rail-section" aria-hidden="true">
                Other
              </div>
              {unclaimed.map((item) => renderUnclaimed(item))}
            </div>
          )}
        </div>

        {/* Phone: four primaries plus everything else, one tap away. */}
        <div className="rail-bar">
          {primary.map((dest) => renderItem(dest))}
          <button
            type="button"
            className={`rail-item rail-more${currentIsSecondary ? " is-current" : ""}`}
            onClick={() => setSheetOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
          >
            <span className="rail-ico" aria-hidden="true">
              <Icon name="more-horizontal" size={19} strokeWidth={1.75} />
            </span>
            <span className="rail-label">More</span>
          </button>
        </div>

        <div className="rail-foot">
          <button
            type="button"
            className="rail-toggle"
            onClick={toggle}
            aria-expanded={open}
            aria-label={open ? "Collapse the command rail" : "Expand the command rail"}
          >
            <Icon name={open ? "chevrons-left" : "chevrons-right"} size={15} />
            {open && <span>Collapse</span>}
          </button>
        </div>
      </nav>

      {sheetOpen && (
        <div
          className="rail-sheet-scrim"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSheetOpen(false);
          }}
        >
          <div
            className="rail-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="All destinations"
            ref={sheetRef}
          >
            <div className="rail-sheet-head">
              <span className="t-label">All destinations</span>
              <button
                type="button"
                className="strip-btn"
                onClick={() => setSheetOpen(false)}
                aria-label="Close"
              >
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="rail-sheet-body">
              {sections.map((section) => (
                <div key={section.key}>
                  <div className="rail-sheet-section">{section.label}</div>
                  <div className="rail-sheet-items">
                    {section.items.map((dest) => renderItem(dest, { inSheet: true }))}
                  </div>
                </div>
              ))}
              {unclaimed.length > 0 && (
                <div>
                  <div className="rail-sheet-section">Other</div>
                  <div className="rail-sheet-items">
                    {unclaimed.map((item) => renderUnclaimed(item, true))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
