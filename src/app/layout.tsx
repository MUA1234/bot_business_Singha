import type { ReactNode } from "react";
import "./globals.css";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";

export const metadata = {
  title: "Singha Central",
  description:
    "Sign in to your own work — finance, operations, people, procurement, compliance, fleet and sales in one place. What is yours to decide reaches you; every decision is recorded.",
};

export const viewport = {
  themeColor: "#08090b",
  width: "device-width",
  initialScale: 1,
  // Let content extend under notches; globals.css pads with safe-area insets.
  viewportFit: "cover" as const,
};

/**
 * The environment layer is mounted per-area rather than here, because the
 * authenticated application lights the room differently depending on which
 * module you are in (see `SpatialShell` → `SpatialEnvironment`), while public
 * surfaces use the neutral composition. Mounting it once at the root would
 * force one lighting state on everything.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegistration />
        {children}
      </body>
    </html>
  );
}
