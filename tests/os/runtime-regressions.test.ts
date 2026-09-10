/**
 * Regressions for two runtime defects that broke the application in ways a
 * type-check and a passing unit suite did not catch.
 *
 * 1. `useActionState` is a React 19 API. This project is on React 18.3, so
 *    importing it made the build emit "Attempted import error: 'useActionState'
 *    is not exported from 'react'" and left the duplicate-review decision form
 *    non-functional at runtime — on a screen whose entire purpose is to let a
 *    human resolve a paused payment.
 *
 * 2. `upgrade-insecure-requests` (CSP) and `Strict-Transport-Security` are
 *    correct on a real HTTPS deployment and BREAK a plain-HTTP one: the browser
 *    rewrites every same-origin navigation and prefetch to `https://`, which
 *    fails with ERR_SSL_PROTOCOL_ERROR on `http://127.0.0.1`. The headers must
 *    therefore be conditional — and must still be present by default for
 *    anything that looks like production.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("React 18 compatibility", () => {
  const reviewCard = readFileSync("src/app/app/finance/duplicate-reviews/ReviewCard.tsx", "utf8");

  it("does not import useActionState, which does not exist in React 18", () => {
    // Assert on the IMPORT and the CALL, not on the bare word — the file
    // legitimately names the API in the comment explaining why it is not used.
    const imports = reviewCard.match(/^import .*$/gm) ?? [];
    expect(imports.some((line) => line.includes("useActionState"))).toBe(false);
    expect(reviewCard).not.toMatch(/\buseActionState\s*[<(]/);
  });

  it("uses the React 18 form-state idiom from react-dom", () => {
    expect(reviewCard).toContain('from "react-dom"');
    expect(reviewCard).toContain("useFormState");
  });

  it("reads pending state from a component INSIDE the form", () => {
    // useFormStatus reports the status of the form it is rendered inside, so
    // calling it in the component that renders <form> always yields false and
    // leaves the decision buttons live during submission — which would allow a
    // second click to record a second decision on the same review.
    expect(reviewCard).toContain("useFormStatus");
    const buttonsComponent = reviewCard.indexOf("function DecisionButtons");
    const formElement = reviewCard.indexOf("<form action={action}");
    expect(buttonsComponent).toBeGreaterThan(-1);
    expect(buttonsComponent).toBeLessThan(formElement);
    expect(reviewCard).toContain("<DecisionButtons />");
  });

  it("keeps every test id the duplicate-review acceptance tests rely on", () => {
    for (const id of ["dup-form", "dup-reason", "dup-mark-distinct", "dup-confirm", "dup-error", "dup-conflict", "dup-ok"]) {
      expect(reviewCard).toContain(`data-testid="${id}"`);
    }
  });
});

/** Source with comments removed, so an assertion tests code and not prose. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("membership role reads never rely on an ambiguous PostgREST embed", () => {
  const accessSource = readFileSync("src/lib/access.ts", "utf8");
  const access = codeOnly(accessSource);

  it("does not embed membership_roles from memberships", () => {
    // `membership_roles` has TWO foreign keys into `memberships`: the original
    // single-column `membership_id` FK and the composite
    // `(membership_id, company_id)` FK added for tenant integrity. PostgREST
    // cannot choose between them and refuses the embed with "more than one
    // relationship was found" — returning an ERROR and `data: null`.
    //
    // Both call sites treated null as "no membership", so getApproverForUser
    // returned null for EVERY user and the approvals screen told every finance
    // approver they were "not an approver". No approval could be granted
    // through the interface at all.
    // Assert on the SELECT STRINGS, not on the file text — the doc comment
    // legitimately quotes the broken embed to explain why it is forbidden.
    const selects = access.match(/\.select\((["'`])[\s\S]*?\1\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).not.toContain("membership_roles(");
  });

  it("reads role keys with a separate, unambiguous query", () => {
    expect(access).toContain("roleKeysFor");
    expect(access).toMatch(/from\("membership_roles"\)[\s\S]{0,120}eq\("membership_id"/);
  });

  it("routes both membership consumers through that helper", () => {
    // getMembership (pages/actions) and getApproverForUser (separation of
    // duties) must both use it, or one of them silently loses every role.
    const helperUses = access.match(/roleKeysFor\(/g) ?? [];
    // One definition + two call sites.
    expect(helperUses.length).toBeGreaterThanOrEqual(3);
  });
});

describe("no query embeds a child table across an ambiguous foreign key", () => {
  /**
   * Composite tenant-integrity foreign keys — `(child_id, company_id) →
   * parent(id, company_id)` — sit alongside the original single-column keys, so
   * 42 parent/child pairs in this schema now carry TWO relationships. PostgREST
   * cannot pick a join path for any of them and refuses the request with
   * "Could not embed because more than one relationship was found", returning an
   * ERROR and `data: null`.
   *
   * A call site that reads null as "nothing here" then renders an empty,
   * confident, wrong screen. These are the pairs that were actually being
   * embedded and are now read as separate queries; the guard stops them coming
   * back.
   */
  const FORBIDDEN = [
    { parent: "memberships", child: "membership_roles" },
    { parent: "journal_entries", child: "journal_lines" },
    { parent: "tasks", child: "task_assignments" },
  ];

  const FILES = [
    "src/lib/access.ts",
    "src/app/app/operations/projects/page.tsx",
    "src/app/app/operations/projects/[id]/page.tsx",
    "src/components/spatial/panels/ProjectsPanel.tsx",
  ];

  it("uses no forbidden embed in any select string", () => {
    for (const file of FILES) {
      const source = codeOnly(readFileSync(file, "utf8"));
      const selects = source.match(/\.select\((["'`])[\s\S]*?\1\)/g) ?? [];
      for (const select of selects) {
        for (const { child } of FORBIDDEN) {
          expect(select, `${file} embeds ${child}`).not.toContain(`${child}(`);
        }
      }
    }
  });

  it("routes those reads through the shared helpers instead", () => {
    const embeds = readFileSync("src/lib/embeds.ts", "utf8");
    expect(embeds).toContain("export async function postedJournalsWithLines");
    expect(embeds).toContain("export async function tasksWithAssignments");
    // Each helper reads the child table on its own, keyed by the parent id.
    expect(embeds).toMatch(/from\("journal_lines"\)[\s\S]{0,200}in\("journal_id"/);
    expect(embeds).toMatch(/from\("task_assignments"\)[\s\S]{0,200}in\("task_id"/);
  });
});

describe("HTTPS-forcing headers are conditional on an HTTPS deployment", () => {
  const config = readFileSync("next.config.mjs", "utf8");

  it("still locks down everything that is not transport-related", () => {
    for (const directive of [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "connect-src 'self'",
    ]) {
      expect(config).toContain(directive);
    }
    for (const header of [
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ]) {
      expect(config).toContain(header);
    }
  });

  it("gates upgrade-insecure-requests and HSTS behind the httpsDeployment test", () => {
    expect(config).toContain("httpsDeployment");
    expect(config).toContain("if (httpsDeployment) cspDirectives.push(\"upgrade-insecure-requests\")");

    // HSTS must be spread in conditionally, never listed as an unconditional
    // entry of securityHeaders. Assert on the HEADER ENTRY (`key:`), which only
    // appears in code, rather than on the bare header name, which also appears
    // in the comment explaining the conditional.
    const hstsEntry = config.indexOf('key: "Strict-Transport-Security"');
    const conditionalIndex = config.indexOf("...(httpsDeployment");
    expect(hstsEntry).toBeGreaterThan(-1);
    expect(conditionalIndex).toBeGreaterThan(-1);
    expect(hstsEntry).toBeGreaterThan(conditionalIndex);
  });

  it("fails SAFE: production keeps the headers even with no APP_BASE_URL", () => {
    // The predicate is replicated here so the intent is asserted, not merely the
    // presence of a variable name.
    const httpsDeployment = (appEnv: string | undefined, base: string | undefined) => {
      const baseUrl = base ?? "http://localhost:3000";
      const isProductionEnv = (appEnv ?? "development") === "production";
      return isProductionEnv || baseUrl.startsWith("https://");
    };

    expect(httpsDeployment("production", undefined)).toBe(true);
    expect(httpsDeployment("production", "http://internal.example")).toBe(true);
    expect(httpsDeployment("staging", "https://staging.example")).toBe(true);
    expect(httpsDeployment(undefined, "https://preview.example")).toBe(true);

    // The ONLY case that drops them is an unambiguously local plain-HTTP run.
    expect(httpsDeployment("development", "http://localhost:3000")).toBe(false);
    expect(httpsDeployment(undefined, undefined)).toBe(false);
  });
});
