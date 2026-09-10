"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { signOut } from "@/app/login/actions";
import type { NavItem } from "@/lib/departments";
import {
  currentDestination,
  domainForPath,
  resolveDestinations,
  unclaimedRoutes,
} from "@/lib/os-navigation";
import { contextLabelFor, suggestionsFor } from "@/lib/os-ai-context";
import { SpatialEnvironment } from "./SpatialEnvironment";
import { CommandRail, type RailCounts } from "./CommandRail";
import { CommandPalette } from "./CommandPalette";
import { AIManagementRoom } from "./AIManagementRoom";
import { useCamera } from "./useCamera";

/**
 * The Spatial Executive OS shell.
 *
 * Replaces the sidebar-and-header layout with:
 *   - an atmospheric environment the work floats in,
 *   - a structural command rail along one edge,
 *   - a minimal scope strip (company, branch, clock, search, alerts, identity),
 *   - a stage carrying an extremely subtle virtual camera,
 *   - an always-reachable AI presence that knows the current screen.
 *
 * It takes exactly the props the old shell took, so every authenticated route
 * keeps working unchanged; the entitlement model is still the department nav
 * passed in by the server.
 */
export function SpatialShell({
  nav,
  username,
  departmentLabel,
  isAdmin,
  companyName,
  branchLabel,
  unreadCount = 0,
  railCounts = {},
  aiConfigured,
  children,
}: {
  nav: NavItem[];
  username: string;
  departmentLabel: string;
  isAdmin: boolean;
  /** The company the user is acting within. Never inferred, never blank. */
  companyName: string;
  branchLabel?: string | null;
  unreadCount?: number;
  railCounts?: RailCounts;
  /** Whether the AI gateway is configured in this environment. */
  aiConfigured: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const sceneRef = useCamera<HTMLDivElement>();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clock, setClock] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const destinations = useMemo(() => resolveDestinations(nav), [nav]);
  const unclaimed = useMemo(() => unclaimedRoutes(nav), [nav]);
  const current = currentDestination(destinations, pathname);
  const domain = domainForPath(pathname);
  const contextLabel = contextLabelFor(pathname);
  const suggestions = useMemo(() => suggestionsFor(pathname, nav), [pathname, nav]);

  // The clock is rendered only after mount. A server-rendered time is wrong the
  // instant it reaches the browser, and a hydration mismatch on every page load
  // is not worth a timestamp.
  useEffect(() => {
    const tick = () =>
      setClock(
        new Intl.DateTimeFormat(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date()),
      );
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openAi = useCallback(() => {
    setPaletteOpen(false);
    setAiOpen(true);
  }, []);

  // Global shortcuts. Ctrl/⌘+K opens the palette from anywhere that is not
  // already a text field handling its own keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Dismiss the identity menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [menuOpen]);

  const initial = username.slice(0, 1).toUpperCase();
  const companyInitial = companyName.slice(0, 1).toUpperCase();

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      <SpatialEnvironment domain={domain} />

      <div className="os">
        <CommandRail
          destinations={destinations}
          unclaimed={unclaimed}
          pathname={pathname}
          counts={railCounts}
        />

        <div className="stage">
          <header className="strip">
            <div className="strip-scope">
              {/* Which company you are acting within is the first thing in the
               * strip and is never hidden. Cross-company confusion is a
               * security failure, not a cosmetic one. */}
              <span className="strip-company" title={`Acting within ${companyName}`}>
                <span className="co-mark" aria-hidden="true">
                  {companyInitial}
                </span>
                <span className="co-name">{companyName}</span>
              </span>
              {branchLabel && <span className="strip-branch">{branchLabel}</span>}
            </div>

            <div className="strip-spacer" />

            {clock && (
              <span className="strip-clock" aria-label={`Current time ${clock}`}>
                {clock}
              </span>
            )}

            <div className="strip-actions">
              <button type="button" className="strip-command" onClick={openPalette}>
                <Icon name="search" size={15} aria-hidden="true" />
                <span className="strip-command-text">Search or command…</span>
                <span className="kbd" aria-hidden="true">
                  ⌘K
                </span>
                <span className="sr-only">Open the command palette</span>
              </button>

              <Link
                href="/app/notifications"
                className="strip-btn"
                aria-label={
                  unreadCount > 0
                    ? `Notifications, ${unreadCount} unread`
                    : "Notifications, none unread"
                }
                title="Notifications"
              >
                <Icon name="bell" size={19} strokeWidth={1.75} />
                {unreadCount > 0 && (
                  <span className="strip-btn-count" aria-hidden="true">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </Link>

              <div className="user-menu" ref={menuRef}>
                <button
                  type="button"
                  className="user-menu-trigger"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  aria-label={`${username}, ${departmentLabel}. Open user menu`}
                >
                  <span className="user-menu-initial" aria-hidden="true">
                    {initial}
                  </span>
                  <span className="user-menu-name" aria-hidden="true">
                    {username}
                  </span>
                  <Icon name="chevron-down" size={13} className="user-menu-chevron" aria-hidden="true" />
                </button>
                {menuOpen && (
                  <div className="user-menu-dropdown" role="menu">
                    <div className="user-menu-info" role="none">
                      <div className="user-menu-info-name">{username}</div>
                      <div className="user-menu-info-role dim small">
                        {departmentLabel}
                        {isAdmin ? " · Administrator" : ""}
                      </div>
                    </div>
                    <Link href="/app/me" className="user-menu-item" role="menuitem" onClick={() => setMenuOpen(false)}>
                      <Icon name="compass" size={15} /> My work
                    </Link>
                    <form action={signOut} role="none">
                      <button type="submit" className="user-menu-item" role="menuitem">
                        <Icon name="log-out" size={15} /> Sign out
                      </button>
                    </form>
                  </div>
                )}
              </div>
            </div>
          </header>

          <div className="stage-scene" ref={sceneRef} data-domain={domain}>
            <main id="main-content" className="surface" tabIndex={-1}>
              {children}
            </main>
          </div>
        </div>
      </div>

      {/* The AI presence: always reachable, never a mascot. */}
      <button
        type="button"
        className="presence"
        data-state="idle"
        onClick={openAi}
        aria-label={`Ask the Senior AI Manager about ${contextLabel}`}
      >
        <span className="presence-core" aria-hidden="true" />
        <span className="presence-text">
          <span className="presence-title">Senior AI Manager</span>
          <span className="presence-line">Ask about {contextLabel}</span>
        </span>
      </button>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        destinations={destinations}
        routes={nav}
        onAskAi={openAi}
        contextLabel={contextLabel}
      />

      <AIManagementRoom
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        contextLabel={contextLabel}
        contextHref={current?.href ?? pathname}
        suggestions={suggestions}
        canAnalyse={isAdmin}
        aiConfigured={aiConfigured}
      />
    </>
  );
}
