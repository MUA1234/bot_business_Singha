import { describe, it, expect, afterEach } from "vitest";
import {
  V3_1_FLAG_SPECS,
  isV31FlagEnabled,
  v31FlagSnapshot,
  enabledV31Flags,
  type V31FlagKey,
} from "@/config/flags";

/**
 * The V3.1 feature-flag registry must be DEFAULT OFF in every default environment (zero behaviour
 * change), and a flag may only turn on for the exact string "on" — matching the repo-wide convention
 * in `src/config/env.ts`. These tests also lock the registry's structural invariants.
 */
describe("V3.1 feature-flag registry", () => {
  // Restore any env var a test flips so tests stay independent.
  const touched = new Set<string>();
  afterEach(() => {
    for (const name of touched) delete process.env[name];
    touched.clear();
  });
  const setEnv = (name: string, value: string) => {
    touched.add(name);
    process.env[name] = value;
  };

  it("declares a non-empty registry with unique keys and env vars", () => {
    expect(V3_1_FLAG_SPECS.length).toBeGreaterThan(0);
    const keys = V3_1_FLAG_SPECS.map((s) => s.key);
    const envs = V3_1_FLAG_SPECS.map((s) => s.env);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it("every flag is owner-gated and namespaced V3_1_*", () => {
    for (const spec of V3_1_FLAG_SPECS) {
      expect(spec.ownerGate).toBe(true);
      expect(spec.env.startsWith("V3_1_")).toBe(true);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("is entirely OFF when no env vars are set", () => {
    // Ensure a clean slate for every registered flag.
    for (const spec of V3_1_FLAG_SPECS) {
      touched.add(spec.env);
      delete process.env[spec.env];
    }
    const snapshot = v31FlagSnapshot();
    for (const spec of V3_1_FLAG_SPECS) {
      expect(isV31FlagEnabled(spec.key as V31FlagKey)).toBe(false);
      expect(snapshot[spec.key as V31FlagKey]).toBe(false);
    }
    expect(enabledV31Flags()).toEqual([]);
  });

  it('turns a flag ON only for the exact value "on"', () => {
    const spec = V3_1_FLAG_SPECS[0]!;
    for (const notOn of ["", "off", "true", "1", "ON", "On", "yes"]) {
      setEnv(spec.env, notOn);
      expect(isV31FlagEnabled(spec.key as V31FlagKey)).toBe(false);
    }
    setEnv(spec.env, "on");
    expect(isV31FlagEnabled(spec.key as V31FlagKey)).toBe(true);
    expect(enabledV31Flags()).toContain(spec.key);
  });

  it("reports an unknown key as OFF (fail-closed)", () => {
    expect(isV31FlagEnabled("not_a_real_flag" as V31FlagKey)).toBe(false);
  });
});
