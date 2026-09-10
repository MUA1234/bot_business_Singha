import { describe, it, expect } from "vitest";
import { isolationConfigProblems, isolationDisabledDeliberately, ISOLATION_SETTINGS } from "@/config/env";

/**
 * Production must not start with database isolation disabled by DEFAULT (owner decision 5).
 *
 * The distinction these tests exist to hold is between *off* and *unset*. The repository's flag
 * convention is that a value is on only when it is exactly `"on"`, so an unset switch is
 * indistinguishable from someone having chosen to turn it off — and that is the state production
 * was found in on 2026-09-10 (H-2 / PR-F-012): both switches absent, isolation resting on
 * application code, nothing anywhere recording that as a decision.
 *
 * So absence is a refusal. `off` stays available, because the cutover to `on` is gated on the
 * staging proof, but it has to be typed by a person.
 */

const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => over as NodeJS.ProcessEnv;

describe("isolation configuration must be explicit", () => {
  it("accepts both switches explicitly on", () => {
    expect(isolationConfigProblems(env({ RLS_READS: "on", RLS_WRITES: "on" }))).toEqual([]);
  });

  it("accepts both switches explicitly off — a recorded decision, not a default", () => {
    expect(isolationConfigProblems(env({ RLS_READS: "off", RLS_WRITES: "off" }))).toEqual([]);
  });

  it("REFUSES an unset switch, which is the dangerous case", () => {
    const problems = isolationConfigProblems(env({ RLS_WRITES: "on" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("RLS_READS");
    expect(problems[0]).toContain("not set");
  });

  it("refuses when BOTH are unset, naming both", () => {
    const problems = isolationConfigProblems(env({}));
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toContain("RLS_READS");
    expect(problems.join(" ")).toContain("RLS_WRITES");
  });

  it("refuses an empty string, which reads as unset but looks configured", () => {
    const problems = isolationConfigProblems(env({ RLS_READS: "", RLS_WRITES: "on" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("RLS_READS");
  });

  it("refuses a value that is neither on nor off — a typo must not silently mean off", () => {
    // "true", "1", "ON" and "yes" all evaluate to OFF under the `=== "on"` convention. Someone
    // setting RLS_READS=true believes they enabled it.
    for (const typo of ["true", "1", "ON", "yes", "enabled"]) {
      const problems = isolationConfigProblems(env({ RLS_READS: typo, RLS_WRITES: "on" }));
      expect(problems, `${typo} should be refused`).toHaveLength(1);
      expect(problems[0]).toContain(typo);
    }
  });

  it("covers every declared isolation setting, so adding one cannot skip validation", () => {
    for (const key of ISOLATION_SETTINGS) {
      const allSet = Object.fromEntries(ISOLATION_SETTINGS.map((k) => [k, "on"]));
      delete (allSet as Record<string, string>)[key];
      const problems = isolationConfigProblems(env(allSet));
      expect(problems.some((p) => p.includes(key)), `${key} is declared but not validated`).toBe(true);
    }
  });

  it("the message tells an operator what to do, not just that something is wrong", () => {
    const [msg] = isolationConfigProblems(env({}));
    expect(msg).toMatch(/"on" or "off"/);
    expect(msg!.length).toBeGreaterThan(80);
  });
});

describe("a deliberate disable is reported, not hidden", () => {
  it("is true when either switch is explicitly off", () => {
    expect(isolationDisabledDeliberately(env({ RLS_READS: "off", RLS_WRITES: "on" }))).toBe(true);
    expect(isolationDisabledDeliberately(env({ RLS_READS: "on", RLS_WRITES: "off" }))).toBe(true);
  });

  it("is false when both are on", () => {
    expect(isolationDisabledDeliberately(env({ RLS_READS: "on", RLS_WRITES: "on" }))).toBe(false);
  });
});
