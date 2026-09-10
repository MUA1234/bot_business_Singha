/**
 * AI Recommendations / Alerts panel for the spatial workspace.
 *
 * It surfaces the same deterministic exceptions as the Command Centre, plus unread
 * notifications and recent management cases. Nothing here is fabricated.
 */
import Link from "next/link";
import { supabaseReadClient } from "@/lib/supabase/read";
import {
  detectTaskExceptions,
  detectCapacityExceptions,
  sortBySeverity,
  type TaskLike,
  type CapacityLike,
  type Exception,
} from "@/management/ai-manager/exceptions";
import { Card, CardHeader, CardBody, Badge, EmptyState } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

interface AIRecommendationsPanelProps {
  userId: string;
  companyId: string;
}

export async function AIRecommendationsPanel({ userId, companyId }: AIRecommendationsPanelProps) {
  const db = supabaseReadClient();
  const now = new Date();

  let tasks: TaskLike[] = [];
  try {
    const { data } = await db
      .from("tasks")
      .select("id, title, status, due_date, estimate_hours, updated_at")
      .eq("company_id", companyId)
      .limit(200);
    tasks = (data ?? []).map((t: any) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueDate: t.due_date,
      lastCheckInAt: t.updated_at,
      estimateHours: t.estimate_hours,
    }));
  } catch {
    tasks = [];
  }

  let caps: CapacityLike[] = [];
  try {
    const { data } = await db
      .from("capacity_snapshots")
      .select("membership_id, status, utilization_pct, week_start")
      .eq("company_id", companyId)
      .order("week_start", { ascending: false })
      .limit(200);
    const seen = new Set<string>();
    caps = [];
    for (const c of data ?? []) {
      if (seen.has(c.membership_id)) continue;
      seen.add(c.membership_id);
      caps.push({ membershipId: c.membership_id, status: c.status, utilizationPct: Number(c.utilization_pct ?? 0) });
    }
  } catch {
    caps = [];
  }

  let notifications: any[] = [];
  try {
    const { data } = await db
      .from("notifications")
      .select("id, type, title, body, link, is_read, created_at")
      .eq("company_id", companyId)
      .eq("recipient_id", userId)
      .eq("is_read", false)
      .order("created_at", { ascending: false })
      .limit(50);
    notifications = data ?? [];
  } catch {
    notifications = [];
  }

  let cases: any[] = [];
  try {
    const { data } = await db
      .from("management_cases")
      .select("id, created_at, source_event_id, confidence, required_authority, requires_human, created_tasks")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(20);
    cases = data ?? [];
  } catch {
    cases = [];
  }

  const taskExceptions = detectTaskExceptions(tasks, now);
  const capacityExceptions = detectCapacityExceptions(caps);
  const exceptions: Exception[] = sortBySeverity([...taskExceptions, ...capacityExceptions]);

  return (
    <div className="stack gap-3">
      <h1>AI Recommendations</h1>

      <Card>
        <CardHeader title="Exceptions" />
        <CardBody>
          {exceptions.length === 0 ? (
            <EmptyState title="No active exceptions" description="The AI monitor has not detected anything requiring attention." icon="check-circle-2" />
          ) : (
            <div className="stack gap-1">
              {exceptions.map((e, i) => (
                <div key={i} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                  <span>{e.message}</span>
                  <Badge variant={e.severity === "critical" ? "danger" : e.severity === "warn" ? "warn" : "info"}>
                    {e.severity}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Unread notifications (${notifications.length})`} />
        <CardBody>
          {notifications.length === 0 ? (
            <EmptyState title="No unread notifications" description="You are caught up." icon="check-circle-2" />
          ) : (
            <div className="stack gap-1">
              {notifications.map((n) => (
                <div key={n.id} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                  <span>{n.title}</span>
                  {n.link ? <Link href={n.link} className="btn sm ghost">Open</Link> : null}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent management cases" />
        <CardBody>
          {cases.length === 0 ? (
            <EmptyState title="No management cases yet" description="Run an analysis to create durable cases." icon="clipboard" />
          ) : (
            <div className="stack gap-1">
              {cases.map((c) => (
                <div key={c.id} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                  <span className="small">{fmtDateTime(c.created_at)}</span>
                  <div className="row gap-1 wrap">
                    {c.requires_human && <Badge variant="warn">needs human</Badge>}
                    <Badge>{c.required_authority ?? "—"}</Badge>
                    <Badge variant="info">{(c.confidence * 100).toFixed(0)}%</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
