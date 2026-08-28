/**
 * Task detail — the task workspace.
 *
 * A task is a working room, not a form: it opens with what the task is trying
 * to accomplish, then its state, its people, its evidence and its history.
 *
 * Every guard is unchanged from the previous surface and deliberately so:
 *   - viewable by an Operations/admin manager OR the task's assignee (any dept);
 *   - the "Complete" control only appears at `verification`, and the action
 *     refuses to complete an evidence-requiring task with no evidence (pure
 *     lifecycle guard);
 *   - company-scoped reads/writes, graceful before the Phase-2 tables exist;
 *   - AI Guide messages stay behind the default-off `V3_1_AI_GUIDE` flag and
 *     the `ai.guide.manage` capability, and are rendered with the AI provenance
 *     rule so guidance is never mistaken for a decision the system has taken.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireProfile, resolveCapability } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import type { TaskState } from "@/modules/work/task-lifecycle";
import { signedEvidenceUrl } from "@/lib/documents";
import { isV31FlagEnabled } from "@/config/flags";
import { fmtDate, fmtNumber } from "@/lib/format";
import { Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/Icon";
import {
  Facts,
  PageHead,
  Provenance,
  Section,
  Signal,
  StateNote,
  type SignalKind,
} from "@/components/os/primitives";
import {
  addCheckIn, addEvidence, completeTask, assignTask, uploadTaskEvidence,
  submitEstimate, declineTask, startTask, logProgress, reportBlocker, unblockTask,
  submitForEvidence, requestVerification, acceptEstimate, returnForCorrection,
  createAiGuideMessage,
} from "../actions";

export const metadata = { title: "Task — Singha Central" };

const EVIDENCE_KINDS = ["message", "document", "photo", "approval", "system", "gps", "financial"];

/** How a lifecycle state should read as a signal. Never colour alone. */
function statusSignal(status: TaskState): { kind: SignalKind; label: string } {
  if (status === "blocked") return { kind: "blocked", label: "Blocked" };
  if (status === "overdue") return { kind: "critical", label: "Overdue" };
  if (status === "completed") return { kind: "ok", label: "Completed" };
  if (status === "cancelled") return { kind: "offline", label: "Cancelled" };
  if (status === "verification") return { kind: "warn", label: "Awaiting verification" };
  if (status === "awaiting_estimate") return { kind: "warn", label: "Awaiting an estimate" };
  if (status === "awaiting_evidence") return { kind: "warn", label: "Awaiting evidence" };
  if (status === "in_progress") return { kind: "info", label: "In progress" };
  return { kind: "info", label: status.replace(/_/g, " ") };
}

export default async function TaskDetail({ params }: { params: { id: string } }) {
  // WP1/WP3: viewable by an Operations/admin manager OR the task's assignee (any dept).
  const p = await requireProfile();
  const db = supabaseReadClient();

  const { data: task } = await db
    .from("tasks")
    .select("id, title, description, status, requires_evidence, due_date, estimate_hours, actual_hours, remaining_hours, blocker_reason, expected_completion, assigned_to")
    .eq("id", params.id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!task) notFound();

  const isManager = p.isAdmin || p.department === "operations";
  const isAssignee = !!task.assigned_to && task.assigned_to === p.userId;
  if (!isManager && !isAssignee) notFound(); // not in your scope

  const [{ data: checkIns }, { data: evidence }, { data: employees }] = await Promise.all([
    db.from("task_check_ins").select("id, note, progress_pct, created_at").eq("task_id", task.id).eq("company_id", p.companyId).order("created_at", { ascending: false }),
    db.from("task_evidence").select("id, kind, reference, created_at, document_id").eq("task_id", task.id).eq("company_id", p.companyId).order("created_at", { ascending: false }),
    db.from("profiles").select("id, username, full_name").eq("company_id", p.companyId).eq("is_active", true).order("full_name", { nullsFirst: false }),
  ]);

  // Signed download URLs for any file-backed evidence.
  const docIds = [...new Set((evidence ?? []).map((e: any) => e.document_id).filter(Boolean))];
  const urlByDoc = new Map<string, string>();
  if (docIds.length) {
    const { data: docs } = await db.from("documents").select("id, storage_path").in("id", docIds).eq("company_id", p.companyId);
    for (const d of docs ?? []) {
      const url = await signedEvidenceUrl(d.storage_path);
      if (url) urlByDoc.set(d.id, url);
    }
  }

  const status = task.status as TaskState;
  const canOfferComplete = status === "verification";
  const evidenceCount = (evidence ?? []).length;
  const blockedForEvidence = task.requires_evidence && evidenceCount === 0;
  const signal = statusSignal(status);

  // The latest recorded progress percentage, if any check-in carried one. This
  // is a stored value — no percentage is inferred from elapsed time.
  const latestProgress = (checkIns ?? []).find((c: any) => c.progress_pct != null)?.progress_pct ?? null;
  const assignee = (employees ?? []).find((e: any) => e.id === task.assigned_to);

  // AIM-007 — AI Guide panel (default-off V3_1_AI_GUIDE flag).
  const guideEnabled = isV31FlagEnabled("aiGuide");
  let guideMessages: any[] = [];
  let canManageGuide = false;
  if (guideEnabled) {
    const { data: gm } = await db
      .from("ai_guide_messages")
      .select("id, kind, body, visibility, audience_refs, proposed_next_action, confidence, prompt_version, schema_version, created_at")
      .eq("task_id", task.id)
      .eq("company_id", p.companyId)
      .order("created_at", { ascending: false });
    guideMessages = gm ?? [];
    canManageGuide = (await resolveCapability(p.userId, p.companyId, "ai.guide.manage")) === "granted";
  }
  const visibleGuideMessages = guideMessages.filter((m: any) =>
    m.visibility === "task_team" ||
    canManageGuide ||
    (Array.isArray(m.audience_refs) && m.audience_refs.includes(p.userId))
  );

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Task workspace"
        title={task.title}
        lede={task.description || undefined}
        actions={
          <Link className="btn ghost sm" href="/app/operations/tasks">
            <Icon name="chevron-left" size={14} /> All work
          </Link>
        }
      />

      {/* The state of the work, stated once, at the top, in words. */}
      <div className="card">
        <div className="row wrap gap-3 between">
          <Signal kind={signal.kind}>{signal.label}</Signal>
          {task.requires_evidence && (
            <Signal kind={evidenceCount > 0 ? "ok" : "warn"}>
              {evidenceCount > 0
                ? `Evidence required — ${evidenceCount} item${evidenceCount === 1 ? "" : "s"} attached`
                : "Evidence required — none attached yet"}
            </Signal>
          )}
          {latestProgress != null && (
            <Signal kind="info">Last recorded progress {latestProgress}%</Signal>
          )}
        </div>
        {task.blocker_reason && (
          <div className="mt-3">
            <StateNote kind="blocked" title="Blocked">
              {task.blocker_reason}
            </StateNote>
          </div>
        )}
      </div>

      <div className="split">
        <div className="stack" style={{ gap: "var(--sp-2)", minWidth: 0 }}>
          {/* ── WHAT HAPPENS NEXT — the lifecycle controls for this state ── */}
          {(isManager || isAssignee) && (
            <>
              <Section title="What happens next" meta={`state: ${status.replace(/_/g, " ")}`} />
              <div className="card">
                {status === "awaiting_estimate" && (
                  <div className="stack gap-2">
                    <p className="small muted">
                      This task needs an estimate before it can be scheduled.
                    </p>
                    <form action={submitEstimate} className="row gap-1 wrap">
                      <input type="hidden" name="task_id" value={task.id} />
                      <input name="hours" className="input" style={{ width: 140 }} placeholder="Estimate (h)" inputMode="decimal" />
                      <input name="expected_completion" className="input" type="date" style={{ width: 180 }} />
                      <button className="btn ghost sm" type="submit">Submit estimate</button>
                    </form>
                    <form action={declineTask} className="row gap-1 wrap">
                      <input type="hidden" name="task_id" value={task.id} />
                      <input name="reason" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Decline reason" />
                      <button className="btn ghost sm" type="submit">Decline</button>
                    </form>
                    {isManager && (
                      <form action={acceptEstimate}>
                        <input type="hidden" name="task_id" value={task.id} />
                        <button className="btn sm" type="submit">Accept estimate → schedule</button>
                      </form>
                    )}
                  </div>
                )}

                {status === "scheduled" && (
                  <form action={startTask}><input type="hidden" name="task_id" value={task.id} /><button className="btn sm" type="submit">Start work</button></form>
                )}

                {status === "in_progress" && (
                  <div className="stack gap-2">
                    <form action={logProgress} className="row gap-1 wrap">
                      <input type="hidden" name="task_id" value={task.id} />
                      <input name="hours" className="input" style={{ width: 150 }} placeholder="Actual hours" inputMode="decimal" />
                      <button className="btn ghost sm" type="submit">Log hours</button>
                    </form>
                    <form action={reportBlocker} className="row gap-1 wrap">
                      <input type="hidden" name="task_id" value={task.id} />
                      <input name="reason" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Blocker reason" />
                      <button className="btn ghost sm" type="submit">Report blocker</button>
                    </form>
                    <form action={submitForEvidence}><input type="hidden" name="task_id" value={task.id} /><button className="btn ghost sm" type="submit">Ready for evidence</button></form>
                  </div>
                )}

                {status === "blocked" && (
                  <form action={unblockTask}><input type="hidden" name="task_id" value={task.id} /><button className="btn sm" type="submit">Unblock</button></form>
                )}

                {status === "awaiting_evidence" && (
                  <form action={requestVerification}><input type="hidden" name="task_id" value={task.id} /><button className="btn sm" type="submit">Request verification</button></form>
                )}

                {isManager && status === "verification" && (
                  <form action={returnForCorrection}><input type="hidden" name="task_id" value={task.id} /><button className="btn ghost sm" type="submit">Return for correction</button></form>
                )}

                {!["awaiting_estimate", "scheduled", "in_progress", "blocked", "awaiting_evidence", "verification"].includes(status) && (
                  <p className="small muted">
                    No lifecycle action is available from <strong>{status.replace(/_/g, " ")}</strong>.
                  </p>
                )}
              </div>
            </>
          )}

          {/* ── VERIFICATION — the evidence gate, stated plainly ─────────── */}
          {isManager && canOfferComplete && (
            <>
              <Section title="Verification" />
              <div className={`card${blockedForEvidence ? "" : " is-priority"}`}>
                {blockedForEvidence ? (
                  <StateNote kind="blocked" title="Evidence is required before this can be completed">
                    This task was created requiring evidence and none is attached. Add at least one
                    evidence item below; the completion action refuses to run without it, so this is
                    a real gate rather than a disabled-looking button.
                  </StateNote>
                ) : (
                  <p className="small muted">
                    Acceptance criteria met — you may record this task as verified and complete.
                  </p>
                )}
                <form action={completeTask} className="mt-3">
                  <input type="hidden" name="task_id" value={task.id} />
                  <button className="btn" type="submit" disabled={blockedForEvidence}>
                    <Icon name="check-circle" size={15} /> Verify &amp; complete
                  </button>
                </form>
              </div>
            </>
          )}

          {/* ── EVIDENCE — sheets, not another glass card ───────────────── */}
          <Section title="Evidence" meta={`${evidenceCount} item${evidenceCount === 1 ? "" : "s"}`} />
          <div className="card">
            <form action={addEvidence} className="row gap-1 wrap">
              <input type="hidden" name="task_id" value={task.id} />
              <select name="kind" className="select" style={{ width: 160 }}>
                {EVIDENCE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <input name="reference" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="reference / link" />
              <button className="btn ghost sm" type="submit">Add</button>
            </form>
            <form action={uploadTaskEvidence} className="row gap-1 wrap mt-2">
              <input type="hidden" name="task_id" value={task.id} />
              <input type="file" name="file" className="input" style={{ flex: 1, minWidth: 180 }} />
              <button className="btn ghost sm" type="submit">Upload file</button>
            </form>

            <div className="grid cols-2 mt-3">
              {evidenceCount === 0 && <EmptyState title="No evidence yet" icon="paperclip" />}
              {(evidence ?? []).map((e: any) => {
                const url = e.document_id ? urlByDoc.get(e.document_id) : null;
                return (
                  <div key={e.id} className="sheet">
                    <div className="sheet-head">
                      <div style={{ minWidth: 0 }}>
                        <span className="sheet-kind">{e.kind}</span>
                        <div className="sheet-title">
                          {url ? (
                            <a href={url} target="_blank" rel="noreferrer">
                              {e.reference ?? "download"} <Icon name="external-link" size={12} />
                            </a>
                          ) : (
                            e.reference ?? "no reference recorded"
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="small dim">Attached {fmtDate(e.created_at)}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── CHECK-INS ──────────────────────────────────────────────── */}
          <Section title="Check-ins" meta={`${(checkIns ?? []).length} recorded`} />
          <div className="card">
            <form action={addCheckIn} className="row gap-1 wrap">
              <input type="hidden" name="task_id" value={task.id} />
              <input name="note" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="progress note" />
              <input name="progress_pct" className="input" style={{ width: 90 }} placeholder="%" inputMode="numeric" />
              <button className="btn ghost sm" type="submit">Log</button>
            </form>
            <div className="changes mt-3">
              {(checkIns ?? []).length === 0 && <EmptyState title="No check-ins yet" icon="message-square" />}
              {(checkIns ?? []).map((c: any) => (
                <div key={c.id} className="change is-info">
                  <span className="change-node" aria-hidden="true"><i /></span>
                  <span className="change-text">
                    <span className="change-title">{c.note ?? "Progress logged"}</span>
                    {c.progress_pct != null && (
                      <span className="change-meta">Recorded progress {c.progress_pct}%</span>
                    )}
                  </span>
                  <span className="change-when">{fmtDate(c.created_at)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── AI GUIDE — advice, marked as advice ─────────────────────── */}
          {guideEnabled && (
            <>
              <Section title="AI guide" meta="advice — never a decision" />
              <div className="card">
                {canManageGuide && (
                  <form action={createAiGuideMessage} className="stack gap-2">
                    <input type="hidden" name="task_id" value={task.id} />
                    <div className="row gap-1 wrap">
                      <select name="kind" className="select" defaultValue="next_action">
                        <option value="next_action">Next action</option>
                        <option value="clarification">Clarification</option>
                        <option value="blocker_help">Blocker help</option>
                        <option value="encouragement">Encouragement</option>
                        <option value="escalation">Escalation</option>
                        <option value="answer">Answer</option>
                      </select>
                      <select name="visibility" className="select" defaultValue="task_team">
                        <option value="task_team">Task team</option>
                        <option value="seniors">Seniors</option>
                        <option value="private">Private</option>
                      </select>
                      <input name="confidence" className="input" style={{ width: 90 }} defaultValue="0.8" inputMode="decimal" placeholder="conf" />
                    </div>
                    <textarea name="body" className="textarea" placeholder="Guidance message" required style={{ minHeight: 60 }} />
                    <input name="audience_refs" className="input" placeholder="Private recipient user id(s), comma-separated" />
                    <input name="proposed_next_action" className="input" placeholder="Optional proposed next action JSON" />
                    <button className="btn ghost sm" type="submit">Add guide message</button>
                  </form>
                )}
                <div className="stack gap-3 mt-3">
                  {visibleGuideMessages.length === 0 && <EmptyState title="No AI guide messages yet" icon="bot" />}
                  {visibleGuideMessages.map((m: any) => (
                    <Provenance
                      key={m.id}
                      kind="ai"
                      label={`AI advice · ${m.kind.replace(/_/g, " ")}${m.confidence != null ? ` · confidence ${m.confidence}` : ""}`}
                    >
                      <div className="row between wrap gap-1">
                        <Badge>{m.visibility}</Badge>
                        <span className="dim small">{fmtDate(m.created_at)}</span>
                      </div>
                      <p className="mt-1 small">{m.body}</p>
                      {m.proposed_next_action && (
                        <div className="mat-smoked mt-2" style={{ padding: "var(--sp-3)" }}>
                          <span className="t-label">Proposed next action</span>
                          <div className="small mt-1">
                            <strong>{String(m.proposed_next_action.action ?? "—")}</strong>
                          </div>
                          <div className="small dim">{String(m.proposed_next_action.reason ?? "")}</div>
                          <div className="small dim mt-1">
                            Requires authority: {String(m.proposed_next_action.requiredAuthority ?? "—")}
                            {m.proposed_next_action.expiresAt ? ` · expires ${String(m.proposed_next_action.expiresAt)}` : ""}
                          </div>
                        </div>
                      )}
                    </Provenance>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── CONTEXT LAYER ──────────────────────────────────────────────── */}
        <aside className="split-aside stack" style={{ gap: "var(--sp-2)" }}>
          <div className="card">
            <Section title="The record" />
            <Facts
              items={[
                { k: "Status", v: status.replace(/_/g, " ") },
                { k: "Due", v: task.due_date ? fmtDate(task.due_date) : "", missing: !task.due_date },
                {
                  k: "Expected completion",
                  v: task.expected_completion ? fmtDate(task.expected_completion) : "",
                  missing: !task.expected_completion,
                },
                {
                  k: "Estimate",
                  v: task.estimate_hours != null ? `${fmtNumber(task.estimate_hours)} h` : "",
                  numeric: true,
                  missing: task.estimate_hours == null,
                },
                {
                  k: "Actual",
                  v: task.actual_hours != null ? `${fmtNumber(task.actual_hours)} h` : "",
                  numeric: true,
                  missing: task.actual_hours == null,
                },
                {
                  k: "Remaining",
                  v: task.remaining_hours != null ? `${fmtNumber(task.remaining_hours)} h` : "",
                  numeric: true,
                  missing: task.remaining_hours == null,
                },
                {
                  k: "Assignee",
                  v: assignee ? assignee.full_name || assignee.username : "",
                  missing: !assignee,
                },
                { k: "Evidence required", v: task.requires_evidence ? "Yes" : "No" },
              ]}
            />
          </div>

          {isManager && (
            <div className="card">
              <Section title="Assignment" />
              <form action={assignTask} className="stack gap-2">
                <input type="hidden" name="task_id" value={task.id} />
                <label className="field">
                  <span className="label">Assigned to</span>
                  <select name="assigned_to" className="select" defaultValue={task.assigned_to ?? ""}>
                    <option value="">Unassigned</option>
                    {(employees ?? []).map((e: any) => <option key={e.id} value={e.id}>{e.full_name || e.username}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="label">Estimate (hours)</span>
                  <input name="estimate_hours" className="input" placeholder="Estimate (h)" inputMode="decimal" defaultValue={task.estimate_hours ?? ""} />
                </label>
                <button className="btn ghost sm" type="submit">Save</button>
              </form>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
