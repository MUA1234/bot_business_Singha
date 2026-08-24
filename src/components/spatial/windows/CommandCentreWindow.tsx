"use client";

import type { WindowContentProps } from "../types";
import { EmptyState } from "@/components/ui";

export default function CommandCentreWindow(props: WindowContentProps) {
  return (
    <EmptyState
      title="Command Centre"
      description="This window was opened without pre-rendered content. Refresh the spatial workspace to reload it."
      icon="gauge"
    />
  );
}
