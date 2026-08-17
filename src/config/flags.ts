/**
 * V3.1 feature-flag registry — Singha Management Intelligence V3.1.
 *
 * This is the single source of truth for the state of every V3.1 capability flag. It follows the
 * repository's existing convention (see `src/config/env.ts`): a flag is ON only when its environment
 * variable is exactly the string `"on"`; every other value (including unset) is OFF.
 *
 * DEFAULT OFF = ZERO BEHAVIOUR CHANGE. Every flag here is default-off and, in this foundation slice,
 * is read by NO business logic (shadow only). Enabling any flag is an OWNER GATE: it must not be
 * flipped until the owning slice is implemented, tested, and approved for staging UAT
 * (`docs/architecture-v3.1/01_V3_1_EXECUTION_SPEC.md` §4–§6).
 *
 * Nothing here executes anything. A flag being ON only permits its (future) slice code to run behind
 * the usual pipeline: Zod schema → deterministic authority/policy → permission → audit.
 */

/** One V3.1 capability flag and its metadata. */
export interface V31FlagSpec {
  /** Stable programmatic key. */
  readonly key: string;
  /** Environment variable that controls the flag (ON iff value === "on"). */
  readonly env: string;
  /** Enabling this flag requires explicit owner authorisation. Always true for V3.1 capabilities. */
  readonly ownerGate: boolean;
  /** What the flag gates, and which slice owns it. */
  readonly description: string;
}

/**
 * The registry. Order follows the dependency-ordered slice plan in
 * `docs/architecture-v3.1/01_V3_1_EXECUTION_SPEC.md` §5. Add a flag here when its slice begins; never
 * default one to ON.
 */
export const V3_1_FLAG_SPECS = [
  {
    key: "taskDetection",
    env: "V3_1_TASK_DETECTION",
    ownerGate: true,
    description:
      "Slice 2 — task candidate detection, dedupe and Task Intelligence Profile generation (shadow before automation).",
  },
  {
    key: "decisionPaths",
    env: "V3_1_DECISION_PATHS",
    ownerGate: true,
    description:
      "Slice 3 — Decision Path Ladder generation and human authority-checked selection.",
  },
  {
    key: "teamFormation",
    env: "V3_1_TEAM_FORMATION",
    ownerGate: true,
    description:
      "Slice 4 — role-first team requirements and internal/external resource recommendations.",
  },
  {
    key: "aiGuide",
    env: "V3_1_AI_GUIDE",
    ownerGate: true,
    description:
      "Slice 5 — shared in-task AI Guide, Ask-AI, next-action proposals and scoped senior visibility.",
  },
  {
    key: "improvementLoop",
    env: "V3_1_IMPROVEMENT_LOOP",
    ownerGate: true,
    description:
      "Slice 6 — improvement proposals, outcome measurement and evidence-based learning candidates (shadow).",
  },
  {
    key: "managerControlTower",
    env: "V3_1_MANAGER_CONTROL_TOWER",
    ownerGate: true,
    description:
      "Slice 7 — manager Mission Control, exception lanes and decision/team explorers.",
  },
  {
    key: "multilingual",
    env: "V3_1_MULTILINGUAL",
    ownerGate: true,
    description:
      "Slice 8 — per-user English/Sinhala/Tamil experience with original-content preservation.",
  },
  {
    key: "modelRouting",
    env: "V3_1_MODEL_ROUTING",
    ownerGate: true,
    description:
      "Slice 9 — runtime model routing, budget/cache/fallback/kill-switch and cost/outcome telemetry.",
  },
] as const satisfies readonly V31FlagSpec[];

/** Union of valid flag keys, derived from the registry (no free-form strings). */
export type V31FlagKey = (typeof V3_1_FLAG_SPECS)[number]["key"];

/** A flag is ON only when its env var is exactly "on"; unset or any other value is OFF. */
function readEnvFlag(envVar: string): boolean {
  return process.env[envVar] === "on";
}

/** Current state of a single V3.1 flag. Unknown keys are treated as OFF (fail-closed). */
export function isV31FlagEnabled(key: V31FlagKey): boolean {
  const spec = V3_1_FLAG_SPECS.find((s) => s.key === key);
  if (!spec) return false;
  return readEnvFlag(spec.env);
}

/** Immutable snapshot of every V3.1 flag's current state — handy for health/telemetry surfaces. */
export function v31FlagSnapshot(): Record<V31FlagKey, boolean> {
  const out = {} as Record<V31FlagKey, boolean>;
  for (const spec of V3_1_FLAG_SPECS) {
    out[spec.key as V31FlagKey] = readEnvFlag(spec.env);
  }
  return out;
}

/** Keys of flags that are currently enabled. Empty in every default environment. */
export function enabledV31Flags(): V31FlagKey[] {
  return V3_1_FLAG_SPECS.filter((s) => readEnvFlag(s.env)).map((s) => s.key as V31FlagKey);
}
