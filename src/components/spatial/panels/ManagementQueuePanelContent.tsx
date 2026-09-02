/**
 * Management queue — pure presentation (R1 checkpoint 5).
 *
 * Rendered by the spatial workspace window AND by `/app/command/queue`, exactly as the
 * existing panels are shared. It introduces NO new design system: every element is an
 * existing primitive from `@/components/ui`, and the spatial shell keeps its own chrome.
 *
 * THE CENTRAL RULE OF THIS SURFACE: it must never imply that a recommendation has been
 * executed. The six stages of a management item are visually and textually distinct —
 *
 *   observed      something was noticed          (nothing has been decided)
 *   recommended   the system PROPOSES an action  (nothing has been done)
 *   approved      a human DECIDED                (still nothing has been done)
 *   assigned      a person now holds the work    (in progress)
 *   completed     the work was reported done     (not yet confirmed)
 *   verified      re-observation CONFIRMED it    (actually finished)
 *
 * — and the stage label is rendered as its own column, never merged into a status badge
 * that could read as "done".
 */
import { Badge, Card, CardBody, CardHeader, EmptyState, StatusBadge } from "@/components/ui";

export type QueueStage =
  | "observed" | "recommended" | "approved" | "needs_routing"
  | "assigned" | "monitoring" | "escalated" | "completed" | "verified"
  | "rejected" | "dismissed" | "expired";

export type EvidenceQuality = "sufficient" | "low_confidence" | "contradictory" | "insufficient";

export interface QueueEvidenceRef {
  sourceTable: string;
  sourceId: string;
  /** Structured, non-identifying facts only — the panel never renders raw payload. */
  facts: Record<string, string | number | boolean | null>;
}

/**
 * Who the system suggests, and why (R2B checkpoint 5).
 *
 * ── Two deliberate omissions ─────────────────────────────────────────────────────────────
 *
 * There is NO numeric suitability score for a person on this surface, and no percentage
 * beside anyone's name. The resolver's `suitability` is an ordering value for one request;
 * printed next to a face it becomes a rating, and a rating printed often enough becomes the
 * universal employee rank the owner forbade. Order and reasons are shown instead — a manager
 * can act on "holds the capability, 20h free, four verified outcomes", and cannot act on 0.78.
 *
 * `confidence` IS shown, because it is a statement about the EVIDENCE, not about the person,
 * and hiding it would make a thin recommendation look as solid as a well-supported one.
 */
export type QueueCandidateRole = "assignee" | "advisor" | "delegate" | "external_consultant";

export interface QueueCandidate {
  membershipId: string;
  /** Resolved by the caller. The panel never invents or derives a name. */
  displayName: string;
  role: QueueCandidateRole;
  candidateType: string;
  confidence: number;
  availability: {
    available: boolean;
    onLeave: boolean;
    availableHours: number;
    capacityStatus: string;
  } | null;
  capabilities: string[];
  /** Each skill carries whether anyone actually verified it. */
  skills: Array<{ skill: string; verified: boolean }>;
  reasons: string[];
  missingInformation: string[];
  requiresHumanReview: string[];
  evidence: Array<{ sourceTable: string; sourceId: string }>;
  /** Delegates only — scope and expiry are always shown together. */
  delegation: { fromMembership: string; domain: string | null; endsAt: string } | null;
  /** External consultants only. */
  engagement: { domains: string[]; endsAt: string | null } | null;
}

/** Capability coverage for a proposed team (R2C). */
export interface QueueTeamCoverage {
  /** Capabilities the proposed team covers between them. */
  covered: string[];
  /** Required capabilities NOBODY on the team holds. Shown, never omitted. */
  missing: string[];
  /** The one member proposed as accountable, or null when nobody qualifies. */
  leadMembershipId: string | null;
  /** Why there is no lead, when there is none. */
  leadReason: string | null;
  requestedMinimum: number;
  understaffed: boolean;
}

export interface QueueRecommendation {
  /** WHICH ROLE this recommendation is for. One role is never shown as another (R2C). */
  role?: QueueCandidateRole;
  /**
   * True when the work cannot proceed as proposed without this role.
   *
   * An OPTIONAL role that found nobody is reported as a gap and nothing more — a missing
   * advisor must not make a valid assignee recommendation look broken.
   */
  mandatory?: boolean;
  /** Why this role was asked for at all. */
  requirementReason?: string;
  /** Present only for a team proposal. */
  team?: QueueTeamCoverage | null;
  outcome: "candidates" | "needs_routing";
  candidates: QueueCandidate[];
  /** Populated on `needs_routing` — a department and a precise reason, never a person. */
  routing: { department: string; reasonCode: string; detail: string } | null;
  missingInformation: string[];
  /** The rule version behind any outcome history used, so the suggestion can be challenged. */
  signalRuleVersion: string;
}

/**
 * One recorded piece of human feedback (R2B, owner Decision 3).
 *
 * Deliberately NOT shown: the derived learning signal itself. A manager may see WHAT WAS
 * RECORDED — which is evidence they can dispute — but the fold's output is not a number about a
 * person that belongs on a queue row, and displaying it would recreate the universal rank by
 * another route. The ordering rule version is shown instead, so a suggestion can be challenged.
 */
export interface QueueFeedbackEntry {
  id: string;
  event: string;
  /** Who recorded it. Never rendered as a judgement of them. */
  actorLabel: string;
  at: string;
  reason: string | null;
  /** Bounded, and rendered as TEXT — never as markup. */
  comment: string | null;
  /** Set when a later correction supersedes this entry. The entry is still shown. */
  supersededByCorrection: boolean;
}

export interface QueueItem {
  id: string;
  department: string;
  summary: string;
  stage: QueueStage;
  priority: "critical" | "high" | "normal" | "low";
  confidence: number;
  evidence: QueueEvidenceRef[];
  evidenceQuality: EvidenceQuality;
  /** The PROPOSED action id. Present does not mean performed. */
  proposedAction: string | null;
  requiredAuthority: string | null;
  /** Null while unrouted — displayed as such, never as an administrator. */
  accountableOwner: string | null;
  routingReason: string | null;
  /** Null unless evidence or policy supplied one (R1-D-4). */
  businessDeadline: string | null;
  /** Null when no review policy is configured — shown truthfully. */
  reviewBy: string | null;
  reviewPolicyConfigured: boolean;
  monitoringState: string | null;
  timeline: Array<{ at: string; from: string | null; to: string; actorType: string; reason: string | null }>;
  /** Absent when no resolution has been run for this item — distinct from "nobody suitable". */
  recommendation?: QueueRecommendation | null;
  /**
   * One recommendation PER ROLE (R2C). When present this supersedes `recommendation`, which is
   * kept so every existing caller keeps working unchanged.
   */
  recommendations?: QueueRecommendation[];
  /** Append-only human feedback recorded against this item, oldest first. */
  feedback?: QueueFeedbackEntry[];
  /**
   * May the current viewer record feedback and accept or reject a suggestion?
   *
   * Controls are HIDDEN rather than shown-and-refused when false: offering a person a button
   * that will always fail is worse than not offering it, and the private learning inputs behind
   * it are not theirs to see.
   */
  viewerMayDecide?: boolean;
}

export interface ManagementQueueData {
  items: QueueItem[];
  /** Departments whose detector failed — reported, never silently treated as "all clear". */
  unobservedDepartments: string[];
  /** True only when every registered source actually ran. */
  completeSweep: boolean;
}

export interface ManagementQueueProps {
  data: ManagementQueueData | null;
  loading?: boolean;
  permissionDenied?: boolean;
  stale?: boolean;
  error?: string | null;
  /** Id of the item opened in the focus view, if any. */
  focusId?: string | null;
}

/** Wording chosen so no stage can be misread as "the system did it". */
const STAGE_LABEL: Record<QueueStage, string> = {
  observed: "Observed",
  recommended: "Recommended — not yet decided",
  approved: "Approved — not yet done",
  needs_routing: "Needs routing",
  assigned: "Assigned",
  monitoring: "In progress",
  escalated: "Escalated",
  completed: "Reported done — not yet verified",
  verified: "Verified",
  rejected: "Rejected",
  dismissed: "Dismissed",
  expired: "Expired",
};

type BadgeVariant = "default" | "ok" | "warn" | "danger" | "info" | "accent";

/** Only `verified` is green. Nothing earlier may look finished. */
const STAGE_VARIANT: Record<QueueStage, BadgeVariant> = {
  observed: "info", recommended: "info", approved: "warn", needs_routing: "warn",
  assigned: "info", monitoring: "info", escalated: "danger", completed: "warn",
  verified: "ok", rejected: "default", dismissed: "default", expired: "default",
};

const QUALITY_LABEL: Record<EvidenceQuality, string> = {
  sufficient: "Evidence sufficient",
  low_confidence: "Low confidence — treat with caution",
  contradictory: "Contradictory evidence — needs a human",
  insufficient: "Insufficient evidence",
};

export function ManagementQueuePanelContent({
  data, loading, permissionDenied, stale, error, focusId,
}: ManagementQueueProps) {
  // ── honest states, in priority order ────────────────────────────────────────────────
  if (permissionDenied) {
    return (
      <div className="stack gap-3" data-testid="mq-permission-denied">
        <EmptyState
          title="You do not have access to the management queue"
          description="Ask an administrator for the operations capability that grants it. Nothing is hidden behind this message — there is simply nothing you may see."
          icon="shield"
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="stack gap-3" data-testid="mq-loading" aria-busy="true">
        <p className="muted">Loading the management queue…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="stack gap-3" data-testid="mq-error" role="alert">
        <EmptyState
          title="The management queue could not be loaded"
          description={`No all-clear can be given: ${error}`}
          icon="alert"
        />
        <button type="button" className="btn mq-touch-target" data-action="retry">
          Retry
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="stack gap-3" data-testid="mq-unavailable">
        <EmptyState
          title="Management data is unavailable"
          description="The queue could not be read. This is not the same as an empty queue."
          icon="alert"
        />
      </div>
    );
  }

  const { items, unobservedDepartments, completeSweep } = data;

  return (
    <div className="stack gap-3" data-testid="mq-root">
      {/* A degraded sweep is stated BEFORE the list, so an empty queue is never mistaken
          for a healthy business. */}
      {!completeSweep && (
        <div className="note note-warn" role="status" data-testid="mq-degraded">
          <strong>Some departments were not observed.</strong>{" "}
          {unobservedDepartments.join(", ")} — no all-clear can be given for them.
        </div>
      )}

      {stale && (
        <div className="note note-warn" role="status" data-testid="mq-stale">
          This view is stale. The figures were read earlier and may have moved.
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="Nothing needs attention right now"
          description={
            completeSweep
              ? "Every registered department was observed and produced no exceptions."
              : "Note that not every department was observed — see the warning above."
          }
          icon="check"
        />
      ) : (
        <Card>
          <CardHeader title="What needs attention" subtitle={`${items.length} open`} />
          <CardBody>
            <ul className="mq-list" data-testid="mq-list">
              {items.map((item) => (
                <QueueRow key={item.id} item={item} focused={item.id === focusId} />
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function QueueRow({ item, focused }: { item: QueueItem; focused: boolean }) {
  return (
    <li
      className={`mq-row${focused ? " mq-row-focused" : ""}`}
      data-testid="mq-item"
      data-stage={item.stage}
      data-department={item.department}
    >
      <div className="mq-row-main">
        <span className="mq-dept t-label">{item.department}</span>
        <span className="mq-summary">{item.summary}</span>
      </div>

      <div className="mq-badges">
        <StatusBadge status={item.priority} />
        {/* The STAGE is its own badge with explicit wording. It is never merged into the
            priority badge, because "critical" beside "done" is exactly how a reader
            concludes an action was taken. */}
        <span data-testid="mq-stage">
          <Badge variant={STAGE_VARIANT[item.stage]}>{STAGE_LABEL[item.stage]}</Badge>
        </span>
        <span data-testid="mq-quality">
          <Badge variant={item.evidenceQuality === "sufficient" ? "ok" : "warn"}>
            {QUALITY_LABEL[item.evidenceQuality]}
          </Badge>
        </span>
        <span className="mq-confidence t-label" data-testid="mq-confidence">
          confidence {Math.round(item.confidence * 100)}%
        </span>
      </div>

      <dl className="mq-facts">
        <dt>Proposed</dt>
        <dd data-testid="mq-proposed">
          {item.proposedAction ? (
            <>
              <code>{item.proposedAction}</code>{" "}
              <span className="muted">— proposed only; nothing has been carried out</span>
            </>
          ) : (
            <span className="muted">No action proposed yet</span>
          )}
        </dd>

        <dt>Authority</dt>
        <dd data-testid="mq-authority">{item.requiredAuthority ?? "not yet resolved"}</dd>

        <dt>Accountable</dt>
        <dd data-testid="mq-owner">
          {item.accountableOwner ?? (
            <span className="mq-unrouted">
              Nobody yet{item.routingReason ? ` — ${item.routingReason}` : ""}
            </span>
          )}
        </dd>

        <dt>Business deadline</dt>
        <dd data-testid="mq-deadline">{item.businessDeadline ?? "none recorded"}</dd>

        <dt>Review by</dt>
        <dd data-testid="mq-review">
          {item.reviewPolicyConfigured ? (item.reviewBy ?? "not scheduled") : "review timing not configured"}
        </dd>

        <dt>Monitoring</dt>
        <dd data-testid="mq-monitoring">{item.monitoringState ?? "not started"}</dd>
      </dl>

      <details className="mq-evidence">
        <summary className="mq-touch-target">Evidence ({item.evidence.length})</summary>
        {item.evidence.length === 0 ? (
          <p className="muted" data-testid="mq-no-evidence">
            No evidence is attached. This item cannot be recommended or approved.
          </p>
        ) : (
          <ul data-testid="mq-evidence-list">
            {item.evidence.map((e) => (
              <li key={`${e.sourceTable}:${e.sourceId}`}>
                <code>
                  {e.sourceTable}:{e.sourceId}
                </code>
                <span className="muted">
                  {" "}
                  {Object.entries(e.facts)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>

      <details className="mq-timeline">
        <summary className="mq-touch-target">History ({item.timeline.length})</summary>
        <ol data-testid="mq-timeline">
          {item.timeline.map((t, i) => (
            <li key={i}>
              <span className="t-label">{t.at}</span> {t.from ?? "—"} → <strong>{t.to}</strong>{" "}
              <span className="muted">
                ({t.actorType}
                {t.reason ? `: ${t.reason}` : ""})
              </span>
            </li>
          ))}
        </ol>
      </details>

      <CandidateSection item={item} />

      {/* Actions are LINKS to the review surface, not in-place executions. The panel itself
          performs nothing. */}
      <div className="mq-actions">
        <a className="btn mq-touch-target" href={`/app/command/queue/${item.id}`} data-action="review">
          Review
        </a>
      </div>
    </li>
  );
}

/**
 * One role's recommendation, headed so it can never be mistaken for another.
 *
 * A MANDATORY role that found nobody is called out as blocking; an OPTIONAL one is reported as a
 * gap and explicitly says the rest of the recommendation stands. That distinction is the whole
 * reason roles are resolved separately.
 */
function RoleSection({ item, rec }: { item: QueueItem; rec: QueueRecommendation }) {
  const role = rec.role ?? "assignee";
  const mayDecide = item.viewerMayDecide !== false;

  return (
    <section className="mq-role" data-testid="mq-role" data-role={role}>
      <h4 className="mq-role-head">
        {ROLE_LABEL[role]}{" "}
        <Badge variant={rec.mandatory ? "warn" : "default"}>
          {rec.mandatory ? "required for this work" : "optional"}
        </Badge>
      </h4>
      {rec.requirementReason && <p className="muted" data-testid="mq-role-reason">{rec.requirementReason}</p>}

      {rec.team && <TeamCoverage team={rec.team} />}

      {rec.outcome === "needs_routing" ? (
        <div
          className={`note ${rec.mandatory ? "note-warn" : ""}`}
          role="status"
          data-testid="mq-role-unfilled"
        >
          <strong>Nobody suitable for this role.</strong>{" "}
          {rec.routing ? rec.routing.detail : "no reason was recorded"}
          {rec.mandatory ? (
            <> This work cannot proceed as proposed until the role is filled.</>
          ) : (
            <> This role is optional — the rest of the recommendation still stands.</>
          )}
        </div>
      ) : (
        <ol className="mq-candidate-list" data-testid="mq-role-candidates">
          {rec.candidates.map((c) => (
            <li key={`${c.membershipId}:${c.role}`} className="mq-candidate" data-testid="mq-candidate" data-role={c.role}>
              <div className="mq-candidate-head">
                <strong data-testid="mq-candidate-name">{c.displayName}</strong>
                <span className="t-label">evidence confidence {Math.round(c.confidence * 100)}%</span>
              </div>
              <dl className="mq-facts">
                <dt>Availability</dt>
                <dd>
                  {c.availability
                    ? `${c.availability.availableHours}h free (${c.availability.capacityStatus})`
                    : "not recorded"}
                </dd>
                <dt>Skills</dt>
                <dd data-testid="mq-role-skills">
                  {c.skills.length === 0 ? (
                    <span className="muted">none recorded</span>
                  ) : (
                    c.skills.map((sk) => (
                      <span key={sk.skill} className="mq-skill">
                        {sk.skill}{" "}
                        <span className={sk.verified ? "mq-verified" : "mq-unverified"}>
                          {sk.verified ? "(verified)" : "(unverified claim)"}
                        </span>
                      </span>
                    ))
                  )}
                </dd>
                {c.delegation && (
                  <>
                    <dt>Proposed delegation</dt>
                    <dd data-testid="mq-role-delegation">
                      scope {c.delegation.domain ?? "none"}, expires {c.delegation.endsAt} — proposed
                      only; no delegation exists until a human creates one
                    </dd>
                  </>
                )}
                {c.engagement && (
                  <>
                    <dt>Engagement</dt>
                    <dd data-testid="mq-role-engagement">
                      scope {c.engagement.domains.join(", ") || "none"}
                      {c.engagement.endsAt ? `, until ${c.engagement.endsAt}` : ""} — no internal access,
                      and nobody has been contacted
                    </dd>
                  </>
                )}
              </dl>
              <details>
                <summary className="mq-touch-target">Why ({c.reasons.length})</summary>
                <ul>{c.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </details>
              <MissingList items={c.missingInformation} testId="mq-role-missing" />
            </li>
          ))}
        </ol>
      )}

      <RoleControls itemId={item.id} role={role} mayDecide={mayDecide} canAccept={rec.outcome === "candidates"} />
    </section>
  );
}

/** Capability coverage for a proposed team. What is NOT covered is shown, never omitted. */
function TeamCoverage({ team }: { team: QueueTeamCoverage }) {
  return (
    <div className="mq-team" data-testid="mq-team-coverage">
      <dl className="mq-facts">
        <dt>Covers</dt>
        <dd data-testid="mq-team-covered">{team.covered.join(", ") || "nothing recorded"}</dd>
        <dt>Not covered</dt>
        <dd data-testid="mq-team-missing">
          {team.missing.length === 0
            ? "everything required is covered"
            : team.missing.join(", ")}
        </dd>
        <dt>Accountable lead</dt>
        <dd data-testid="mq-team-lead">
          {team.leadMembershipId ?? (
            <span className="mq-unrouted">
              nobody proposed{team.leadReason ? ` — ${team.leadReason}` : ""}
            </span>
          )}
        </dd>
      </dl>
      {team.understaffed && (
        <div className="note note-warn" role="status" data-testid="mq-team-understaffed">
          Fewer people than the {team.requestedMinimum} this work asked for.
        </div>
      )}
    </div>
  );
}

/**
 * Per-role human controls: accept, replace, reject, or LEAVE UNFILLED.
 *
 * "Leave unfilled" is a deliberate option rather than an omission. Without it the only way to
 * decline a suggested advisor is to ignore the item, and an ignored item looks the same as an
 * unseen one. Every control is a link; the panel performs nothing.
 */
function RoleControls({
  itemId, role, mayDecide, canAccept,
}: { itemId: string; role: QueueCandidateRole; mayDecide: boolean; canAccept: boolean }) {
  if (!mayDecide) {
    return (
      <div className="mq-actions" data-testid="mq-no-decision-rights">
        <span className="muted">You can see this recommendation but may not act on it.</span>
      </div>
    );
  }
  return (
    <div className="mq-actions" data-testid="mq-role-controls">
      {canAccept && (
        <a className="btn mq-touch-target" href={`/app/command/queue/${itemId}/${role}/accept`}
           data-action="accept-role" data-testid="mq-role-accept">
          Accept
        </a>
      )}
      <a className="btn mq-touch-target" href={`/app/command/queue/${itemId}/${role}/replace`}
         data-action="replace-role" data-testid="mq-role-replace">
        Choose someone else
      </a>
      {canAccept && (
        <a className="btn mq-touch-target" href={`/app/command/queue/${itemId}/${role}/reject`}
           data-action="reject-role" data-testid="mq-role-reject">
          Reject
        </a>
      )}
      <a className="btn mq-touch-target" href={`/app/command/queue/${itemId}/${role}/leave-unfilled`}
         data-action="leave-role-unfilled" data-testid="mq-role-leave-unfilled">
        Leave unfilled
      </a>
      <span className="muted">
        Suggestions only — nobody is assigned, delegated authority or engaged until you decide.
      </span>
    </div>
  );
}

const ROLE_LABEL: Record<QueueCandidateRole, string> = {
  assignee: "Suggested assignee — accountable for delivery",
  advisor: "Suggested advisor — guidance only, owns no delivery and holds no authority",
  delegate: "Suggested delegate — exercises delegated authority within scope, until expiry",
  external_consultant: "External consultant — approved scope only, NO internal access",
};

/**
 * Who the system suggests, and everything a manager needs to disagree with it.
 *
 * Three distinct states, never collapsed into one, because they call for different actions:
 *   no resolution run    nothing has been asked yet
 *   needs_routing        the question was asked and NOBODY is suitable, with the reason
 *   candidates           suggestions, every one of which the manager may ignore
 */
function CandidateSection({ item }: { item: QueueItem }) {
  // R2C: one section per role. A single `recommendation` is treated as a one-element list, so
  // nothing about the existing single-role callers changes.
  // The R2C shape is `recommendations`, and it takes the role-section path even with ONE entry:
  // a single-role recommendation may still carry team coverage, and switching layout on the
  // COUNT would have hidden it. The legacy single `recommendation` keeps the original path so
  // every existing caller is untouched.
  const perRole = item.recommendations ?? [];
  if (perRole.length > 0) {
    return (
      <div className="mq-roles" data-testid="mq-roles">
        {perRole.map((r, i) => (
          <RoleSection key={`${r.role ?? "assignee"}:${i}`} item={item} rec={r} />
        ))}
        <FeedbackHistory entries={item.feedback ?? []} mayDecide={item.viewerMayDecide !== false} />
      </div>
    );
  }

  const rec = item.recommendation ?? null;

  if (!rec) {
    return (
      <div className="mq-candidates" data-testid="mq-candidates-none-run">
        <p className="muted">No capability recommendation has been run for this item.</p>
        <FeedbackHistory entries={item.feedback ?? []} mayDecide={item.viewerMayDecide !== false} />
      </div>
    );
  }

  if (rec.outcome === "needs_routing") {
    return (
      <div className="mq-candidates" data-testid="mq-candidates">
        <div className="note note-warn" role="status" data-testid="mq-no-candidate">
          <strong>No suitable candidate.</strong>{" "}
          <span data-testid="mq-no-candidate-reason">
            {rec.routing ? rec.routing.detail : "no reason was recorded"}
          </span>
          {rec.routing && (
            <>
              {" "}
              Queued to the <strong data-testid="mq-routing-department">{rec.routing.department}</strong>{" "}
              department for a human to route.
            </>
          )}
        </div>
        <MissingList items={rec.missingInformation} testId="mq-candidates-missing" />
        <HumanOverride itemId={item.id} label="Assign someone" mayDecide={item.viewerMayDecide !== false} />
        <FeedbackHistory entries={item.feedback ?? []} mayDecide={item.viewerMayDecide !== false} />
      </div>
    );
  }

  return (
    <div className="mq-candidates" data-testid="mq-candidates">
      <details open>
        <summary className="mq-touch-target">
          Suggested people ({rec.candidates.length}) — suggestions only, you decide
        </summary>

        <ol className="mq-candidate-list" data-testid="mq-candidate-list">
          {rec.candidates.map((c) => (
            <li
              key={`${c.membershipId}:${c.role}`}
              className="mq-candidate"
              data-testid="mq-candidate"
              data-role={c.role}
              data-candidate-type={c.candidateType}
            >
              <div className="mq-candidate-head">
                <strong data-testid="mq-candidate-name">{c.displayName}</strong>
                <Badge variant={c.role === "external_consultant" ? "warn" : "info"}>
                  {ROLE_LABEL[c.role]}
                </Badge>
                {/* Confidence describes the EVIDENCE, never the person. */}
                <span className="t-label" data-testid="mq-candidate-confidence">
                  evidence confidence {Math.round(c.confidence * 100)}%
                </span>
              </div>

              <dl className="mq-facts">
                <dt>Availability</dt>
                <dd data-testid="mq-candidate-availability">
                  {c.availability
                    ? `${c.availability.availableHours}h free (${c.availability.capacityStatus})`
                    : "not recorded"}
                </dd>

                <dt>Capabilities</dt>
                <dd data-testid="mq-candidate-capabilities">
                  {c.capabilities.length > 0 ? c.capabilities.join(", ") : "none relevant to this work"}
                </dd>

                <dt>Skills</dt>
                <dd data-testid="mq-candidate-skills">
                  {c.skills.length === 0 ? (
                    <span className="muted">none recorded</span>
                  ) : (
                    c.skills.map((s) => (
                      <span key={s.skill} className="mq-skill">
                        {s.skill}{" "}
                        <span className={s.verified ? "mq-verified" : "mq-unverified"}>
                          {/* Provenance is never dropped: an unverified claim must not read as fact. */}
                          {s.verified ? "(verified)" : "(unverified claim)"}
                        </span>
                      </span>
                    ))
                  )}
                </dd>

                {c.delegation && (
                  <>
                    <dt>Delegation</dt>
                    <dd data-testid="mq-candidate-delegation">
                      from {c.delegation.fromMembership}, scope {c.delegation.domain ?? "none"}, expires{" "}
                      {c.delegation.endsAt}
                    </dd>
                  </>
                )}

                {c.engagement && (
                  <>
                    <dt>Engagement</dt>
                    <dd data-testid="mq-candidate-engagement">
                      scope {c.engagement.domains.join(", ") || "none"}
                      {c.engagement.endsAt ? `, until ${c.engagement.endsAt}` : ""} — no internal access
                    </dd>
                  </>
                )}
              </dl>

              <details>
                <summary className="mq-touch-target">Why ({c.reasons.length})</summary>
                <ul data-testid="mq-candidate-reasons">
                  {c.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </details>

              {c.evidence.length > 0 && (
                <details>
                  <summary className="mq-touch-target">Evidence ({c.evidence.length})</summary>
                  <ul data-testid="mq-candidate-evidence">
                    {c.evidence.map((e, i) => (
                      <li key={i}>
                        <code>
                          {e.sourceTable}:{e.sourceId}
                        </code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <MissingList items={c.missingInformation} testId="mq-candidate-missing" />

              {c.requiresHumanReview.length > 0 && (
                <div className="note note-warn" role="status" data-testid="mq-candidate-review">
                  <strong>Needs your judgement:</strong> {c.requiresHumanReview.join("; ")}
                </div>
              )}
            </li>
          ))}
        </ol>

        <MissingList items={rec.missingInformation} testId="mq-candidates-missing" />

        <p className="muted" data-testid="mq-rule-version">
          Ordering rule <code>{rec.signalRuleVersion}</code> — ask for the evidence behind any
          suggestion if you disagree with it.
        </p>
      </details>

      <HumanOverride
        itemId={item.id}
        label="Choose someone else"
        mayDecide={item.viewerMayDecide !== false}
        showAcceptReject
      />
      <FeedbackHistory entries={item.feedback ?? []} mayDecide={item.viewerMayDecide !== false} />
    </div>
  );
}

/** What we do not know. Shown plainly rather than filled in with a guess. */
function MissingList({ items, testId }: { items: string[]; testId: string }) {
  if (items.length === 0) return null;
  return (
    <div className="mq-missing" data-testid={testId}>
      <span className="t-label">Missing information</span>
      <ul>
        {items.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The override. It is ALWAYS present, on every state, and it is a link to the review surface —
 * this panel performs nothing. The wording states the rule rather than implying it.
 */
/**
 * The human decision controls.
 *
 * Every one is a LINK to the review surface. The panel performs nothing — it emits no form and
 * no submit control — so a recommendation cannot be accepted by a stray click on a read-only
 * queue, and the decision is always recorded through the authenticated feedback path.
 */
function HumanOverride({
  itemId, label, mayDecide = true, showAcceptReject = false,
}: { itemId: string; label: string; mayDecide?: boolean; showAcceptReject?: boolean }) {
  if (!mayDecide) {
    return (
      <div className="mq-actions" data-testid="mq-no-decision-rights">
        <span className="muted">
          You can see this recommendation but may not act on it. Ask someone with the operations
          capability to accept, reject or reassign it.
        </span>
      </div>
    );
  }
  return (
    <div className="mq-actions">
      {showAcceptReject && (
        <>
          <a
            className="btn mq-touch-target"
            href={`/app/command/queue/${itemId}/accept`}
            data-action="accept-recommendation"
            data-testid="mq-accept"
          >
            Accept suggestion
          </a>
          <a
            className="btn mq-touch-target"
            href={`/app/command/queue/${itemId}/reject`}
            data-action="reject-recommendation"
            data-testid="mq-reject"
          >
            Reject suggestion
          </a>
        </>
      )}
      <a
        className="btn mq-touch-target"
        href={`/app/command/queue/${itemId}/assign`}
        data-action="override-assignee"
        data-testid="mq-human-override"
      >
        {label}
      </a>
      <span className="muted" data-testid="mq-human-decides">
        Suggestions only — the assignment is yours to make.
      </span>
    </div>
  );
}

/** Human feedback already recorded, oldest first. Evidence a manager can dispute. */
function FeedbackHistory({ entries, mayDecide }: { entries: QueueFeedbackEntry[]; mayDecide: boolean }) {
  if (!mayDecide) return null;
  if (entries.length === 0) {
    return (
      <p className="muted" data-testid="mq-feedback-empty">
        No outcome or feedback has been recorded for this item yet.
      </p>
    );
  }
  return (
    <details className="mq-feedback">
      <summary className="mq-touch-target">Feedback and outcomes ({entries.length})</summary>
      <ol data-testid="mq-feedback-list">
        {entries.map((f) => (
          <li key={f.id} data-testid="mq-feedback-entry" data-event={f.event}>
            <span className="t-label">{f.at}</span>{" "}
            <strong>{f.event.replace(/_/g, " ")}</strong>{" "}
            <span className="muted">by {f.actorLabel}</span>
            {f.supersededByCorrection && (
              <span className="mq-superseded" data-testid="mq-feedback-superseded">
                {" "}
                — later corrected; kept for the record
              </span>
            )}
            {f.reason && <div className="muted">{f.reason}</div>}
            {/* Rendered as TEXT. React escapes it; it is never inserted as markup. */}
            {f.comment && <div className="mq-comment">{f.comment}</div>}
          </li>
        ))}
      </ol>
    </details>
  );
}
