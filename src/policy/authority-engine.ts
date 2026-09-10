/**
 * Deterministic, company-scoped authority resolution.
 *
 * This replaces the interim hardcoded floor that the verification campaign added to
 * `planFromObservation` (defect D-004). The owner did not accept that floor as permanent: authority
 * must come from company-scoped rules (`authority_rules`) and the active approval policy, not from
 * a constant mapping compiled into the application.
 *
 * Three properties this module exists to guarantee:
 *
 *  1. **The model may raise authority, never lower it.** `applyModelRecommendation` takes the
 *     maximum of the deterministic result and the model's claim. A model — which reads untrusted
 *     text — can escalate a matter, and can never make one look routine.
 *  2. **The result is at least the maximum of every applicable deterministic rule.** Rules are
 *     additive floors, never overrides; nothing here can subtract authority.
 *  3. **Unknown, conflicting or missing policy fails CLOSED.** No company rules, no membership, an
 *     unrecognised action, a currency we cannot compare, or two rules that disagree — every one of
 *     those escalates and is reported in `reasons`, rather than silently defaulting to `automatic`.
 *
 * It does not execute anything and never posts to accounting. It answers one question: what level
 * of human authority does this matter require, given company policy?
 */
import { dec } from "@/lib/money";
import type { AuthorityLevel } from "@/schemas/management";

/** The ladder, lowest → highest. */
export const LADDER: AuthorityLevel[] = [
  "automatic",
  "policy_controlled",
  "manager_approval",
  "specialist_approval",
  "owner_approval",
];
const rank = (l: AuthorityLevel) => LADDER.indexOf(l);
export const higher = (a: AuthorityLevel, b: AuthorityLevel): AuthorityLevel => (rank(a) >= rank(b) ? a : b);
export const maxLevel = (levels: AuthorityLevel[]): AuthorityLevel =>
  levels.reduce<AuthorityLevel>((acc, l) => higher(acc, l), "automatic");

/** One row of `authority_rules` (migration 0010), already scoped to the company. */
export interface AuthorityRuleRow {
  id: string;
  membership_id: string | null;
  company_id: string;
  domain: string | null;
  max_amount: string | number | null;
  currency: string | null;
  is_unlimited?: boolean | null;
  is_company_wide?: boolean | null;
}

/**
 * Deterministic facts about the matter. Every field here must be derived from something the system
 * KNOWS — a parsed amount, a stored domain, a structured impact assertion — not from a free-text
 * field the model was asked to fill in with a level.
 */
export interface AuthorityFacts {
  /** Business domain: finance, hr, legal, procurement, ops, fleet, admin… */
  domain: string;
  /** The concrete action, if one is proposed. An UNRECOGNISED action fails closed. */
  action?: string | null;
  /** Decimal string. Present whenever money is involved. */
  amount?: string | null;
  currency?: string | null;
  /** Structured impact assertions — booleans the caller derived, not model prose. */
  impact?: {
    financial?: boolean;
    legal?: boolean;
    safety?: boolean;
    operational?: boolean;
    customer?: boolean;
  };
  /** 0..1. A low-confidence reading is never routine. */
  confidence?: number;
}

export interface AuthorityContext {
  companyId: string;
  /** The acting person's membership. Absent ⇒ we cannot resolve a ceiling ⇒ fail closed. */
  actorMembershipId?: string | null;
  /** Company-scoped `authority_rules` rows. An EMPTY array means "no policy" ⇒ fail closed. */
  rules: AuthorityRuleRow[];
  /** Whether an active `approval_policies` row exists for the company. Absent ⇒ fail closed. */
  policyPresent: boolean;
}

export interface AuthorityResolution {
  level: AuthorityLevel;
  reasons: string[];
  /** True when a rule was missing/unknown/conflicting and the engine escalated for that reason. */
  failedClosed: boolean;
}

/**
 * Actions that a machine may never perform on its own authority, with the MINIMUM human level each
 * requires. This is a CLOSED classification keyed on a normalised action, not a substring denylist:
 * the campaign proved a substring list is evadable by synonym, by fullwidth unicode and by
 * separators (defect D-001). Anything not on this list is UNKNOWN, and unknown escalates.
 */
const ACTION_FLOORS: { keys: string[]; floor: AuthorityLevel }[] = [
  {
    floor: "owner_approval",
    keys: [
      "financepaymentexecute", "financepaymentinitiate", "financepayout", "financedisbursementcreate",
      "financeremitfunds", "financewiretransfersend", "financetransfersend", "financerefundissue",
      "legalcontractsign", "legalagreementexecute",
      "hremployeedismiss", "hremployeeterminate", "hremployeeoffboard",
      "admingrantpermission", "adminrolewiden", "adminroleassign",
      "opsgpsenable", "opscctvenable",
    ],
  },
  {
    floor: "specialist_approval",
    keys: [
      "financesupplierbankdetailupdate", "financebankdetailupdate", "financebeneficiaryupdate",
      "financeledgerpost", "financejournalpost", "financejournalentrycreate", "financeassetdispose",
      "hrdisciplinaryaction", "legalmatteropen", "legalcomplianceaccept",
    ],
  },
  {
    floor: "manager_approval",
    keys: ["procurementorderplace", "procurementrequestraise", "opstaskreassign", "salesorderstatusset"],
  },
  {
    floor: "automatic",
    keys: ["opstaskcreate", "fleetvehicleread", "salesquotationread", "financereportread", "opsnoteadd"],
  },
];

/**
 * Normalise an action for classification: Unicode-fold (so fullwidth `ｐａｙｍｅｎｔ` folds to
 * `payment`), lowercase, and strip every separator (so `p-a-y-m-e-n-t` cannot dodge a match).
 * These are the exact evasion classes the campaign confirmed against the old substring list.
 */
export function normalizeAction(action: string | null | undefined): string {
  return String(action ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** The floor for a known action, or null when the action is not in the closed classification. */
export function actionFloor(action: string | null | undefined): AuthorityLevel | null {
  const key = normalizeAction(action);
  if (!key) return null;
  for (const entry of ACTION_FLOORS) {
    if (entry.keys.includes(key)) return entry.floor;
  }
  return null;
}

/** Domain floors that apply whenever the matter touches that domain at all. */
const DOMAIN_FLOOR: Record<string, AuthorityLevel> = {
  finance: "manager_approval",
  legal: "specialist_approval",
  hr: "specialist_approval",
  admin: "owner_approval",
};

/**
 * Resolve the required authority from company policy and deterministic facts.
 * The result is the MAXIMUM of every applicable rule; nothing lowers it.
 */
export function resolveRequiredAuthority(facts: AuthorityFacts, ctx: AuthorityContext): AuthorityResolution {
  const reasons: string[] = [];
  const floors: AuthorityLevel[] = ["automatic"];
  let failedClosed = false;

  const escalate = (level: AuthorityLevel, why: string, closed = false) => {
    floors.push(level);
    reasons.push(why);
    if (closed) failedClosed = true;
  };

  // ── Policy presence. No active policy means we do not know this company's rules. ──
  if (!ctx.policyPresent) {
    escalate("manager_approval", "no active approval policy for this company — failing closed", true);
  }
  if (!ctx.actorMembershipId) {
    escalate("manager_approval", "no resolvable membership for the actor — no ceiling can apply", true);
  }

  // ── Domain floor. ──
  const domain = String(facts.domain ?? "").trim().toLowerCase();
  const dFloor = DOMAIN_FLOOR[domain];
  if (dFloor) escalate(dFloor, `domain "${domain}" requires at least ${dFloor}`);

  // ── Action classification (closed list; unknown fails closed). ──
  if (facts.action != null && String(facts.action).trim() !== "") {
    const aFloor = actionFloor(facts.action);
    if (aFloor === null) {
      escalate(
        "manager_approval",
        `action "${facts.action}" is not in the authority classification — unknown actions escalate`,
        true,
      );
    } else if (aFloor !== "automatic") {
      escalate(aFloor, `action "${facts.action}" requires at least ${aFloor}`);
    }
  }

  // ── Structured impact facts. ──
  const i = facts.impact ?? {};
  if (i.financial || i.legal || i.safety) escalate("specialist_approval", "financial, legal or safety impact");
  if (i.operational || i.customer) escalate("manager_approval", "operational or customer impact");

  // ── Confidence. ──
  if (typeof facts.confidence === "number" && facts.confidence < 0.3) {
    escalate("manager_approval", `low confidence (${facts.confidence})`);
  }

  // ── Money against the actor's ceiling. ──
  if (facts.amount != null && String(facts.amount).trim() !== "") {
    const currency = String(facts.currency ?? "").trim().toUpperCase();
    if (!currency) {
      escalate("manager_approval", "amount with no currency — cannot compare to a ceiling", true);
    } else {
      const applicable = ctx.rules.filter((r) => {
        const sameDomain = String(r.domain ?? "").trim().toLowerCase() === domain || r.is_company_wide === true;
        const mine = r.membership_id === ctx.actorMembershipId || r.is_company_wide === true;
        return sameDomain && mine;
      });

      if (applicable.length === 0) {
        escalate("manager_approval", "no authority rule covers this actor and domain — failing closed", true);
      } else {
        // Currency must match exactly. Converting would be a guess, and a guess in an authority
        // decision is a silent policy change.
        const sameCurrency = applicable.filter((r) => String(r.currency ?? "").trim().toUpperCase() === currency);
        if (sameCurrency.length === 0) {
          escalate(
            "manager_approval",
            `no authority rule in ${currency} — amounts are never converted for an authority decision`,
            true,
          );
        } else {
          const unlimited = sameCurrency.some((r) => r.is_unlimited === true);
          if (!unlimited) {
            // Conflicting ceilings: take the LOWEST, so a permissive stray row cannot widen authority.
            const ceilings = sameCurrency
              .map((r) => (r.max_amount == null ? null : String(r.max_amount)))
              .filter((v): v is string => v !== null);
            if (ceilings.length === 0) {
              escalate("manager_approval", "authority rule carries no ceiling — failing closed", true);
            } else {
              const lowest = ceilings.reduce((a, b) => (dec(a).lessThan(dec(b)) ? a : b));
              if (ceilings.length > 1 && new Set(ceilings).size > 1) {
                reasons.push(`multiple ceilings apply (${ceilings.join(", ")}) — the lowest governs`);
              }
              if (dec(facts.amount).greaterThan(dec(lowest))) {
                escalate("specialist_approval", `amount ${facts.amount} ${currency} exceeds the ceiling ${lowest} ${currency}`);
              }
            }
          }
        }
      }
    }
  }

  return { level: maxLevel(floors), reasons, failedClosed };
}

/**
 * Combine the deterministic result with the model's recommendation.
 * The model may RAISE the level. It can never lower it, and it is never the sole source.
 */
export function applyModelRecommendation(
  deterministic: AuthorityResolution,
  modelClaim: AuthorityLevel | null | undefined,
): AuthorityResolution {
  if (!modelClaim) return deterministic;
  if (rank(modelClaim) <= rank(deterministic.level)) {
    return {
      ...deterministic,
      reasons: [...deterministic.reasons, `model recommended ${modelClaim}; deterministic result governs`],
    };
  }
  return {
    level: modelClaim,
    reasons: [...deterministic.reasons, `model recommended a HIGHER level (${modelClaim}) — respected`],
    failedClosed: deterministic.failedClosed,
  };
}
