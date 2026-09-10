/**
 * The Supabase (PostgREST) transport for verification — the one the request path and the worker
 * actually have.
 *
 * `makeCycleDeps` speaks through the Supabase query builder, so before this existed the cycle had
 * no way to reach verification at all and silently reported zeroes. Nothing here decides anything:
 * it fetches rows and writes rows, and the same `schedule.ts` / `service.ts` / `verify.ts` /
 * `rules.ts` make every judgement, whichever transport is underneath.
 *
 * ── Two shapes PostgREST cannot express, and what replaces them ──────────────────────────────
 *
 * The SQL transport uses a LEFT JOIN for pending items and correlated subqueries for the claim
 * time and the evidence count. Neither is available here, so each becomes a second COMPANY-SCOPED
 * read and the results are combined. That is transport, not logic: the combining is mechanical and
 * the ordering it feeds is applied once, by the scheduler.
 *
 * Every read below is filtered by `company_id` from the server-side cycle request. No query here
 * reads across companies, and no company identity reaches this file from a browser.
 */
import type { SourceRead } from "./contract";
import type { TaskUnderVerification } from "./rules";
import type {
  AttemptRecord,
  ItemRow,
  PendingVerification,
  TransitionRequest,
  VerificationStore,
} from "./store";

// The Supabase client is structurally typed per table; this transport needs a table-agnostic
// handle, so the looseness is intentional and confined to this file. Matches the same escape
// hatch `cycle-deps.ts` uses for the same reason.
// eslint-disable-next-line
type Db = any;

/** Surface a PostgREST error as a throw, so a failed read is never mistaken for an empty one. */
// eslint-disable-next-line
async function rowsOf(run: Promise<{ data: unknown; error: unknown }>): Promise<any[]> {
  const { data, error } = await run;
  if (error) throw new Error((error as { message?: string }).message ?? "read failed");
  return (data ?? []) as any[];
}

async function valueOf(run: Promise<{ data: unknown; error: unknown }>): Promise<unknown> {
  const { data, error } = await run;
  if (error) throw new Error((error as { message?: string }).message ?? "call failed");
  return data;
}

export function createSupabaseVerificationStore(db: Db): VerificationStore {
  return {
    transport: "supabase",

    async listPending(companyId) {
      const items = await rowsOf(
        db
          .from("management_items")
          .select("id")
          .eq("company_id", companyId)
          .in("state", ["verifying", "monitoring"]),
      );
      if (items.length === 0) return [];

      const ids = items.map((r) => String(r.id));
      const schedule = await rowsOf(
        db
          .from("management_verification_schedule")
          .select("item_id, attempts, next_attempt_at")
          .eq("company_id", companyId)
          .in("item_id", ids),
      );
      const byItem = new Map(schedule.map((s) => [String(s.item_id), s]));

      return ids.map<PendingVerification>((id) => {
        const s = byItem.get(id);
        return {
          itemId: id,
          attempts: Number(s?.attempts ?? 0),
          // Absent schedule row means never attempted, which is due now — expressed as null so no
          // clock is consulted to say so.
          nextAttemptAt: s?.next_attempt_at == null ? null : new Date(String(s.next_attempt_at)),
        };
      });
    },

    async loadItem(companyId, itemId) {
      const rows = await rowsOf(
        db
          .from("management_items")
          .select("id, company_id, department, kind, subject_table, subject_id, state")
          .eq("company_id", companyId)
          .eq("id", itemId),
      );
      const row = rows[0];
      if (!row) return null;

      // The claim time: the most recent transition INTO a claimed state. Read from the append-only
      // transition log, never from a column a later edit could move.
      const claim = await rowsOf(
        db
          .from("management_item_transitions")
          .select("created_at")
          .eq("company_id", companyId)
          .eq("item_id", itemId)
          .in("to_state", ["verifying", "monitoring"])
          .order("created_at", { ascending: false })
          .limit(1),
      );

      return {
        id: String(row.id),
        companyId: String(row.company_id),
        department: String(row.department),
        kind: String(row.kind),
        subjectTable: String(row.subject_table),
        subjectId: String(row.subject_id),
        state: String(row.state),
        claimedAt: claim[0]?.created_at == null ? null : new Date(String(claim[0].created_at)),
      } satisfies ItemRow;
    },

    async readTask(companyId, taskId): Promise<SourceRead<TaskUnderVerification>> {
      try {
        const rows = await rowsOf(
          db
            .from("tasks")
            .select("id, title, status, due_date, requires_evidence")
            .eq("company_id", companyId)
            .eq("id", taskId),
        );
        const row = rows[0];
        if (!row) return { ok: true, row: null };

        const checkIns = await rowsOf(
          db
            .from("task_check_ins")
            .select("created_at")
            .eq("task_id", taskId)
            .order("created_at", { ascending: false })
            .limit(1),
        );
        // VERIFIED evidence only. A task closed on somebody's word alone is a claim, not a
        // verification, so unverified attachments are not counted.
        const evidence = await rowsOf(
          db
            .from("task_evidence")
            .select("id")
            .eq("company_id", companyId)
            .eq("task_id", taskId)
            .neq("verified_by", null),
        );

        return {
          ok: true,
          row: {
            id: String(row.id),
            title: String(row.title ?? ""),
            status: String(row.status) as TaskUnderVerification["status"],
            dueDate: row.due_date == null ? null : String(row.due_date),
            lastCheckInAt: checkIns[0]?.created_at == null ? null : String(checkIns[0].created_at),
            estimateHours: null,
            requiresEvidence: row.requires_evidence === true,
            verifiedEvidenceCount: evidence.length,
          },
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },

    async evidenceGeneration(companyId, itemId) {
      const d = await valueOf(
        db.rpc("r1_draft_evidence_digest", { p_company: companyId, p_item: itemId }),
      );
      return d == null ? "empty" : String(d);
    },

    async transition(_companyId, req: TransitionRequest) {
      const r = await valueOf(
        db.rpc("r1_draft_transition_item", {
          p_item: req.itemId,
          p_from: req.from,
          p_to: req.to,
          p_actor: req.actorId,
          p_actor_type: req.actorType,
          p_reason: req.detail,
          p_evidence: [],
        }),
      );
      const envelope = Array.isArray(r) ? r[0] : r;
      return (envelope as { ok?: boolean } | null)?.ok === true;
    },

    async recordAttempt(a: AttemptRecord) {
      const { error: insertError } = await db.from("management_verification_attempts").insert({
        company_id: a.companyId,
        item_id: a.itemId,
        attempt_no: a.attemptNo,
        outcome: a.outcome,
        detail: a.detail,
        observed_at: a.observedAt.toISOString(),
        generation: a.generation,
        actor_type: "system",
      });
      if (insertError) {
        throw new Error((insertError as { message?: string }).message ?? "attempt insert failed");
      }

      const { error: upsertError } = await db
        .from("management_verification_schedule")
        .upsert(
          {
            company_id: a.companyId,
            item_id: a.itemId,
            attempts: a.attemptNo,
            next_attempt_at: a.nextAttemptAt.toISOString(),
            last_outcome: a.outcome,
            last_detail: a.detail,
            last_attempt_at: a.attemptedAt.toISOString(),
          },
          { onConflict: "company_id,item_id" },
        );
      if (upsertError) {
        throw new Error((upsertError as { message?: string }).message ?? "schedule upsert failed");
      }
    },
  };
}
