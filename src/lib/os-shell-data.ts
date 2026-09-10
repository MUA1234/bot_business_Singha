/**
 * Server-side data for the Spatial Executive OS shell.
 *
 * Everything here is a real, company-scoped query against durable state. Two
 * rules govern this module:
 *
 *   1. NEVER FABRICATE. If a query fails or the table is unavailable, the count
 *      is omitted and the badge simply does not render. A wrong number on a
 *      rail badge is worse than no number, because a person will act on it.
 *
 *   2. NEVER WIDEN. Every query is filtered by the caller's own company and,
 *      where the record is personal, by their own user id.
 */
import { supabaseReadClient } from "./supabase/read";
import type { SessionProfile } from "./auth";
import type { RailCounts } from "@/components/os/CommandRail";

export interface OsShellData {
  companyName: string;
  branchLabel: string | null;
  unreadCount: number;
  railCounts: RailCounts;
  aiConfigured: boolean;
}

async function count(
  run: () => PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number | null> {
  try {
    const { count: n, error } = await run();
    if (error) return null;
    return n ?? 0;
  } catch {
    return null;
  }
}

/**
 * Load the shell's own data. Never throws: a failure anywhere degrades to a
 * shell with fewer signals, never to a broken page.
 */
export async function loadOsShellData(profile: SessionProfile): Promise<OsShellData> {
  const db = supabaseReadClient();

  const [companyRow, unread, openTasks] = await Promise.all([
    (async () => {
      try {
        const { data } = await db
          .from("companies")
          .select("name")
          .eq("id", profile.companyId)
          .maybeSingle();
        return (data as { name?: string } | null) ?? null;
      } catch {
        return null;
      }
    })(),
    count(() =>
      db
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("company_id", profile.companyId)
        .eq("recipient_id", profile.userId)
        .eq("is_read", false) as never,
    ),
    count(() =>
      db
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("company_id", profile.companyId)
        .eq("assigned_to", profile.userId)
        .not("status", "in", "(completed,cancelled)") as never,
    ),
  ]);

  const railCounts: RailCounts = {};
  if (unread !== null && unread > 0) railCounts.comms = { count: unread, band: "warn" };
  if (openTasks !== null && openTasks > 0) railCounts.me = { count: openTasks };

  return {
    // The company name must never be a guess. If it cannot be read, say so
    // plainly rather than showing a plausible-looking placeholder.
    companyName: companyRow?.name?.trim() || "Company unavailable",
    branchLabel: null,
    unreadCount: unread ?? 0,
    railCounts,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
  };
}
