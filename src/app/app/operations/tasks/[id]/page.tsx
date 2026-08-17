/**
 * Task detail — check-ins, evidence and evidence-gated completion (§7.3, §10).
 * The "Complete" button only appears at `verification`, and the action refuses to
 * complete an evidence-requiring task with no evidence (pure lifecycle guard).
 * Company-scoped reads/writes; graceful before the Phase-2 tables exist.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireProfile } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import type { TaskState } from "@/modules/work/task-lifecycle";
import { signedEvidenceUrl } from "@/lib/documents";
import {
  addCheckIn, addEvidence, completeTask, assignTask, uploadTaskEvidence,
  submitEstimate, declineTask, startTask, logProgress, reportBlocker, unblockTask,
  submitForEvidence, requestVerification, acceptEstimate, returnForCorrection,
} from "../actions";

export const metadata = { title: "Task — Singha Central" };

const EVIDENCE_KINDS = ["message", "document", "photo", "approval", "system", "gps", "financial"];

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

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{task.title}</h1>
          <p className="muted mt-1"><span className="badge">{status.replace(/_/g, " ")}</span>
            {task.requires_evidence && <span className="badge warn" style={{ marginLeft: 6 }}>evidence required</span>}
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/operations/tasks">← All tasks</Link>
      </div>

      {task.description && <div className="card"><p>{task.description}</p></div>}

      {(isManager || isAssignee) && (
        <div className="card">
          <div className="card-title">Progress</div>
          <p className="small muted mt-1">
            {task.estimate_hours != null && <>Est: {task.estimate_hours}h · </>}
            {task.actual_hours != null && <>Actual: {task.actual_hours}h · </>}
            {task.remaining_hours != null && <>Remaining: {task.remaining_hours}h</>}
            {task.expected_completion && <> · ETA {task.expected_completion}</>}
          </p>
          {task.blocker_reason && <p className="badge warn mt-1">Blocked: {task.blocker_reason}</p>}

          {status === "awaiting_estimate" && (
            <div className="stack gap-2 mt-2">
              <form action={submitEstimate} className="row gap-1 wrap">
                <input type="hidden" name="task_id" value={task.id} />
                <input name="hours" className="input" style={{ width: 120 }} placeholder="Estimate (h)" inputMode="decimal" />
                <input name="expected_completion" className="input" type="date" style={{ width: 170 }} />
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
            <form action={startTask} className="mt-2"><input type="hidden" name="task_id" value={task.id} /><button className="btn sm" type="submit">Start work</button></form>
          )}

          {status === "in_progress" && (
            <div className="stack gap-2 mt-2">
              <form action={logProgress} className="row gap-1 wrap">
                <input type="hidden" name="task_id" value={task.id} />
                <input name="hours" className="input" style={{ width: 140 }} placeholder="Actual hours" inputMode="decimal" />
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
            <form action={unblockTask} className="mt-2"><input type="hidden" name="task_id" value={task.id} /><button className="btn sm" type="submit">Unblock</button></form>
          )}

          {status === "awaiting_evidence" && (
            <form action={requestVerification} className="mt-2"><input type="hidden" name="task_id" value={task.id} /><button className="btn sm" type="submit">Request verification</button></form>
          )}

          {isManager && status === "verification" && (
            <form action={returnForCorrection} className="mt-2"><input type="hidden" name="task_id" value={task.id} /><button className="btn ghost sm" type="submit">Return for correction</button></form>
          )}
        </div>
      )}

      {isManager && (
        <div className="card">
          <div className="card-title">Assignment</div>
          <form action={assignTask} className="row gap-1 wrap mt-2">
            <input type="hidden" name="task_id" value={task.id} />
            <select name="assigned_to" className="select" style={{ width: 200 }} defaultValue={task.assigned_to ?? ""}>
              <option value="">Unassigned</option>
              {(employees ?? []).map((e: any) => <option key={e.id} value={e.id}>{e.full_name || e.username}</option>)}
            </select>
            <input name="estimate_hours" className="input" style={{ width: 130 }} placeholder="Estimate (h)" inputMode="decimal" defaultValue={task.estimate_hours ?? ""} />
            <button className="btn ghost sm" type="submit">Save</button>
          </form>
        </div>
      )}

      {isManager && canOfferComplete && (
        <div className="card">
          <div className="card-title">Verification</div>
          <p className="card-sub mt-1">
            {blockedForEvidence
              ? "This task requires evidence. Add at least one evidence item below before it can be completed."
              : "Acceptance criteria met — you may complete this task."}
          </p>
          <form action={completeTask} className="mt-2">
            <input type="hidden" name="task_id" value={task.id} />
            <button className="btn" type="submit" disabled={blockedForEvidence}>Verify &amp; complete</button>
          </form>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">Evidence ({evidenceCount})</div>
          <form action={addEvidence} className="row gap-1 wrap mt-2">
            <input type="hidden" name="task_id" value={task.id} />
            <select name="kind" className="select" style={{ width: 150 }}>
              {EVIDENCE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input name="reference" className="input" style={{ flex: 1, minWidth: 140 }} placeholder="reference / link" />
            <button className="btn ghost sm" type="submit">Add</button>
          </form>
          <form action={uploadTaskEvidence} className="row gap-1 wrap mt-2">
            <input type="hidden" name="task_id" value={task.id} />
            <input type="file" name="file" className="input" style={{ flex: 1, minWidth: 180 }} />
            <button className="btn ghost sm" type="submit">Upload file</button>
          </form>
          <div className="stack gap-1 mt-3">
            {evidenceCount === 0 && <div className="empty">No evidence yet.</div>}
            {(evidence ?? []).map((e: any) => {
              const url = e.document_id ? urlByDoc.get(e.document_id) : null;
              return (
                <div key={e.id} className="row between small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                  <span>
                    <span className="badge">{e.kind}</span>{" "}
                    {url ? <a href={url} target="_blank" rel="noreferrer">{e.reference ?? "download"}</a> : (e.reference ?? "")}
                  </span>
                  <span className="dim">{new Date(e.created_at).toLocaleDateString()}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Check-ins</div>
          <form action={addCheckIn} className="row gap-1 wrap mt-2">
            <input type="hidden" name="task_id" value={task.id} />
            <input name="note" className="input" style={{ flex: 1, minWidth: 140 }} placeholder="progress note" />
            <input name="progress_pct" className="input" style={{ width: 80 }} placeholder="%" inputMode="numeric" />
            <button className="btn ghost sm" type="submit">Log</button>
          </form>
          <div className="stack gap-1 mt-3">
            {(checkIns ?? []).length === 0 && <div className="empty">No check-ins yet.</div>}
            {(checkIns ?? []).map((c: any) => (
              <div key={c.id} className="row between small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                <span>{c.note ?? "—"}{c.progress_pct != null && <span className="dim"> · {c.progress_pct}%</span>}</span>
                <span className="dim">{new Date(c.created_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
