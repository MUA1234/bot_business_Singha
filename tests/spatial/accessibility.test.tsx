import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { SpatialWindow } from "@/components/spatial/SpatialWindow";
import { WorkspaceProvider } from "@/components/spatial/WorkspaceProvider";
import type { SpatialWindowState } from "@/components/spatial/types";

function makeWindow(id: string): SpatialWindowState {
  return {
    id,
    type: "test",
    title: "Accessibility Test",
    x: 50,
    y: 50,
    width: 400,
    height: 300,
    z: 1,
    pinned: false,
    minimised: false,
    maximised: false,
    docked: null,
    priority: "normal",
    urgency: "visible",
    loading: false,
    stale: false,
    permissionDenied: false,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("spatial accessibility", () => {
  it("renders a window with dialog role and labelled title", () => {
    const html = renderToString(
      <WorkspaceProvider userId="user-1">
        <SpatialWindow window={makeWindow("win-1")}>
          <div>Content</div>
        </SpatialWindow>
      </WorkspaceProvider>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="win-title-win-1"');
    expect(html).toContain('id="win-title-win-1"');
  });

  it("does not render minimised windows", () => {
    const win = { ...makeWindow("win-2"), minimised: true };
    const html = renderToString(
      <WorkspaceProvider userId="user-2">
        <SpatialWindow window={win}>
          <div>Hidden</div>
        </SpatialWindow>
      </WorkspaceProvider>,
    );
    expect(html).not.toContain("Hidden");
  });
});
