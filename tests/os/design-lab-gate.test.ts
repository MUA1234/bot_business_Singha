/**
 * The design lab is a development-only route that renders the real shell
 * against synthetic placeholder values so the interface can be inspected in a
 * browser without a database. It reads no business data and performs no query.
 *
 * It had no test. These lock the gate, because the failure mode is a page that
 * looks like the application, is labelled with a placeholder company, and is
 * reachable by anyone who finds the URL.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const layout = readFileSync("src/app/dev/design-lab/layout.tsx", "utf8");
const envSource = readFileSync("src/config/env.ts", "utf8");

/** Source with comments removed, so an assertion tests code and not prose. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the design lab is refused unless explicitly enabled", () => {
  it("calls notFound() when the flag is off", () => {
    const code = codeOnly(layout);
    expect(code).toContain("notFound()");
    expect(code).toMatch(/if\s*\(!env\.flags\.designLab\(\)\)\s*notFound\(\)/);
  });

  it("is force-dynamic, so the gate runs per request", () => {
    // Without this the route is prerendered at build time and served from the
    // CDN, answering 200 in an environment whose runtime config says 404.
    expect(codeOnly(layout)).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("gates the whole segment from the LAYOUT, not from a page", () => {
    // A page-level check would leave sibling routes in the segment ungated.
    expect(layout).toContain("export default function DesignLabLayout");
  });
});

describe("the design lab flag", () => {
  /**
   * The predicate is replicated here so the INTENT is asserted rather than the
   * presence of a variable name.
   */
  const designLab = (flag: string | undefined, appEnv: string | undefined) =>
    flag === "on" && (appEnv ?? "development") !== "production";

  it("refuses production even when the flag is on", () => {
    expect(designLab("on", "production")).toBe(false);
  });

  it("is off by default in every environment", () => {
    expect(designLab(undefined, undefined)).toBe(false);
    expect(designLab(undefined, "development")).toBe(false);
    expect(designLab(undefined, "staging")).toBe(false);
    expect(designLab(undefined, "production")).toBe(false);
  });

  it("is not enabled by a truthy-but-wrong value", () => {
    for (const v of ["true", "1", "yes", "ON", "enabled"]) {
      expect(designLab(v, "development"), `"${v}" enabled the lab`).toBe(false);
    }
  });

  it("opens only for an explicit 'on' outside production", () => {
    expect(designLab("on", "development")).toBe(true);
    expect(designLab("on", "staging")).toBe(true);
  });

  it("matches the predicate the application actually ships", () => {
    const code = codeOnly(envSource);
    expect(code).toMatch(/NEXT_PUBLIC_DESIGN_LAB === "on"/);
    expect(code).toMatch(/\(process\.env\.APP_ENV \?\? "development"\) !== "production"/);
  });
});

describe("the design lab can never show business data", () => {
  it("renders a placeholder identity, not a real company or user", () => {
    expect(layout).toContain('companyName="Placeholder Company"');
    expect(layout).toContain('username="designlab"');
  });

  it("carries a notice on every screen", () => {
    expect(layout).toContain("LAB_NOTICE");
  });

  it("does not import a database client anywhere in the segment", () => {
    for (const file of [
      "src/app/dev/design-lab/layout.tsx",
      "src/app/dev/design-lab/page.tsx",
      "src/app/dev/design-lab/fixtures.ts",
    ]) {
      const source = codeOnly(readFileSync(file, "utf8"));
      const imports = source.match(/^import .*$/gm) ?? [];
      for (const line of imports) {
        expect(line, `${file} imports a data client`).not.toMatch(
          /supabase|supabaseAdmin|supabaseServer|supabaseReadClient|@\/lib\/db/,
        );
      }
    }
  });
});
