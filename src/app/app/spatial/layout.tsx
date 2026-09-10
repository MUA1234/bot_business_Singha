import type { ReactNode } from "react";
import "@/components/spatial/styles.css";

/**
 * Spatial workspace layout. It intentionally does not re-render the AppShell chrome;
 * the workspace is a full-screen overlay and provides its own navigation and tools.
 */
export default function SpatialLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
