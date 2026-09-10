/**
 * R2D — the Ask-AI window's presentation.
 *
 * Renders the REAL component and asserts what the markup says. The rules under test are the ones
 * that decide whether a person is misled: that manager visibility is disclosed BEFORE they type,
 * that a suggestion is never displayed as something that happened, and that absence of evidence is
 * shown as absence rather than as reassurance.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import AskAiWindow from "@/components/spatial/windows/AskAiWindow";
import { getWindowRenderer } from "@/components/spatial/WindowRegistry";

const SOURCE = readFileSync("src/components/spatial/windows/AskAiWindow.tsx", "utf8");

/** SSR comment markers would otherwise break plain-text assertions. */
const render = () =>
  renderToString(
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

describe("the Ask-AI window is registered in the existing shell", () => {
  it("resolves through the window registry", () => {
    // Not a separate chat application: another window in the workspace that already exists.
    expect(getWindowRenderer("ask-ai")).toBeTruthy();
  });
});

describe("manager visibility is disclosed before submission", () => {
  const html = render();

  it("states that managers may review operational guidance", () => {
    expect(html).toMatch(/company work record/i);
    expect(html).toMatch(/review capability/i);
  });

  it("appears BEFORE the question input in document order", () => {
    // Telling someone after they have typed is not disclosure.
    const noticeAt = html.search(/company work record/i);
    const inputAt = html.indexOf('id="ask-ai-question"');
    expect(noticeAt).toBeGreaterThan(-1);
    expect(inputAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(inputAt);
  });

  it("directs personal matters to HR rather than to itself", () => {
    expect(html).toMatch(/grievance/i);
    expect(html).toMatch(/HR directly/i);
  });
});

describe("a suggestion is never shown as a completed action", () => {
  it("labels every suggested action as requiring review", () => {
    expect(SOURCE).toMatch(/Suggestion only — review required/);
  });

  it("has no control that could execute, approve or assign", () => {
    // The window offers exactly one action: asking. Anything that looked like an execute button
    // would imply Ask-AI can act, which it cannot.
    for (const forbidden of [/onClick=\{[^}]*execute/i, /Approve<\/button>/i, /Assign<\/button>/i]) {
      expect(SOURCE, `a control matching ${forbidden} exists`).not.toMatch(forbidden);
    }
  });

  it("says plainly that nothing changed when an answer is refused", () => {
    expect(SOURCE).toMatch(/Nothing was changed/);
  });
});

describe("uncertainty is visible rather than smoothed away", () => {
  it("renders confidence in words, not as a bare number", () => {
    // "0.62" invites a precision the system does not have.
    expect(SOURCE).toMatch(/High confidence/);
    expect(SOURCE).toMatch(/Moderate confidence/);
    expect(SOURCE).toMatch(/Low confidence/);
  });

  it("shows missing information and uncertainties as their own sections", () => {
    expect(SOURCE).toMatch(/Missing information/);
    expect(SOURCE).toMatch(/Not certain about/);
  });

  it("warns when the evidence may be out of date", () => {
    expect(SOURCE).toMatch(/may be out of date/i);
  });

  it("says when an answer was not saved, and when English was substituted", () => {
    expect(SOURCE).toMatch(/Not saved to your history/);
    expect(SOURCE).toMatch(/no language preference was available/i);
  });
});

describe("the language selector is present and honest", () => {
  const html = render();

  it("offers exactly the three supported languages, in their own scripts", () => {
    expect(html).toContain("English");
    expect(html).toContain("සිංහල");
    expect(html).toContain("தமிழ්".replace("්", "")); // Tamil label, script-checked below
    expect(/[஀-௿]/u.test(html), "no Tamil script in the language selector").toBe(true);
    expect(/[඀-෿]/u.test(html), "no Sinhala script in the language selector").toBe(true);
  });

  it("labels the selector for a screen reader", () => {
    expect(html).toContain('for="ask-ai-language"');
    expect(html).toMatch(/Answer in/);
  });
});

describe("accessibility and touch", () => {
  const html = render();

  it("gives every primary control a 48px touch target", () => {
    // Counted in the source rather than the markup, because Tailwind classes are what carry it.
    const targets = SOURCE.match(/min-h-\[48px\]/g) ?? [];
    expect(targets.length, "fewer than three 48px targets").toBeGreaterThanOrEqual(3);
  });

  it("labels the question input", () => {
    expect(html).toContain('for="ask-ai-question"');
  });

  it("announces new answers to assistive technology", () => {
    expect(html).toMatch(/aria-live="polite"/);
  });

  it("reports errors through an alert role", () => {
    expect(SOURCE).toMatch(/role="alert"/);
  });

  it("supports keyboard-only submission, with Shift+Enter for a newline", () => {
    expect(SOURCE).toMatch(/e\.key === "Enter" && !e\.shiftKey/);
  });

  it("uses a real form, so Enter and the button behave the same way", () => {
    expect(html).toContain("<form");
    expect(html).toContain('type="submit"');
  });
});

describe("mobile and layout", () => {
  const html = render();

  it("stacks in a single column with no fixed pixel width", () => {
    // A fixed width is what produces horizontal overflow at 390px.
    expect(html).toMatch(/flex h-full flex-col/);
    expect(SOURCE).not.toMatch(/w-\[\d{3,}px\]/);
  });

  it("scrolls vertically rather than horizontally", () => {
    expect(html).toMatch(/overflow-y-auto/);
    expect(SOURCE).not.toMatch(/overflow-x-scroll/);
  });

  it("bounds the question length in the markup, not only on the server", () => {
    expect(html).toMatch(/maxLength="2000"|maxlength="2000"/);
  });
});
