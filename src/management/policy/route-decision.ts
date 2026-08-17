/**
 * Deterministic router for a Senior-AI-Manager DecisionProposal (change plan §6.3,
 * diagram 9). Given a *schema-validated* proposal, it decides — with no model in the
 * loop — whether the action may run automatically, run as a routine within delegated
 * authority, or must go to a human, and at which approval level.
 *
 * This complements the financial engine in src/policy/authority.ts (which handles
 * money events against the company approval policy). It NEVER executes anything and
 * NEVER lets the AI self-authorise sensitive actions (Constitution §6).
 */
import { AuthorityLevel, type DecisionProposal } from "@/schemas/management";
import { dec } from "@/lib/money";

export type Routing = "auto" | "execute_routine" | "require_approval" | "reject";
type Level = (typeof LEVELS)[number];

const LEVELS = [
  "automatic",
  "policy_controlled",
  "manager_approval",
  "specialist_approval",
  "owner_approval",
] as const;

const rank = (l: Level) => LEVELS.indexOf(l);
const higher = (a: Level, b: Level): Level => (rank(a) >= rank(b) ? a : b);

/**
 * Actions the AI must NEVER execute autonomously (Constitution §6). Matched as a
 * substring of the proposal `action`. Each carries the MINIMUM human level required.
 */
const NEVER_AUTONOMOUS: { match: string; floor: Level }[] = [
  { match: "payment", floor: "owner_approval" },
  { match: "pay_", floor: "owner_approval" },
  { match: "bank_detail", floor: "specialist_approval" },
  { match: "supplier_bank", floor: "specialist_approval" },
  { match: "contract", floor: "owner_approval" },
  { match: "dismiss", floor: "owner_approval" },
  { match: "terminate_employee", floor: "owner_approval" },
  { match: "grant_permission", floor: "owner_approval" },
  { match: "ledger", floor: "specialist_approval" },
  { match: "post_journal", floor: "specialist_approval" },
  { match: "gps", floor: "owner_approval" },
  { match: "cctv", floor: "owner_approval" },
];

const RISK_FLOOR: Record<string, Level> = {
  low: "automatic",
  medium: "manager_approval",
  high: "specialist_approval",
  critical: "owner_approval",
};

export interface RouteContext {
  actorPermissions?: string[];
  /** The actor's delegated authority ceiling for money actions, if any. */
  actorAuthorityMax?: { amount: string; currency: string };
}

export interface RouteResult {
  routing: Routing;
  requiredLevel: Level;
  requiredApprovers: string[];
  reasons: string[];
}

/**
 * Compare two decimal-string amounts of the same currency. Returns a>b. EXACT Decimal comparison —
 * this feeds an authority decision, so it must never round through a JS float (a float compare
 * misorders amounts once they exceed 2^53 minor units or differ below float precision). Malformed
 * amounts throw → the caller's proposal fails validation instead of silently passing authority.
 */
function exceeds(a: { amount: string; currency: string }, max: { amount: string; currency: string }): boolean {
  if (a.currency !== max.currency) return true; // mismatched currency ⇒ escalate (fail-safe)
  return dec(a.amount).greaterThan(dec(max.amount));
}

export function routeDecision(proposal: DecisionProposal, ctx: RouteContext = {}): RouteResult {
  const reasons: string[] = [];
  const action = proposal.action.toLowerCase();

  // Fail-safe: a very low-confidence proposal never auto-runs.
  const lowConfidence = proposal.confidence < 0.3;
  if (lowConfidence) reasons.push(`low confidence (${proposal.confidence}) — human review`);

  let level: Level = RISK_FLOOR[proposal.risk] ?? "manager_approval";

  const banned = NEVER_AUTONOMOUS.find((b) => action.includes(b.match));
  if (banned) {
    level = higher(level, banned.floor);
    reasons.push(`action "${proposal.action}" is never-autonomous → ≥ ${banned.floor}`);
  }

  // Money ceiling: over the delegated limit (or unknown limit with money) ⇒ escalate.
  if (proposal.limit) {
    if (!ctx.actorAuthorityMax) {
      level = higher(level, "manager_approval");
      reasons.push("money involved with no known delegated limit — escalate");
    } else if (exceeds(proposal.limit, ctx.actorAuthorityMax)) {
      level = higher(level, "manager_approval");
      reasons.push("amount exceeds the actor's delegated authority");
    }
  }

  // Decide routing from the resolved level.
  let routing: Routing;
  if (banned || lowConfidence) {
    routing = "require_approval";
  } else if (level === "automatic") {
    routing = "auto";
  } else if (level === "policy_controlled") {
    const permitted = ctx.actorPermissions?.includes(proposal.requiredPermission) ?? false;
    routing = permitted ? "execute_routine" : "require_approval";
    if (!permitted) reasons.push(`actor lacks permission "${proposal.requiredPermission}"`);
  } else {
    routing = "require_approval";
  }

  return {
    routing,
    requiredLevel: level,
    requiredApprovers: proposal.requiredApprovers,
    reasons,
  };
}

export { LEVELS as AUTHORITY_LEVELS };
export type { Level as AuthorityLevelName };
// Re-export the schema enum so callers validate against a single source.
export { AuthorityLevel };
