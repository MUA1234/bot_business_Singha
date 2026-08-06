/**
 * Outbox & dead letters (§WP4.5). Admin-only, read-only view of outbound messages with
 * a replay action for failed/dead rows. Company-scoped; graceful if the delivery worker
 * hasn't populated anything yet.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { replayMessage } from "./actions";

export const metadata = { title: "Outbox — Singha" };

async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

const badgeFor = (s: string) => (s === "dead" ? "danger" : s === "failed" ? "warn" : s === "sent" ? "ok" : "");

export default async function OutboxPage() {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  const messages = await rows<any>(() =>
    db
      .from("message_outbox")
      .select("id, channel, recipient, body, status, attempts, last_error, provider_message_id, created_at")
      .eq("company_id", admin.companyId)
      .order("created_at", { ascending: false })
      .limit(100) as any,
  );

  const counts = messages.reduce((m: Record<string, number>, r: any) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  const tiles = ["pending", "failed", "dead", "sent"] as const;

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Outbox &amp; dead letters</h1>
          <p className="muted mt-1">Outbound messages and their delivery status. Replay a failed or dead message to re-queue it.</p>
        </div>
        <Link className="btn ghost sm" href="/app/admin/health">System health →</Link>
      </div>

      <div className="grid cols-4">
        {tiles.map((t) => (
          <div key={t} className="card stat">
            <div className="k">{t}</div>
            <div className="v" style={{ fontSize: "1.5rem", color: (t === "dead" || t === "failed") && (counts[t] ?? 0) > 0 ? "var(--danger)" : undefined }}>{counts[t] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="card">
        {messages.length === 0 ? (
          <div className="empty">No outbound messages yet. The delivery worker populates this once outbound sending is wired.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Channel</th><th>Recipient</th><th>Status</th><th className="num">Attempts</th><th>Error</th><th></th></tr></thead>
              <tbody>
                {messages.map((m: any) => (
                  <tr key={m.id}>
                    <td className="small dim">{new Date(m.created_at).toLocaleString()}</td>
                    <td>{m.channel}</td>
                    <td className="small">{m.recipient}</td>
                    <td><span className={`badge ${badgeFor(m.status)}`}>{m.status}</span></td>
                    <td className="num">{m.attempts}</td>
                    <td className="small dim" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{m.last_error ?? ""}</td>
                    <td>
                      {(m.status === "failed" || m.status === "dead") && (
                        <form action={replayMessage}>
                          <input type="hidden" name="id" value={m.id} />
                          <button className="btn ghost sm" type="submit">Replay</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
