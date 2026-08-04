"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import type { NavItem } from "@/lib/departments";
import { Brand } from "./Brand";
import { signOut } from "@/app/login/actions";

/**
 * Authenticated shell: department sidebar + topbar. Active link is highlighted
 * from the current path. Logout posts to the signOut server action.
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

  return (
    <div className="shell">
      <aside className="sidebar">
        <div style={{ padding: "6px 10px 14px" }}>
          <Brand size={26} />
        </div>
        {nav.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== `/app` && pathname.startsWith(item.href + "/")) ||
            pathname === item.href;
          return (
            <Link key={item.href} href={item.href} className={`nav-item${active ? " active" : ""}`}>
              <span className="ico">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
        <div className="grow" />
        <form action={signOut} style={{ padding: "8px 4px" }}>
          <button className="btn ghost sm block" type="submit">Sign out</button>
        </form>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="stack">
            <span className="badge accent">{departmentLabel}</span>
          </div>
          <div className="row gap-2">
            <div className="stack" style={{ textAlign: "right" }}>
              <span style={{ fontWeight: 700 }}>{username}</span>
              <span className="small dim">{isAdmin ? "Administrator" : departmentLabel}</span>
            </div>
            <div
              className="row center"
              style={{
                width: 38,
                height: 38,
                borderRadius: "50%",
                background: "var(--accent-grad)",
                fontWeight: 800,
              }}
            >
              {username.slice(0, 1).toUpperCase()}
            </div>
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
