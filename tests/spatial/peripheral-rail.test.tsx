import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { WorkspaceContext } from "@/components/spatial/WorkspaceProvider";
import { PeripheralRail } from "@/components/spatial/PeripheralRail";
import type { WorkspaceState } from "@/components/spatial/reducer";
import type { SpatialWindowState, TaskArrival, AlertArrival } from "@/components/spatial/types";

const bounds = { width: 1920, height: 1080 };

function makeWindow(id: string, type: string, overrides: Partial<SpatialWindowState> = {}): SpatialWindowState {
  return {
    id,
    type,
    title: id,
    x: 100,
    y: 100,
    width: 400,
    height: 300,
    z: 1,
    pinned: false,
    minimised: false,
    maximised: false,
    docked: null,
    priority: "normal",
    urgency: "queued",
    loading: false,
    stale: false,
    permissionDenied: false,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockState(windows: SpatialWindowState[] = []): WorkspaceState {
  return {
    windows,
    nextZ: windows.length + 1,
    focusedId: windows.find((w) => !w.minimised)?.id ?? null,
    reducedMotion: false,
    flatMode: false,
    bounds,
  };
}

function taskArrival(id: string, priority = "normal" as const): TaskArrival {
  return {
    id: `task:${id}`,
    kind: "task",
    title: `Task ${id}`,
    priority,
    timestamp: new Date().toISOString(),
    moduleType: "tasks",
    recordId: id,
    due: null,
  };
}

function alertArrival(id: string): AlertArrival {
  return {
    id: `alert:${id}`,
    kind: "alert",
    title: `Alert ${id}`,
    message: "Something needs attention",
    priority: "high",
    timestamp: new Date().toISOString(),
    moduleType: "command",
  };
}

function renderRail(initialArrivals: (TaskArrival | AlertArrival)[], allowedTypes: string[], windows: SpatialWindowState[] = []) {
  return renderToString(
    <WorkspaceContext.Provider
      value={{
        state: mockState(windows),
        dispatch: vi.fn(),
        saveLayout: vi.fn(),
        restoreLayout: vi.fn(),
        ready: true,
      }}
    >
      <PeripheralRail initialArrivals={initialArrivals} allowedTypes={allowedTypes} />
    </WorkspaceContext.Provider>,
  );
}

describe("PeripheralRail live arrivals", () => {
  it("renders task and alert arrival cards", () => {
    const html = renderRail([taskArrival("1"), alertArrival("1")], ["tasks", "command"]);
    expect(html).toContain("Task 1");
    expect(html).toContain("Alert 1");
    expect(html).toContain('role="alert"');
  });

  it("shows a truthful empty state when no arrivals exist", () => {
    const html = renderRail([], ["tasks"]);
    expect(html).toContain("No new arrivals");
  });

  it("filters out arrivals for unauthorised module types", () => {
    const html = renderRail([taskArrival("1"), alertArrival("1")], ["tasks"]);
    expect(html).toContain("Task 1");
    expect(html).not.toContain("Alert 1");
  });

  it("deduplicates duplicate ids in the rendered list", () => {
    const html = renderRail([taskArrival("1"), taskArrival("1")], ["tasks"]);
    // After deduplication only one task card is rendered.
    const matches = html.match(/class="arrival-card task /g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("styles critical arrivals with an attention class", () => {
    const html = renderRail([taskArrival("1", "critical")], ["tasks"]);
    expect(html).toContain("priority-critical");
  });

  it("labels the rail as a complementary arrivals region", () => {
    const html = renderRail([taskArrival("1")], ["tasks"]);
    expect(html).toContain('role="complementary"');
    expect(html).toContain('aria-label="Peripheral arrivals"');
  });
});
