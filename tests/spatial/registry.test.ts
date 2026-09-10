import { describe, it, expect } from "vitest";
import { WINDOW_SPECS, getWindowSpec, getWindowRenderer } from "@/components/spatial/WindowRegistry";
import { ModuleWindow } from "@/components/spatial/windows/ModuleWindow";

describe("spatial window registry", () => {
  it("registers every Phase-4 module window type", () => {
    const types = WINDOW_SPECS.map((s) => s.type);
    for (const t of ["finance", "staff", "projects", "customers", "vehicles", "purchase-orders", "risks", "system-health"]) {
      expect(types).toContain(t);
      const spec = getWindowSpec(t);
      expect(spec).toBeDefined();
      expect(spec!.label).toBeTruthy();
      expect(spec!.defaultWidth).toBeGreaterThan(0);
      expect(spec!.defaultHeight).toBeGreaterThan(0);
    }
  });

  it("maps every registered type to a renderer", () => {
    for (const spec of WINDOW_SPECS) {
      const renderer = getWindowRenderer(spec.type);
      expect(renderer).toBeTruthy();
    }
  });

  it("routes module types through the shared module renderer", () => {
    for (const t of ["finance", "staff", "projects", "customers", "vehicles", "purchase-orders", "risks", "system-health"]) {
      expect(getWindowRenderer(t)).toBe(ModuleWindow);
    }
  });
});
