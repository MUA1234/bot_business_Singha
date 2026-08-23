/**
 * Outbox & dead letters (§WP4.5). Admin-only, read-only view of outbound messages with
 * a replay action for failed/dead rows. Company-scoped; graceful if the delivery worker
 * hasn't populated anything yet.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { fmtDateTime } from "@/lib/format";
import { replayMessage } from "./actions";

export const metadata = { title: "Outbox — Singha Central" };

interface OutboxRow {
  id: string;
  channel: string;
  recipient: string;
  body: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  provider_message_id: string | null;
  created_at: string;
}

async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

const statusVariant = (s: string) => {
  if (s === "dead") return "danger";
  if (s === "failed") return "warn";
  if (s === "sent") return "ok";
  return "default";
};

export default async function OutboxPage() {
  const admin = await requireAdmin();
  const db = supabaseReadClient();

  const messages = await rows<OutboxRow>(() =>
    db
      .from("message_outbox")
      .select("id, channel, recipient, body, status, attempts, last_error, provider_message_id, created_at")
      .eq("company_id", admin.companyId)
      .order("created_at", { ascending: false })
      .limit(100) as any,
  );

  const counts = messages.reduce((m: Record<string, number>, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  const tiles = ["pending", "failed", "dead", "sent"] as const;

  const messageColumns: DataTableColumn<OutboxRow>[] = [
    { key: "when", header: "When", render: (m) => <span className="small dim">{fmtDateTime(m.created_at)}</span> },
    { key: "channel", header: "Channel", render: (m) => m.channel },
    { key: "recipient", header: "Recipient", render: (m) => <span className="small">{m.recipient}</span> },
    { key: "status", header: "Status", render: (m) => <StatusBadge status={m.status} /> },
    { key: "attempts", header: "Attempts", render: (m) => <span className="num">{m.attempts}</span>, align: "right" },
    {
      key: "error",
      header: "Error",
      render: (m) => (
        <span className="small dim" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", display: "inline-block" }}>
          {m.last_error ?? ""}
        </span>
      ),
    },
    {
      key: "replay",
      header: "",
      render: (m) =>
        (m.status === "failed" || m.status === "dead") ? (
          <form action={replayMessage}>
            <input type="hidden" name="id" value={m.id} />
            <Button type="submit" size="sm" variant="ghost" aria-label={`Replay ${m.channel} message to ${m.recipient}`}>
              Replay
            </Button>
          </form>
        ) : null,
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between wrap gap-2">
        <div>
          <h1>Outbox &amp; dead letters</h1>
          <p className="muted mt-1">Outbound messages and their delivery status. Replay a failed or dead message to re-queue it.</p>
        </div>
        <Link className="btn ghost sm" href="/app/admin/health">System health →</Link>
      </div>

      <div className="grid cols-4">
        {tiles.map((t) => (
          <Card key={t} className="stat" padding="sm">
            <div className="k">{t}</div>
            <div
              className="v"
              style={{
                color: (t === "dead" || t === "failed") && (counts[t] ?? 0) > 0 ? "var(--danger)" : undefined,
              }}
            >
              {counts[t] ?? 0}
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader title="Outbound messages" />
        <CardBody>
          {messages.length === 0 ? (
            <EmptyState
              title="No outbound messages yet"
              description="The delivery worker populates this once outbound sending is wired."
            />
          ) : (
            <DataTable
              columns={messageColumns}
              rows={messages}
              keyExtractor={(m) => m.id}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
