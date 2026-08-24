"use client";

import type { WindowContentProps } from "../types";
import { EmptyState } from "@/components/ui";

export default function ApprovalsWindow(props: WindowContentProps) {
  return (
    <EmptyState
      title="Approvals"
      description="This window was opened without pre-rendered content. Refresh the spatial workspace to reload it."
      icon="check-circle"
    />
  );
}
