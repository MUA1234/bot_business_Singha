import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { WorkspaceContext } from "@/components/spatial/WorkspaceProvider";
import { SpatialDock } from "@/components/spatial/SpatialDock";
import type { WorkspaceState } from "@/components/spatial/reducer";
import type { SpatialWindowState } from "@/components/spatial/types";

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

function mockState(windows: SpatialWindowState[]): WorkspaceState {
  return {
    windows,
    nextZ: windows.length + 1,
    focusedId: windows.find((w) => !w.minimised)?.id ?? null,
    reducedMotion: false,
    flatMode: false,
    bounds,
  };
}

function renderDock(allowedTypes: string[], windows: SpatialWindowState[]) {
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
      <SpatialDock companyId="company-1" userId="user-1" allowedTypes={allowedTypes} />
    </WorkspaceContext.Provider>,
  );
}

describe("SpatialDock module launcher", () => {
  it("renders quick-open buttons only for allowed module types", () => {
    const html = renderDock(["command", "tasks"], []);
    expect(html).toContain("Command Centre");
    expect(html).toContain("Tasks");
    expect(html).not.toContain("Finance");
    expect(html).not.toContain("Purchase Orders");
  });

  it("shows an active indicator for an open non-minimised singleton window", () => {
    const html = renderDock(["command"], [makeWindow("win-command", "command", { minimised: false })]);
    expect(html).toContain('aria-label="Command Centre (open)"');
    expect(html).toContain("dock-module active");
    expect(html).not.toContain("dock-module active minimised");
  });

  it("shows a minimised indicator for a minimised module window", () => {
    const html = renderDock(["tasks"], [makeWindow("win-tasks", "tasks", { minimised: true })]);
    expect(html).toContain('aria-label="Tasks (minimised)"');
    expect(html).toContain("dock-module minimised");
  });

  it("labels an allowed but closed module as openable", () => {
    const html = renderDock(["tasks"], []);
    expect(html).toContain('aria-label="Open Tasks"');
    expect(html).toContain("dock-module");
    expect(html).not.toContain("dock-module active");
    expect(html).not.toContain("dock-module minimised");
  });

  it("renders the mobile launcher trigger alongside the desktop row", () => {
    const html = renderDock(["command", "tasks"], []);
    expect(html).toContain("Open module launcher");
    expect(html).toContain("dock-mobile-trigger");
  });

  it("exposes the dock as a toolbar with a module launcher region", () => {
    const html = renderDock(["command"], []);
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Window dock and module launcher"');
    expect(html).toContain('aria-label="Module launcher"');
  });
});
