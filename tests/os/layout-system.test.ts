/**
 * Regressions for the site-wide layout and typography correction.
 *
 * A rendered-DOM audit of the authenticated application across 25 screens and
 * 5 viewports found four systemic defects, each caused by a single shared rule
 * rather than by any individual screen:
 *
 *   1. `overflow-wrap: anywhere` on .mono/.badge broke 191 single words at an
 *      arbitrary character — "POSTED" as "POSTE / D", "View" as "Vie / w".
 *   2. Fixed rem sizes for body/data/small/label rendered 1,697 pieces of text
 *      at 11.2px on a 1920px monitor.
 *   3. `repeat(N, minmax(0, 1fr))` forced equal columns with a zero floor, so
 *      cards were measured up to 569px narrower than their own min-content.
 *   4. Tables distributed width by content pressure, with no allocation by
 *      information type, so a 6-character status label landed in a ~50px column.
 *
 * These tests assert the SHAPE of the shared rules. They are deliberately
 * source-level: the visual proof is the audit harness
 * (scripts/verify/layout-audit.mjs), which measures the real rendered DOM and
 * cannot run in a unit suite.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const globals = readFileSync("src/app/globals.css", "utf8");
const tokens = readFileSync("src/styles/tokens.css", "utf8");
const shell = readFileSync("src/styles/shell.css", "utf8");
const instruments = readFileSync("src/styles/instruments.css", "utf8");

/** CSS with comments removed, so an assertion tests rules and not prose. */
function rulesOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("wrapping discipline", () => {
  const css = rulesOnly(globals);

  it("never applies overflow-wrap:anywhere to short-label elements", () => {
    // The original rule was `.mono, td, .badge { overflow-wrap: anywhere; }`.
    // `anywhere` may survive only behind an explicit opt-in class.
    const anywhereRules = css.split("}").filter((r) => /overflow-wrap:\s*anywhere/.test(r));
    for (const rule of anywhereRules) {
      const selector = rule.split("{")[0] ?? "";
      expect(
        /allow-break|allow-wrap|mono-block|pre/.test(selector),
        `overflow-wrap:anywhere applied unconditionally to "${selector.trim()}"`,
      ).toBe(true);
    }
  });

  it("protects the short labels the audit found breaking", () => {
    // Each of these was observed splitting mid-word in the real application.
    const nowrapBlock = css.match(/\.badge,[\s\S]*?white-space:\s*nowrap;\s*\}/);
    expect(nowrapBlock, "the shared nowrap block is missing").toBeTruthy();
    for (const sel of [".badge", ".sig", ".prov-label", ".matter-kind", ".btn"]) {
      expect(nowrapBlock![0]).toContain(sel);
    }
  });

  it("keeps reference codes and filenames on one line", () => {
    expect(css).toMatch(/\.mono\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.filename\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.filename\s*\{[^}]*text-overflow:\s*ellipsis/);
  });

  it("still lets genuine prose wrap", () => {
    // A memo, a description and an explicitly-marked cell must wrap normally —
    // the fix must not turn into a blanket nowrap.
    expect(css).toMatch(/td\.memo[^{]*\{[^}]*white-space:\s*normal/);
    expect(css).toContain(".allow-wrap");
    expect(css).toMatch(/\.mono\.allow-wrap[^{]*\{[^}]*white-space:\s*pre-wrap/);
  });
});

describe("typography scale", () => {
  const css = rulesOnly(tokens);

  it("declares a token for every role the interface needs", () => {
    for (const role of [
      "--t-page-title",
      "--t-section-title",
      "--t-subsection",
      "--t-value",
      "--t-body",
      "--t-body-2",
      "--t-data",
      "--t-small",
      "--t-label",
      "--t-meta",
    ]) {
      expect(css, `${role} is not declared`).toContain(`${role}:`);
    }
  });

  it("makes every operational size responsive, not a fixed rem", () => {
    // The defect was that body/data/small/label were pinned, so a 1920px
    // monitor got phone-sized text. Each must now scale with the viewport.
    for (const role of ["--t-body", "--t-body-2", "--t-data", "--t-small", "--t-label", "--t-meta"]) {
      const decl = css.match(new RegExp(`${role}:\\s*([^;]+);`));
      expect(decl, `${role} is not declared`).toBeTruthy();
      expect(decl![1], `${role} must use clamp() to scale`).toContain("clamp(");
    }
  });

  it("never lets a role floor below a legible size", () => {
    // The floor of each clamp is the phone size. 0.7rem = 11.2px was the value
    // the audit flagged 1,697 times; nothing may sit at or below it.
    const roles = css.matchAll(/--t-(?:body|body-2|data|small|label|meta):\s*clamp\(([0-9.]+)rem/g);
    const floors = [...roles].map((m) => Number(m[1]));
    expect(floors.length).toBeGreaterThanOrEqual(6);
    for (const floor of floors) {
      expect(floor * 16, `a role floors at ${floor * 16}px`).toBeGreaterThan(11.5);
    }
  });

  it("does not reintroduce a hard-coded 0.7rem anywhere in the shell", () => {
    expect(rulesOnly(shell)).not.toMatch(/font-size:\s*0\.7rem/);
  });
});

describe("grid and panel sizing", () => {
  it("sizes shared column utilities intrinsically, not equally", () => {
    const css = rulesOnly(globals);
    // cols-N is a MAXIMUM count that reflows, not N equal zero-floor tracks.
    for (const n of ["cols-2", "cols-3", "cols-4"]) {
      const rule = css.match(new RegExp(`\\.grid\\.${n}\\s*\\{([^}]*)\\}`));
      expect(rule, `.grid.${n} is missing`).toBeTruthy();
      expect(rule![1], `.grid.${n} still forces equal columns`).toContain("auto-fit");
      expect(rule![1], `.grid.${n} still has a zero floor`).not.toContain("minmax(0,");
    }
  });

  it("gives every auto-fit track a real minimum guarded by min(100%, …)", () => {
    // Without the min(100%, …) wrapper a track wider than a phone viewport
    // overflows instead of reflowing to one column.
    for (const [name, source] of [["globals", globals], ["instruments", instruments], ["shell", shell]] as const) {
      const tracks = rulesOnly(source).matchAll(/repeat\(auto-fi[tl][^)]*,\s*minmax\(([^,]+),/g);
      for (const t of tracks) {
        const floor = (t[1] ?? "").trim();
        expect(floor, `${name}: auto-fit track floor "${floor}" is unguarded`).toContain("min(100%");
      }
    }
  });

  it("declares column widths by information type", () => {
    const css = rulesOnly(tokens);
    for (const col of ["--col-date", "--col-status", "--col-money", "--col-action", "--col-ref", "--col-text-min"]) {
      expect(css, `${col} is not declared`).toContain(`${col}:`);
    }
    // The dominant column must be the widest minimum of the set.
    const textMin = Number(css.match(/--col-text-min:\s*(\d+)px/)?.[1] ?? 0);
    expect(textMin).toBeGreaterThanOrEqual(240);
  });

  it("lets a numeric or status column grow to fit its own heading", () => {
    // `width` alone let a column be sized below its header text.
    const css = rulesOnly(globals);
    for (const col of ["col-date", "col-status", "num"]) {
      expect(css).toMatch(new RegExp(`th\\.${col}\\s*\\{[^}]*min-width:\\s*max-content`));
    }
  });
});

describe("the working canvas uses the available width", () => {
  it("scales the canvas cap with the viewport instead of pinning it", () => {
    const css = rulesOnly(tokens);
    const cap = css.match(/--canvas-max:\s*([^;]+);/);
    expect(cap, "--canvas-max is not declared").toBeTruthy();
    expect(cap![1] ?? "", "--canvas-max must be fluid").toContain("clamp(");
    // A 1920 monitor must be allowed more than the old fixed 1680px cap.
    const ceiling = Number((cap?.[1] ?? "").match(/,\s*(\d+)px\s*\)/)?.[1] ?? 0);
    expect(ceiling).toBeGreaterThan(1680);
  });

  it("has no surface still pinned to the old fixed cap", () => {
    for (const [name, source] of [["globals", globals], ["shell", shell]] as const) {
      expect(rulesOnly(source), `${name} still pins 1680px`).not.toContain("1680px");
    }
  });
});

describe("text is never resampled by a 3D transform", () => {
  /**
   * The Command Centre's two columns carried translateZ(-30px) and
   * translateZ(28px) under the composition's 1800px perspective. Perspective
   * turns a Z translation into a SCALE: measured on the real page, a column
   * with a layout width of 943px rendered at 958.03px — 1.0159x. A composited
   * layer is rasterised once and the bitmap resampled, so every glyph in both
   * panels was resampled by a non-integer factor and the whole screen read as
   * very slightly out of focus.
   *
   * Depth on a text-bearing surface must therefore come from cues that do not
   * change its rendered size: shadow, edge light, contrast, opacity.
   */
  it("does not translate the Command Centre columns in Z", () => {
    const css = rulesOnly(instruments);
    const centreRules = css
      .split("}")
      .filter((r) => /\.centre\s*>\s*\.centre-(summary|action)/.test(r.split("{")[0] ?? ""));
    expect(centreRules.length, "the Command Centre depth rules are missing").toBeGreaterThan(0);
    for (const rule of centreRules) {
      expect(rule, "a Command Centre column still uses translateZ").not.toMatch(/translateZ/);
      expect(rule, "a Command Centre column still uses scale()").not.toMatch(/transform:[^;]*scale\(/);
    }
  });

  it("still expresses the near/far distinction", () => {
    // Removing the transform must not remove the hierarchy it carried.
    const css = rulesOnly(instruments);
    expect(css).toMatch(/\.centre\s*>\s*\.centre-summary[^{]*\{[^}]*(shadow-recessed|opacity)/);
    expect(css).toMatch(/\.centre\s*>\s*\.centre-action[^{]*\{[^}]*shadow-priority/);
  });
});

describe("a nowrap rule never escapes onto prose", () => {
  /**
   * `.dim.small` was made nowrap so table dates would not split. That pair is
   * also used for prose captions — the cash-forecast note is one — and a nowrap
   * BLOCK keeps its box at the container width while the glyphs run straight
   * out of it and across the panel beside it. The box measures as fitting, so
   * no box-based check can see it.
   */
  it("scopes metadata nowrap to table cells only", () => {
    const css = rulesOnly(globals);
    const nowrapRules = css.split("}").filter((r) => /white-space:\s*nowrap/.test(r));
    let checked = 0;
    for (const rule of nowrapRules) {
      const selector = rule.split("{")[0] ?? "";
      // A selector list is checked PART BY PART. Testing the whole list for the
      // word "table" passes as soon as any one part is table-scoped, which is
      // how an unscoped `.dim.small` could sit beside `table.data td.dim` and
      // go unnoticed.
      for (const part of selector.split(",").map((s) => s.trim()).filter(Boolean)) {
        checked++;
        const scopedToTable = /\btable\b|\btd\b|\bth\b/.test(part);
        for (const pair of [".dim.small", ".small.dim"]) {
          if (part.includes(pair)) {
            expect(
              scopedToTable,
              `"${part}" makes ${pair} nowrap outside a table — that pair is also used for prose captions`,
            ).toBe(true);
          }
        }
        // A bare `.meta` or a bare `.v` is likewise too broad: `.matter-fact .v`
        // holds a record description.
        expect(
          /^\.meta$/.test(part),
          `"${part}" makes a bare .meta nowrap`,
        ).toBe(false);
        expect(
          /^\.v$/.test(part),
          `"${part}" makes a bare .v nowrap — .matter-fact .v holds prose`,
        ).toBe(false);
      }
    }
    // Guard against the loop silently doing nothing.
    expect(checked).toBeGreaterThan(10);
  });

  it("keeps table dates from splitting by scoping to the cell", () => {
    const css = rulesOnly(globals);
    expect(css).toMatch(/table\.data td\s*\{[^}]*white-space:\s*nowrap/);
  });
});

describe("dense tables stay usable on a phone", () => {
  const css = rulesOnly(globals);

  it("offers a stacked record view below the tablet breakpoint", () => {
    expect(css).toContain("table.data.stacks");
    // The column heading must travel with the value, or the stacked view is
    // a list of unlabelled strings.
    expect(css).toMatch(/table\.data\.stacks td\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/);
  });

  it("keeps a horizontal scroll owner for tables that stay tabular", () => {
    expect(css).toMatch(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
  });
});
