/**
 * The interpretation adapter boundary (R1 — owner decision R1-D-6).
 *
 * This is the ONE place a model would ever connect. R0–R3 are free of paid and live model
 * calls, so R1 ships a deterministic fixture adapter and proves the boundary by contract.
 *
 * The point of building it now is the failure modes. A management loop that stops when a
 * model misbehaves is not an operating system, so every degraded case is handled and
 * RECORDED here rather than discovered in production:
 *
 *   malformed       — output failed validation, or cited evidence the item does not hold
 *   timeout         — the adapter did not answer within its budget
 *   low_confidence  — answered, but below the threshold to influence a recommendation
 *   disagreement    — two interpretations conflict; the kernel must not pick a winner
 *   unavailable     — no adapter configured, or budget exhausted
 *
 * In EVERY degraded case the loop continues deterministically on the detector's structured
 * facts, with confidence reduced and the reason recorded. It degrades to a rules engine
 * rather than going blind.
 */
import type { EvidenceRef, Interpretation, InterpretationStatus, Observation } from "./types";
import { unsupportedClaims } from "./invariants";

/** Below this, an interpretation is recorded but may not influence a recommendation. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export interface InterpreterAdapter {
  readonly name: string;
  readonly source: "fixture" | "model";
  /** Must resolve within `budgetMs`; the caller enforces the timeout regardless. */
  interpret(o: Observation, signal: { budgetMs: number }): Promise<Interpretation>;
}

/** The deterministic, always-degraded result used whenever a model cannot be trusted. */
export function deterministicFallback(status: InterpretationStatus, note: string): Interpretation {
  return { source: "none", status, statements: [], confidence: 0, note };
}

/**
 * Run an interpretation through the boundary, applying every guard.
 *
 * The returned Interpretation is ALWAYS safe to store: it is either `ok` and grounded in
 * recorded evidence, or it is a degraded result carrying zero statements. A caller can
 * never receive an ungrounded claim from this function.
 */
export async function interpretWithGuards(
  o: Observation,
  evidence: EvidenceRef[],
  adapter: InterpreterAdapter | null,
  opts: { budgetMs?: number; now?: () => number } = {},
): Promise<Interpretation> {
  const budgetMs = opts.budgetMs ?? 5_000;

  if (!adapter) {
    return deterministicFallback("unavailable", "no interpreter adapter configured");
  }

  let raw: Interpretation;
  try {
    raw = await withTimeout(adapter.interpret(o, { budgetMs }), budgetMs);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === TIMEOUT) {
      return deterministicFallback("timeout", `interpreter "${adapter.name}" exceeded ${budgetMs}ms`);
    }
    return deterministicFallback("malformed", `interpreter "${adapter.name}" threw: ${msg}`);
  }

  // Shape validation. A malformed envelope is not partially trusted.
  if (!raw || !Array.isArray(raw.statements) || typeof raw.confidence !== "number" || Number.isNaN(raw.confidence)) {
    return deterministicFallback("malformed", `interpreter "${adapter.name}" returned an invalid envelope`);
  }
  if (raw.confidence < 0 || raw.confidence > 1) {
    return deterministicFallback("malformed", `confidence ${raw.confidence} is outside [0,1]`);
  }

  // THE CENTRAL GUARD: a claim not supported by recorded evidence is an invented fact.
  // The whole interpretation is discarded — not just the bad claim — because an interpreter
  // that fabricated one statement has not earned trust in the others.
  const bad = unsupportedClaims({ ...raw, statements: raw.statements }, evidence);
  if (bad.length > 0) {
    return deterministicFallback(
      "malformed",
      `rejected ${bad.length} claim(s) unsupported by recorded evidence: ${bad.join("; ")}`,
    );
  }

  if (raw.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return { ...raw, source: adapter.source, status: "low_confidence", note: `confidence ${raw.confidence} below ${LOW_CONFIDENCE_THRESHOLD}` };
  }

  return { ...raw, source: adapter.source, status: "ok" };
}

/**
 * Two interpretations of the same observation that contradict each other.
 *
 * The kernel does NOT arbitrate. Disagreement is surfaced as a clarification for a human,
 * because silently choosing one of two conflicting readings is exactly how an automated
 * system produces confident nonsense.
 */
export function detectDisagreement(a: Interpretation, b: Interpretation): Interpretation | null {
  if (a.status !== "ok" || b.status !== "ok") return null;
  const claimsA = new Set(a.statements.map((s) => s.claim));
  const claimsB = new Set(b.statements.map((s) => s.claim));
  const onlyA = [...claimsA].filter((c) => !claimsB.has(c));
  const onlyB = [...claimsB].filter((c) => !claimsA.has(c));
  if (onlyA.length === 0 && onlyB.length === 0) return null;
  return {
    source: "none",
    status: "disagreement",
    statements: [],
    confidence: 0,
    note: `interpretations disagree — only-A: [${onlyA.join("; ")}], only-B: [${onlyB.join("; ")}]`,
  };
}

/** May this interpretation influence a recommendation? */
export function mayInfluenceRecommendation(i: Interpretation): boolean {
  return i.status === "ok";
}

const TIMEOUT = "__kernel_interpret_timeout__";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(TIMEOUT)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * The R1 fixture adapter.
 *
 * Deterministic: the same observation always yields the same interpretation, so tests are
 * reproducible and no network call occurs. It only ever restates facts the detector already
 * recorded, each cited to the evidence it came from — which is precisely the behaviour a
 * real model will be held to at this boundary.
 */
export function fixtureInterpreter(
  fixtures: Record<string, Interpretation> = {},
): InterpreterAdapter {
  return {
    name: "r1-fixture",
    source: "fixture",
    async interpret(o: Observation): Promise<Interpretation> {
      const hit = fixtures[o.kind] ?? fixtures[o.identityKey];
      if (hit) return hit;
      // Default: restate each evidence reference as a grounded claim.
      return {
        source: "fixture",
        status: "ok",
        confidence: 0.9,
        statements: o.evidence.map((e) => ({
          claim: `${o.kind} observed on ${e.sourceTable}:${e.sourceId}`,
          supportedBy: [{ sourceTable: e.sourceTable, sourceId: e.sourceId }],
        })),
      };
    },
  };
}
