/**
 * Replacements for PostgREST embeds that cannot work in this schema.
 *
 * WHY THIS MODULE EXISTS
 *
 * Migration-era tenant-integrity work added COMPOSITE foreign keys —
 * `(child_id, company_id) → parent(id, company_id)` — alongside the original
 * single-column keys. That is good for integrity and fatal for embedding: with
 * two foreign keys between the same pair of tables, PostgREST cannot choose a
 * join path and refuses the request with
 *
 *     "Could not embed because more than one relationship was found"
 *
 * The refusal arrives as an ERROR with `data: null`. Call sites that treat a
 * null result as "there is nothing here" therefore render an empty, confident,
 * WRONG screen: a project with no recorded spend, a task with no assignees, an
 * approver who is not an approver.
 *
 * Forty-two parent/child pairs in this schema now carry duplicate keys, so the
 * safe rule is: do not embed. Read the child rows in a second query and group
 * them here. Two plain queries cannot become ambiguous when another key is
 * added later, which is the property that matters.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Group rows by a foreign-key column. */
function groupBy<T extends Record<string, unknown>>(rows: T[], key: keyof T): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = String(row[key] ?? "");
    const list = out.get(k) ?? [];
    list.push(row);
    out.set(k, list);
  }
  return out;
}

export interface JournalEntryWithLines {
  id: string;
  posting_date: string;
  journal_lines: {
    id: string;
    account_code: string;
    debit: string | number;
    credit: string | number;
    project_id: string | null;
  }[];
}

/**
 * Posted journal entries with their lines attached, for a company.
 *
 * Replaces `from("journal_entries").select("id, posting_date, journal_lines(...)")`,
 * which is ambiguous (`journal_lines` has two foreign keys into
 * `journal_entries`) and silently yields nothing — making every project and
 * budget "actual" read as zero.
 */
export async function postedJournalsWithLines(
  db: SupabaseClient,
  companyId: string,
): Promise<JournalEntryWithLines[]> {
  const { data: entries, error: entriesError } = await db
    .from("journal_entries")
    .select("id, posting_date")
    .eq("company_id", companyId)
    .eq("status", "posted");
  if (entriesError || !entries?.length) return [];

  const ids = entries.map((e: { id: string }) => e.id);
  const { data: lines } = await db
    .from("journal_lines")
    .select("id, journal_id, account_code, debit, credit, project_id")
    .eq("company_id", companyId)
    .in("journal_id", ids);

  const byJournal = groupBy((lines ?? []) as any[], "journal_id");
  return entries.map((e: any) => ({
    id: e.id,
    posting_date: e.posting_date,
    journal_lines: (byJournal.get(e.id) ?? []).map((l: any) => ({
      id: l.id,
      account_code: l.account_code,
      debit: l.debit,
      credit: l.credit,
      project_id: l.project_id ?? null,
    })),
  }));
}

export interface TaskWithAssignments {
  id: string;
  project_id: string | null;
  status: string;
  due_date: string | null;
  estimate_hours: number | null;
  actual_hours: number | null;
  remaining_hours: number | null;
  task_assignments: { id: string; membership_id: string | null; estimate_hours: number | null }[];
}

/**
 * Tasks with their assignments attached, for a company.
 *
 * Replaces `from("tasks").select("…, task_assignments(...)")`, which is
 * ambiguous (`task_assignments` has three foreign keys into `tasks`) and
 * silently yields nothing — making every project's resource requirement read as
 * "no assigned staff" however many people are assigned.
 */
export async function tasksWithAssignments(
  db: SupabaseClient,
  companyId: string,
  limit = 1000,
): Promise<TaskWithAssignments[]> {
  const { data: tasks, error } = await db
    .from("tasks")
    .select("id, project_id, status, due_date, estimate_hours, actual_hours, remaining_hours")
    .eq("company_id", companyId)
    .limit(limit);
  if (error || !tasks?.length) return [];

  const ids = tasks.map((t: { id: string }) => t.id);
  const { data: assignments } = await db
    .from("task_assignments")
    .select("id, task_id, membership_id, estimate_hours")
    .eq("company_id", companyId)
    .in("task_id", ids);

  const byTask = groupBy((assignments ?? []) as any[], "task_id");
  return tasks.map((t: any) => ({
    ...t,
    task_assignments: (byTask.get(t.id) ?? []).map((a: any) => ({
      id: a.id,
      membership_id: a.membership_id ?? null,
      estimate_hours: a.estimate_hours ?? null,
    })),
  }));
}
