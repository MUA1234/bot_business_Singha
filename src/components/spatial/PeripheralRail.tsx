"use client";

import { useCallback, useMemo, useState } from "react";
import { useWorkspace, useWindowActions } from "./useWorkspace";
import { AlertArrivalCard } from "./AlertArrivalCard";
import { TaskArrivalCard } from "./TaskArrivalCard";
import { Icon } from "@/components/Icon";
import type { SpatialArrival, SpatialPriority } from "./types";

interface PeripheralRailProps {
  initialArrivals: SpatialArrival[];
  allowedTypes: string[];
}

const PRIORITY_RANK: Record<SpatialPriority, number> = {
  critical: 3,
  high: 2,
  normal: 1,
  low: 0,
};

export function PeripheralRail({ initialArrivals, allowedTypes }: PeripheralRailProps) {
  const { state } = useWorkspace();
  const { openWindow, focusWindow, restoreWindow } = useWindowActions();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    const seen = new Set<string>();
    const filtered = initialArrivals.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return allowedTypes.includes(a.moduleType) && !dismissed.has(a.id) && !opened.has(a.id);
    });
    return [...filtered].sort(
      (a, b) =>
        PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
        b.timestamp.localeCompare(a.timestamp),
    );
  }, [initialArrivals, allowedTypes, dismissed, opened]);

  const openArrival = useCallback(
    (arrival: SpatialArrival) => {
      if (!allowedTypes.includes(arrival.moduleType)) return;

      const existing = state.windows.find((w) => w.type === arrival.moduleType);
      if (existing) {
        if (existing.minimised) restoreWindow(existing.id);
        focusWindow(existing.id);
      } else {
        openWindow({
          id: `win-${arrival.moduleType}-${Date.now()}`,
          type: arrival.moduleType,
          title: arrival.title,
          x: 120,
          y: 120,
          width: 720,
          height: 520,
          pinned: false,
          minimised: false,
          maximised: false,
          docked: null,
          priority: arrival.priority,
          urgency: "visible",
          loading: true,
          stale: false,
          permissionDenied: false,
          error: null,
        });
      }
      setOpened((prev) => new Set(prev).add(arrival.id));
    },
    [allowedTypes, state.windows, openWindow, focusWindow, restoreWindow],
  );

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  return (
    <div className="peripheral-rail" role="complementary" aria-label="Peripheral arrivals">
      <div className="rail-header">Arrivals</div>
      {visible.length === 0 ? (
        <div className="rail-empty">
          <Icon name="inbox" size={18} />
          <span>No new arrivals</span>
        </div>
      ) : (
        <div className="rail-items" role="list">
          {visible.map((arrival) =>
            arrival.kind === "alert" ? (
              <AlertArrivalCard
                key={arrival.id}
                title={arrival.title}
                message={arrival.message}
                priority={arrival.priority}
                onOpen={() => openArrival(arrival)}
                onDismiss={() => dismiss(arrival.id)}
              />
            ) : (
              <TaskArrivalCard
                key={arrival.id}
                title={arrival.title}
                priority={arrival.priority}
                due={arrival.due ?? null}
                onOpen={() => openArrival(arrival)}
                onDismiss={() => dismiss(arrival.id)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
