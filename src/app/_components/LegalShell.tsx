/**
 * Shared layout for the public legal pages. Server component, self-contained styles
 * (light/dark aware) so the pages render consistently and need no external assets.
 * The `_components` folder is underscore-prefixed so Next.js does not route it.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { LEGAL } from "../legal-config";

export function LegalShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main
      style={{
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        maxWidth: 780,
        margin: "0 auto",
        padding: "40px 24px 64px",
        lineHeight: 1.65,
      }}
    >
      <nav style={{ fontSize: 14, marginBottom: 28 }}>
        <Link href="/">← {LEGAL.appName}</Link>
      </nav>
      <h1 style={{ fontSize: 30, lineHeight: 1.2, margin: "0 0 6px" }}>{title}</h1>
      <p style={{ margin: "0 0 32px", fontSize: 14, opacity: 0.65 }}>
        Last updated: {LEGAL.lastUpdated} · {LEGAL.legalEntity}
      </p>
      <div>{children}</div>
      <footer
        style={{
          marginTop: 56,
          paddingTop: 16,
          borderTop: "1px solid rgba(128,128,128,0.3)",
          fontSize: 13,
          opacity: 0.75,
        }}
      >
        <Link href="/privacy">Privacy Policy</Link>
        {" · "}
        <Link href="/terms">Terms of Service</Link>
        {" · "}
        <Link href="/data-deletion">Data Deletion</Link>
        <div style={{ marginTop: 8 }}>
          Contact: <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>
        </div>
      </footer>
    </main>
  );
}

/** Small heading used within legal pages. */
export function H2({ children }: { children: ReactNode }) {
  return <h2 style={{ fontSize: 20, margin: "32px 0 8px" }}>{children}</h2>;
}
