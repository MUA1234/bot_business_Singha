/**
 * Canonical authority for catalogue actions (owner decision, 2026-09-05).
 *
 * ── What the owner authorised, and how narrow it is ──────────────────────────────────────────
 *
 * Exactly ONE canonical action may be automatic: `ops.task.create_internal`. Not a family, not a
 * prefix, not anything that normalises to the same key — that one exact string. Every other
 * registered action stays non-automatic, and the prohibited one stays prohibited.
 *
 * ── Why this does not go through `ACTION_FLOORS` ─────────────────────────────────────────────
 *
 * R2E-F-001: the legacy list is matched on a NORMALISED key — case-folded, unicode-folded,
 * separators stripped. Teaching it `opstaskcreateinternal` would also admit `OPS-TASK-CREATE
 * -INTERNAL`, `ｏｐｓ.ｔａｓｋ.ｃｒｅａｔｅ＿ｉｎｔｅｒｎａｌ` and every other spelling that folds to the same
 * thing. The owner's direction rules out exactly that: no fuzzy matching, no aliases, no prefixes,
 * no normalisation fallbacks, no legacy authority strings.
 *
 * So the legacy list is left alone — `tests/r2e-authority-probe.test.ts` still asserts no catalogue
 * id appears in it — and canonical resolution happens here, on the literal id, with no
 * transformation of any kind between the caller's string and the lookup.
 *
 * ── Why an unknown action resolves to `owner_approval` rather than throwing ──────────────────
 *
 * The executor must be able to record WHY it refused. An exception would be a refusal with no
 * reason, and the ledger would carry a failure where a refusal belongs.
 */
import type { AuthorityLevel } from "@/schemas/management";
import { ACTION_CATALOGUE } from "../catalogue";
import { policyFor } from "./policy";

export interface CanonicalAuthority {
  readonly level: AuthorityLevel;
  /** True when the action could not be resolved and the engine escalated for that reason. */
  readonly failedClosed: boolean;
  /** Whether this action may run with no human approval at all. */
  readonly automatic: boolean;
  readonly reasons: readonly string[];
}

/** The single action the owner authorised as potentially automatic. Exact, canonical, literal. */
export const AUTOMATIC_ACTION_ID = "ops.task.create_internal" as const;

/**
 * Resolve the authority required for a catalogue action, now.
 *
 * `actionId` is compared with `===` against canonical ids. Nothing is lowercased, trimmed,
 * normalised or folded first: `" ops.task.create_internal"` is not that action, and treating it as
 * though it were is the whole class of defect this replaces.
 */
export function resolveCanonicalAuthority(actionId: string): CanonicalAuthority {
  const policy = policyFor(actionId);
  if (!policy) {
    return {
      level: "owner_approval",
      failedClosed: true,
      automatic: false,
      reasons: ["action is not in the canonical execution policy — unknown actions fail closed"],
    };
  }

  const entry = ACTION_CATALOGUE.find((a) => a.id === actionId);
  if (!entry) {
    // A policy without a catalogue entry cannot happen — the policy is keyed on the catalogue's own
    // literal union — but a resolver that assumes its invariants is a resolver that stops enforcing
    // them.
    return {
      level: "owner_approval",
      failedClosed: true,
      automatic: false,
      reasons: ["policy exists but the action is not registered in the catalogue"],
    };
  }

  const reasons: string[] = [`canonical policy floor is ${policy.authorityFloor}`];

  // Automatic requires FOUR independent facts to agree, not one flag. The owner authorised one
  // action; the catalogue must still say it is safe, reversible and internal, and the policy must
  // still be the one that permits an effect at all.
  const automatic =
    policy.authorityFloor === "automatic" &&
    actionId === AUTOMATIC_ACTION_ID &&
    entry.automaticSafe === true &&
    entry.reversible === true &&
    entry.internalOnly === true &&
    policy.classification === "locally_executable";

  if (policy.authorityFloor === "automatic" && !automatic) {
    // A floor of `automatic` that the other facts do not support is a contradiction, and the safe
    // reading of a contradiction is the strict one.
    return {
      level: "manager_approval",
      failedClosed: true,
      automatic: false,
      reasons: [
        ...reasons,
        "policy claims `automatic` but the catalogue entry or classification does not support it",
      ],
    };
  }

  return { level: policy.authorityFloor, failedClosed: false, automatic, reasons };
}

/** The actions that may run with no human approval. Derived, never restated. */
export function automaticActions(): string[] {
  return ACTION_CATALOGUE.map((a) => a.id).filter((id) => resolveCanonicalAuthority(id).automatic);
}
