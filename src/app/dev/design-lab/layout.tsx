import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { env } from "@/config/env";
import { DEPARTMENTS } from "@/lib/departments";
import { SpatialShell } from "@/components/os/SpatialShell";
import { LAB_NOTICE } from "./fixtures";

export const metadata = { title: "Design Lab — Singha Central" };

/**
 * The gate below MUST be evaluated per request, not at build time. Without this
 * the lab is prerendered into the build output as a static page and served
 * straight from the CDN — which would answer 200 in an environment whose
 * runtime configuration says it should answer 404.
 */
export const dynamic = "force-dynamic";

/**
 * DESIGN LAB — development-only.
 *
 * Renders the real Spatial Executive OS shell against the real department
 * navigation catalog, so the interface can be inspected, screenshotted and
 * responsively tested in a browser without a database.
 *
 * Refused outright when APP_ENV is production, and additionally gated behind
 * NEXT_PUBLIC_DESIGN_LAB. It reads no business data, performs no query, and is
 * banded on every screen so it can never be mistaken for the application.
 */
export default function DesignLabLayout({ children }: { children: ReactNode }) {
  if (!env.flags.designLab()) notFound();

  const admin = DEPARTMENTS.find((d) => d.key === "admin");

  return (
    <SpatialShell
      nav={admin?.nav ?? []}
      username="designlab"
      departmentLabel="Design lab"
      isAdmin
      companyName="Placeholder Company"
      branchLabel="Placeholder branch"
      unreadCount={4}
      railCounts={{
        comms: { count: 4, band: "warn" },
        me: { count: 9 },
        finance: { count: 3, band: "critical" },
      }}
      aiConfigured={false}
    >
      <div
        className="notice"
        role="note"
        style={{
          background: "rgba(var(--warn-rgb), 0.1)",
          border: "1px solid rgba(var(--warn-rgb), 0.34)",
          color: "var(--warn)",
          marginBottom: "var(--sp-5)",
          fontWeight: 650,
        }}
      >
        {LAB_NOTICE}
      </div>
      {children}
    </SpatialShell>
  );
}
