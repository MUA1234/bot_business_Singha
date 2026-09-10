"use client";

import type { WindowContentProps } from "../types";
import { EmptyState } from "@/components/ui";

/**
 * Client placeholder for the management-queue window, following the same pattern as its
 * siblings: real content is pre-rendered on the server by the spatial shell, and this is
 * what renders if the window is opened without it.
 */
export default function ManagementQueueWindow(_props: WindowContentProps) {
  return (
    <EmptyState
      title="Management Queue"
      description="This window was opened without pre-rendered content. Refresh the spatial workspace to reload it."
      icon="inbox"
    />
  );
}
