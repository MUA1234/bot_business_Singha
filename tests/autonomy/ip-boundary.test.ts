/**
 * IP-001 — public-repository intellectual-property boundary.
 *
 * The repository is public. This test exercises the automated boundary check
 * (scripts/autonomy/check-ip-boundary.mjs) that is part of `npm run verify`.
 * It asserts that the current tracked tree contains no hard IP-boundary
 * violations: no server-only modules imported by client components, no tracked
 * private-key material, and no proprietary paths that must never be public.
 *
 * Soft findings (public system prompts, public env vars named like secrets) are
 * reported for review but do not fail the check; they are recorded in
 * docs/autonomy/IP_BOUNDARY_MANIFEST.md.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

describe("IP-001 public-repository IP boundary", () => {
  it("check-ip-boundary passes with no hard violations", () => {
    const out = execSync("node scripts/autonomy/check-ip-boundary.mjs", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(out).toContain("autonomy:ip-check");
    expect(out).toContain("hard=0");
    expect(out).toContain("✅ autonomy:ip-check: no hard IP-boundary violation among tracked files.");
  });

  it("check-ip-boundary --quiet still exits cleanly", () => {
    const out = execSync("node scripts/autonomy/check-ip-boundary.mjs --quiet", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(out).toBe("");
  });
});
