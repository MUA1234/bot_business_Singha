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
