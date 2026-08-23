/**
 * MOB-001 — Responsive mobile experience.
 *
 * The root layout and global stylesheet must declare a mobile-ready viewport,
 * use responsive grid/flex layouts, respect safe-area insets, and collapse
 * multi-column grids at narrow widths.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const LAYOUT = "src/app/layout.tsx";
const GLOBALS = "src/app/globals.css";

describe("MOB-001 — responsive mobile surface", () => {
  const layout = readFileSync(LAYOUT, "utf8");
  const css = readFileSync(GLOBALS, "utf8");

  it("exports a viewport configured for mobile devices", () => {
    expect(layout).toContain("export const viewport");
    expect(layout).toContain('width: "device-width"');
    expect(layout).toContain("initialScale: 1");
    expect(layout).toContain('viewportFit: "cover"');
  });

  it("uses dynamic viewport height and prevents horizontal overflow", () => {
    expect(css).toContain("100dvh");
    expect(css).toContain("max-width: 100%");
    expect(css).toContain("overflow-x: hidden");
  });

  it("includes responsive breakpoints that collapse grids on narrow screens", () => {
    expect(css).toContain("@media (max-width:");
    expect(css).toContain("grid-template-columns: 1fr");
    expect(css).toContain("grid-template-columns: repeat(2, 1fr)");
  });

  it("respects safe-area insets for notched devices", () => {
    expect(css).toContain("env(safe-area-inset-left)");
    expect(css).toContain("env(safe-area-inset-right)");
    expect(css).toContain("env(safe-area-inset-bottom)");
  });

  it("prevents mobile browsers from auto-inflating font sizes in landscape", () => {
    expect(css).toContain("text-size-adjust: 100%");
  });
});
