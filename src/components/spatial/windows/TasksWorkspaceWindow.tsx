"use client";

import type { WindowContentProps } from "../types";
import { EmptyState } from "@/components/ui";

export default function TasksWorkspaceWindow(props: WindowContentProps) {
  return (
    <EmptyState
      title="Tasks"
      description="This window was opened without pre-rendered content. Refresh the spatial workspace to reload it."
      icon="list-todo"
    />
  );
}
