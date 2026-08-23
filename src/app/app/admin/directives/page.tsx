/**
 * Admin → Management directives (GOV-001 + GOV-003). Company-scoped registry of
 * directives issued to named humans, with optional target/action pairs and
 * automatic conflict detection/resolution.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtDateTime } from "@/lib/format";
import { Card, CardHeader, CardBody, Button, Badge, DataTable, FormField } from "@/components/ui";
import { type BadgeVariant } from "@/components/ui/Badge";
import {
  createDirective,
  acknowledgeDirective,
  closeDirective,
  escalateDirective,
  resolveDirectiveConflict,
} from "./actions";

export const metadata = { title: "Directives — Singha Central" };

const DIRECTIVE_ACTIONS = ["approve", "reject", "hold", "proceed", "stop"];

const statusVariant: Record<string, BadgeVariant> = {
  overdue: "danger",
  issued: "info",
  escalated: "warn",
  acknowledged: "ok",
  closed: "default",
};

export default async function DirectivesPage() {
  const admin = await requireAdmin();
  const now = new Date().toISOString();

  let directives: any[] = [];
  let people: any[] = [];
  let conflicts: any[] = [];
  try {
    directives = (await supabaseReadClient()
      .from("management_directives")
      .select("id, title, body, issued_by, issued_to, response_required_by, status, response, acknowledged_at, target_type, target_id, action, escalation_chain, escalated_to, escalation_level, escalated_at, escalation_reason")
      .eq("company_id", admin.companyId)
      .order("response_required_by", { ascending: true })
      .limit(200)).data ?? [];

    people = (await supabaseReadClient()
      .from("profiles")
      .select("id, full_name, username")
      .eq("company_id", admin.companyId)
      .order("full_name")
      .limit(200)).data ?? [];

    conflicts = (await supabaseReadClient()
      .from("management_directive_conflicts")
      .select("id, directive_a_id, directive_b_id, target_type, target_id, status")
      .eq("company_id", admin.companyId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(100)).data ?? [];
  } catch {
    // leave lists empty
  }

  const personName = (id: string) => people.find((p) => p.id === id)?.full_name ?? people.find((p) => p.id === id)?.username ?? id.slice(0, 8);
  const directiveTitle = (id: string) => directives.find((d) => d.id === id)?.title ?? id.slice(0, 8);
  const directiveAction = (id: string) => directives.find((d) => d.id === id)?.action ?? "—";

  const openCount = directives.filter((d) => d.status === "issued" || d.status === "overdue").length;
  const overdueCount = directives.filter((d) => d.status === "issued" && d.response_required_by < now).length;
  const openConflictCount = conflicts.length;

  const conflictColumns = [
    { key: "a", header: "Directive A", render: (c: any) => <span style={{ fontWeight: 600 }}>{directiveTitle(c.directive_a_id)}</span> },
    { key: "actionA", header: "Action A", render: (c: any) => <Badge>{directiveAction(c.directive_a_id)}</Badge> },
    { key: "b", header: "Directive B", render: (c: any) => <span style={{ fontWeight: 600 }}>{directiveTitle(c.directive_b_id)}</span> },
    { key: "actionB", header: "Action B", render: (c: any) => <Badge>{directiveAction(c.directive_b_id)}</Badge> },
    { key: "target", header: "Target", render: (c: any) => <span className="dim small">{c.target_type ?? "—"}:{c.target_id ?? "—"}</span> },
    {
      key: "resolve",
      header: "",
      render: (c: any) => (
        <form action={resolveDirectiveConflict} className="stack gap-1">
          <input type="hidden" name="id" value={c.id} />
          <input name="resolution" className="input sm" placeholder="Resolution reason" required />
          <Button size="sm" type="submit">
            Resolve
          </Button>
        </form>
      ),
    },
  ];

  const directiveColumns = [
    { key: "title", header: "Title", render: (d: any) => <span style={{ fontWeight: 600 }}>{d.title}</span> },
    { key: "recipient", header: "Recipient", render: (d: any) => <span className="dim small">{personName(d.issued_to)}</span> },
    {
      key: "due",
      header: "Due",
      render: (d: any) => {
        const isOverdue = (d.status === "issued" || d.status === "escalated") && d.response_required_by < now;
        return <Badge variant={isOverdue ? "danger" : "default"}>{fmtDateTime(d.response_required_by)}</Badge>;
      },
    },
    {
      key: "status",
      header: "Status",
      render: (d: any) => {
        const isOverdue = (d.status === "issued" || d.status === "escalated") && d.response_required_by < now;
        const displayStatus = isOverdue ? "overdue" : d.status;
        return <Badge variant={statusVariant[displayStatus] ?? "default"}>{displayStatus}</Badge>;
      },
    },
    {
      key: "escalation",
      header: "Escalation",
      render: (d: any) => {
        const isOverdue = (d.status === "issued" || d.status === "escalated") && d.response_required_by < now;
        return (
          <span className="dim small">
            {d.status === "escalated" && <span>L{d.escalation_level ?? 1} → {personName(d.escalated_to)}</span>}
            {isOverdue && d.status !== "escalated" && <span>overdue</span>}
            {!isOverdue && d.status !== "escalated" && <span>—</span>}
          </span>
        );
      },
    },
    { key: "response", header: "Response", render: (d: any) => <span className="dim small">{d.response ?? "—"}</span> },
    {
      key: "actions",
      header: "",
      render: (d: any) => {
        const isOverdue = (d.status === "issued" || d.status === "escalated") && d.response_required_by < now;
        const canAcknowledge = d.status !== "acknowledged" && d.status !== "closed" && (d.issued_to === admin.userId || d.escalated_to === admin.userId);
        const chain = Array.isArray(d.escalation_chain) ? (d.escalation_chain as string[]) : [];
        const canEscalate = chain.length > 0 && (d.status === "issued" || d.status === "escalated") && Number(d.escalation_level ?? 0) < chain.length;
        return (
          <div className="row gap-1 wrap">
            {d.status !== "acknowledged" && d.status !== "closed" && (
              <form action={closeDirective}>
                <input type="hidden" name="id" value={d.id} />
                <Button variant="ghost" size="sm" type="submit">
                  Close
                </Button>
              </form>
            )}
            {canEscalate && (
              <form action={escalateDirective}>
                <input type="hidden" name="id" value={d.id} />
                <Button variant="ghost" size="sm" type="submit">
                  Escalate
                </Button>
              </form>
            )}
            {canAcknowledge && (
              <form action={acknowledgeDirective} className="stack gap-1">
                <input type="hidden" name="id" value={d.id} />
                <input name="response" className="input sm" placeholder="Response" />
                <Button size="sm" type="submit">
                  Acknowledge
                </Button>
              </form>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Management directives</h1>
          <p className="muted mt-1">Issue directives and track response obligations.</p>
        </div>
        <div className="row gap-1">
          <a href="#conflicts" className="btn ghost sm">
            Conflicts
          </a>
          <Link className="btn ghost sm" href="/app/admin">
            ← Admin
          </Link>
        </div>
      </div>

      <div className="grid cols-3">
        <Card className="stat">
          <div className="k">Open</div>
          <div className="v">{openCount}</div>
        </Card>
        <Card className="stat">
          <div className="k">Overdue</div>
          <div className="v">{overdueCount}</div>
        </Card>
        <Card className="stat">
          <div className="k">Total</div>
          <div className="v">{directives.length}</div>
        </Card>
      </div>

      <Card>
        <CardHeader title="New directive" />
        <CardBody>
          <form action={createDirective} className="stack gap-2">
            <FormField name="title" label="Directive title" placeholder="What must be resolved" required />
            <FormField label="Details" id="body">
              <textarea
                name="body"
                className="textarea"
                placeholder="What the recipient must respond to"
                style={{ minHeight: 80 }}
              />
            </FormField>
            <div className="row gap-2 wrap">
              <FormField label="Recipient" id="issued_to" style={{ flex: 1, minWidth: 200 }}>
                <select name="issued_to" className="input" required>
                  <option value="">Recipient…</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name ?? p.username}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField
                name="response_required_by"
                label="Response due"
                type="datetime-local"
                required
                style={{ flex: 1, minWidth: 200 }}
              />
            </div>
            <div className="row gap-2 wrap">
              <FormField
                name="target_type"
                label="Target type"
                placeholder="e.g. task"
                style={{ flex: 1, minWidth: 140 }}
              />
              <FormField name="target_id" label="Target id" placeholder="Target id" style={{ flex: 1, minWidth: 140 }} />
              <FormField label="Action" id="action" style={{ flex: 1, minWidth: 140 }}>
                <select name="action" className="input">
                  <option value="">Action…</option>
                  {DIRECTIVE_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            <FormField
              label="Escalation chain"
              id="escalation_chain"
              hint="Optional. Hold Ctrl/Cmd to select multiple people."
            >
              <select
                name="escalation_chain"
                className="input"
                style={{ minWidth: 240 }}
                multiple
                size={Math.min(4, people.length || 1)}
              >
                <option value="" disabled>
                  Escalation chain…
                </option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name ?? p.username}
                  </option>
                ))}
              </select>
            </FormField>
            <div className="row">
              <Button type="submit">Issue directive</Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <div id="conflicts">
        <Card>
          <CardHeader title={`Conflicts (${openConflictCount} open)`} />
          <CardBody>
            <DataTable
              columns={conflictColumns}
              rows={conflicts}
              keyExtractor={(c) => c.id}
              emptyTitle="No open directive conflicts"
              emptyDescription="Conflicting directives will appear here once detected."
            />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title={`Directives (${directives.length})`} />
        <CardBody>
          <DataTable
            columns={directiveColumns}
            rows={directives}
            keyExtractor={(d) => d.id}
            emptyTitle="No directives yet"
            emptyDescription="Issue a new directive to assign an obligation to a team member."
          />
        </CardBody>
      </Card>
    </div>
  );
}
