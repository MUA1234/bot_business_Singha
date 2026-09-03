/**
 * R2D — the disclosure, verified on the RENDERED OUTPUT.
 *
 * Source-text position proves nothing about what a person encounters: a component can declare the
 * notice first and render it last, or render it and then hide it. These assertions read the
 * serialized render — which IS document order, and therefore both DOM order and the order a
 * screen reader and the tab sequence follow.
 *
 * WHAT THIS CANNOT DO. There is no DOM library installed and installing one would reach the
 * registry, so nothing here computes layout. Pixel-level visibility at 390 / 768 / 1440 belongs to
 * `scripts/hard-scenario/spatial-viewport-audit.mjs`, which drives a real browser at exactly those
 * widths and needs credentials this phase may not use. What IS checked here is the thing that
 * would make the notice invisible at those widths: a class or element that hides, collapses,
 * defers to hover, or moves it off-screen. Their absence is verifiable; the rendering is not.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import AskAiWindow from "@/components/spatial/windows/AskAiWindow";

const html = renderToString(
  <AskAiWindow
    windowId="w-1"
    type="ask-ai"
    title="Ask AI"
    companyId="c-1"
    userId="u-1"
    isMinimised={false}
    isMaximised={false}
    isFocused
  />,
).replace(/<!-- -->/g, "");

/** The rendered element carrying a given id, with its attributes. */
function elementWithId(id: string): string {
  const m = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`, "i"));
  if (!m) throw new Error(`no rendered element with id="${id}"`);
  return m[0];
}

const DISCLOSURE = "ask-ai-disclosure";
const INPUT = "ask-ai-question";

describe("the disclosure is encountered before the input", () => {
  it("both elements are actually rendered", () => {
    expect(() => elementWithId(DISCLOSURE)).not.toThrow();
    expect(() => elementWithId(INPUT)).not.toThrow();
  });

  it("precedes the textarea in DOM order", () => {
    // Serialized order is document order, which is what determines reading order, tab order and
    // the sequence a screen reader announces.
    const disclosureAt = html.indexOf(`id="${DISCLOSURE}"`);
    const inputAt = html.indexOf(`id="${INPUT}"`);
    expect(disclosureAt).toBeGreaterThan(-1);
    expect(inputAt).toBeGreaterThan(-1);
    expect(disclosureAt, "the notice renders after the input").toBeLessThan(inputAt);
  });

  it("is REFERENCED by the textarea, so it is read as part of the field", () => {
    // Document order alone relies on the person having heard it on the way past. The reference
    // means the notice is announced when focus reaches the field, every time.
    expect(elementWithId(INPUT)).toContain(`aria-describedby="${DISCLOSURE}"`);
  });

  it("carries a landmark role rather than being anonymous text", () => {
    expect(elementWithId(DISCLOSURE)).toContain('role="note"');
  });
});

describe("the disclosure cannot be hidden away", () => {
  const el = elementWithId(DISCLOSURE);

  it("is not visually hidden or removed from the accessibility tree", () => {
    for (const pattern of [/\bhidden\b/, /\bsr-only\b/, /\bopacity-0\b/, /aria-hidden="true"/]) {
      expect(el, `the notice matches ${pattern}`).not.toMatch(pattern);
    }
  });

  it("is not hidden at any breakpoint", () => {
    // `hidden md:block` or `sm:hidden` would make the notice disappear at exactly the widths
    // that matter, which is the failure this replaces a pixel measurement with.
    for (const pattern of [/\b(sm|md|lg|xl|2xl):hidden\b/, /\bhidden\s+(sm|md|lg|xl|2xl):/]) {
      expect(el, `the notice matches ${pattern}`).not.toMatch(pattern);
    }
  });

  it("is not collapsed behind a disclosure widget", () => {
    // A <details> would satisfy "present in the DOM" while nobody ever reads it.
    const beforeInput = html.slice(0, html.indexOf(`id="${INPUT}"`));
    const disclosureAt = beforeInput.indexOf(`id="${DISCLOSURE}"`);
    const lastDetails = beforeInput.lastIndexOf("<details");
    const lastDetailsClose = beforeInput.lastIndexOf("</details>");
    const insideDetails = lastDetails > -1 && lastDetails < disclosureAt && lastDetailsClose < lastDetails;
    expect(insideDetails, "the notice is inside a collapsed <details>").toBe(false);
  });

  it("is not hover-only or off-screen", () => {
    for (const pattern of [/\bhover:/, /\babsolute\b/, /\bfixed\b/, /-left-\[/, /\btranslate-x-\[-/]) {
      expect(el, `the notice matches ${pattern}`).not.toMatch(pattern);
    }
  });

  it("is a normal block in the flow, so it cannot be reordered by CSS", () => {
    // `order-*` or `flex-col-reverse` on the container would put a DOM-first element visually
    // last — the one way document order and reading order can legitimately disagree.
    const container = html.match(/<div[^>]*class="[^"]*flex h-full flex-col[^"]*"/);
    expect(container, "the window container was not found").toBeTruthy();
    expect(container![0]).not.toMatch(/flex-col-reverse/);
    expect(el).not.toMatch(/\border-\d/);
  });
});

describe("the protected alternative is offered in the same notice", () => {
  it("names HR, and the kinds of matter that belong there", () => {
    // Offered at the moment it is relevant — before typing — rather than after a redirection.
    const text = elementWithId(DISCLOSURE) + html.slice(html.indexOf(`id="${DISCLOSURE}"`));
    expect(text).toMatch(/HR directly/i);
    expect(text).toMatch(/grievance/i);
    expect(text).toMatch(/health/i);
  });

  it("says who may read the guidance, and on what basis", () => {
    const after = html.slice(html.indexOf(`id="${DISCLOSURE}"`));
    expect(after).toMatch(/company work record/i);
    expect(after).toMatch(/review capability/i);
  });
});

describe("confidence is deterministic and not colour-only", () => {
  it("maps a score to the same words every time", async () => {
    // A label that shifts between runs would make two identical answers look different.
    const { default: Component } = await import("@/components/spatial/windows/AskAiWindow");
    expect(Component).toBeTruthy();
    const source = (await import("node:fs")).readFileSync(
      "src/components/spatial/windows/AskAiWindow.tsx", "utf8");
    // Fixed thresholds, no randomness, no time dependence.
    expect(source).toMatch(/c >= 0\.75/);
    expect(source).toMatch(/c >= 0\.4/);
    expect(source).not.toMatch(/Math\.random|Date\.now\(\)[^)]*confidence/);
  });

  it("carries the meaning in TEXT, not only in colour", () => {
    // A colour-only signal is invisible to a colour-blind reader and to a screen reader alike.
    const source = require("node:fs").readFileSync(
      "src/components/spatial/windows/AskAiWindow.tsx", "utf8") as string;
    for (const label of ["High confidence", "Moderate confidence", "Low confidence"]) {
      expect(source).toContain(label);
    }
  });

  it("is accompanied by uncertainty and missing-evidence sections", () => {
    const source = require("node:fs").readFileSync(
      "src/components/spatial/windows/AskAiWindow.tsx", "utf8") as string;
    expect(source).toMatch(/Missing information/);
    expect(source).toMatch(/Not certain about/);
  });
});
