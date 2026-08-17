/**
 * Notifications (§10 UX). A signed-in employee's own notifications — leave decisions,
 * approvals, task assignments. Read-only + mark-read. Company-scoped, graceful.
 */
import Link from "next/link";
import { requireProfile } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { unreadCount } from "@/lib/notify";
import { markRead, markAllRead } from "./actions";

export const metadata = { title: "Notifications — Singha Central" };

export default async function NotificationsPage() {
  const p = await requireProfile();

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient().from("notifications")
      .select("id, type, title, body, link, is_read, created_at")
      .eq("company_id", p.companyId).eq("recipient_id", p.userId)
      .order("created_at", { ascending: false }).limit(100)).data ?? [];
  } catch {
    rows = [];
  }
  const unread = unreadCount(rows);

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Notifications</h1>
          <p className="muted mt-1">{unread > 0 ? `${unread} unread` : "You're all caught up."}</p>
        </div>
        {unread > 0 && <form action={markAllRead}><button className="btn ghost sm" type="submit">Mark all read</button></form>}
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">No notifications yet.</div>
        ) : (
          <div className="stack gap-1">
            {rows.map((n) => (
              <div key={n.id} className="row between" style={{ padding: "10px 6px", borderBottom: "1px solid var(--panel-border)", opacity: n.is_read ? 0.6 : 1 }}>
                <div>
                  <div style={{ fontWeight: n.is_read ? 400 : 700 }}>
                    {!n.is_read && <span style={{ color: "var(--accent)" }}>● </span>}
                    {n.link ? <Link href={n.link}>{n.title}</Link> : n.title}
                  </div>
                  {n.body && <div className="small dim">{n.body}</div>}
                  <div className="small dim">{new Date(n.created_at).toLocaleString()}</div>
                </div>
                {!n.is_read && (
                  <form action={markRead}><input type="hidden" name="id" value={n.id} /><button className="btn ghost sm" type="submit">Read</button></form>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
