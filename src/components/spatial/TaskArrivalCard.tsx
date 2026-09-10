"use client";

import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui";
import type { SpatialPriority } from "./types";

interface TaskArrivalCardProps {
  title: string;
  priority: SpatialPriority;
  due?: string | null;
  onOpen?: () => void;
  onDismiss?: () => void;
}

/**
 * A compact arrival card for a new task. Used in the peripheral rail and in
 * relationship overlays.
 */
export function TaskArrivalCard({ title, priority, due, onOpen, onDismiss }: TaskArrivalCardProps) {
  return (
    <div className={`arrival-card task priority-${priority}`} role="listitem">
      <div className="arrival-card-body">
        <Icon name="list-todo" size={20} />
        <div className="arrival-card-text">
          <div className="arrival-card-title">{title}</div>
          {due && <div className="arrival-card-meta">Due {due}</div>}
        </div>
        <Badge variant={priority === "critical" ? "danger" : priority === "high" ? "warn" : "default"}>
          {priority}
        </Badge>
      </div>
      <div className="arrival-card-actions">
        {onOpen && (
          <button type="button" className="arrival-card-btn" onClick={onOpen} aria-label={`Open ${title}`}>
            Open
          </button>
        )}
        {onDismiss && (
          <button type="button" className="arrival-card-btn ghost" onClick={onDismiss} aria-label={`Dismiss ${title}`}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
