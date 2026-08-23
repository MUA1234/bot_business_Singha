"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NavItem } from "@/lib/departments";
import { Brand } from "./Brand";
import { Icon } from "./Icon";
import { SearchInput } from "./ui";
import { signOut } from "@/app/login/actions";

function activeHrefFor(nav: NavItem[], pathname: string): string | null {
  let best: string | null = null;
  for (const item of nav) {
    const matches = pathname === item.href || pathname.startsWith(item.href + "/");
    if (matches && (best === null || item.href.length > best.length)) best = item.href;
  }
  return best;
}

function UserMenu({ username, departmentLabel }: { username: string; departmentLabel: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) {
      window.addEventListener("keydown", onKey);
      window.addEventListener("mousedown", onClick);
      return () => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("mousedown", onClick);
      };
    }
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${username}, ${departmentLabel}. Open user menu`}
        title={`${username} (${departmentLabel})`}
      >
        <span className="user-menu-initial" aria-hidden="true">
          {username.slice(0, 1).toUpperCase()}
        </span>
        <span className="user-menu-name" aria-hidden="true">
          {username}
        </span>
        <Icon name="chevron-down" size={14} className="user-menu-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="user-menu-dropdown" role="menu">
          <div className="user-menu-info" role="none">
            <div className="user-menu-info-name">{username}</div>
            <div className="user-menu-info-role dim small">{departmentLabel}</div>
          </div>
          <form action={signOut} role="none">
            <button type="submit" className="user-menu-item" role="menuitem">
              <Icon name="log-out" size={16} /> Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

/**
 * Authenticated shell: sticky sidebar, active-route highlight, global nav search,
 * notification link, user menu, and skip-to-content. The mobile view collapses
 * to an icon-only horizontal strip with tooltips, then expands to a labelled
 * strip on slightly larger phones.
 */
export function AppShell({
  nav,
  username,
  departmentLabel,
  isAdmin,
  children,
}: {
  nav: NavItem[];
  username: string;
  departmentLabel: string;
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const activeHref = activeHrefFor(nav, pathname);
  const [query, setQuery] = useState("");

  const filteredNav = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nav;
    return nav.filter((item) => item.label.toLowerCase().includes(q));
  }, [nav, query]);

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <div className="shell">
        <aside className="sidebar" aria-label="Department navigation">
          <div className="sidebar-brand">
            <Brand size={26} />
          </div>
          <div className="sidebar-search">
            <SearchInput
              label="Filter navigation"
              placeholder="Filter menu…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="sidebar-search-input"
            />
          </div>
          <nav className="sidebar-nav" aria-label="Main">
            {filteredNav.map((item) => {
              const active = item.href === activeHref;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`nav-item${active ? " active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                >
                  <span className="ico" aria-hidden="true">
                    <Icon name={item.icon} size={18} />
                  </span>
                  <span className="nav-label">{item.label}</span>
                </Link>
              );
            })}
            {filteredNav.length === 0 && (
              <div className="sidebar-no-results small dim">No menu items match</div>
            )}
          </nav>
          <div className="grow" />
          <div className="sidebar-footer">
            <form action={signOut}>
              <button className="btn ghost sm block" type="submit">
                <Icon name="log-out" size={14} /> Sign out
              </button>
            </form>
          </div>
        </aside>

        <main id="main-content" className="main" tabIndex={-1}>
          <header className="topbar">
            <div className="stack">
              <span className="badge accent">{departmentLabel}</span>
              {isAdmin && <span className="small dim">Administrator view</span>}
            </div>
            <div className="row gap-2 topbar-actions">
              <Link
                href="/app/notifications"
                className="topbar-icon-btn"
                aria-label="Notifications"
                title="Notifications"
              >
                <Icon name="message-square" size={20} />
              </Link>
              <UserMenu username={username} departmentLabel={departmentLabel} />
            </div>
          </header>
          {children}
        </main>
      </div>
    </>
  );
}
