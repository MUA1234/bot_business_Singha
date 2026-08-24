"use client";

import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui";
import type { SpatialPriority } from "./types";

interface AlertArrivalCardProps {
  title: string;
  message: string;
  priority: SpatialPriority;
  onOpen?: () => void;
  onDismiss?: () => void;
}

/**
 * A compact arrival card for alerts and warnings. Critical alerts interrupt and
 * request focus; lower-priority alerts appear in the rail.
 */
export function AlertArrivalCard({ title, message, priority, onOpen, onDismiss }: AlertArrivalCardProps) {
  return (
    <div className={`arrival-card alert priority-${priority}`} role="alert">
      <div className="arrival-card-body">
        <Icon name="alert-triangle" size={20} />
        <div className="arrival-card-text">
          <div className="arrival-card-title">{title}</div>
          <div className="arrival-card-meta">{message}</div>
        </div>
        <Badge variant={priority === "critical" ? "danger" : priority === "high" ? "warn" : "info"}>
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
