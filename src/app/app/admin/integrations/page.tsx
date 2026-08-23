/**
 * Admin → Integration Gateway (INT-001). Company-scoped registry of applications,
 * connectors, event contracts and command contracts with signature/replay flags.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { FormField } from "@/components/ui/FormField";
import {
  createIntegration,
  createConnector,
  createEventContract,
  createCommandContract,
} from "./actions";

export const metadata = { title: "Integration Gateway — Singha Central" };

interface IntegrationRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
}

interface ConnectorRow {
  id: string;
  integration_id: string;
  name: string;
  direction: string;
  protocol: string;
  status: string;
}

interface EventContractRow {
  id: string;
  connector_id: string;
  event_type: string;
  schema_ref: string | null;
  signature_required: boolean;
  replay_protection: boolean;
}

interface CommandContractRow {
  id: string;
  connector_id: string;
  command_type: string;
  schema_ref: string | null;
  signature_required: boolean;
  replay_protection: boolean;
}

export default async function IntegrationsPage() {
  const admin = await requireAdmin();

  let integrations: IntegrationRow[] = [];
  let connectors: ConnectorRow[] = [];
  let events: EventContractRow[] = [];
  let commands: CommandContractRow[] = [];
  try {
    integrations = (await supabaseReadClient()
      .from("integrations")
      .select("id, name, description, status")
      .eq("company_id", admin.companyId)
      .order("name")
      .limit(200)).data ?? [];

    connectors = (await supabaseReadClient()
      .from("connectors")
      .select("id, integration_id, name, direction, protocol, status")
      .eq("company_id", admin.companyId)
      .order("name")
      .limit(200)).data ?? [];

    events = (await supabaseReadClient()
      .from("integration_event_contracts")
      .select("id, connector_id, event_type, schema_ref, signature_required, replay_protection")
      .eq("company_id", admin.companyId)
      .order("event_type")
      .limit(200)).data ?? [];

    commands = (await supabaseReadClient()
      .from("integration_command_contracts")
      .select("id, connector_id, command_type, schema_ref, signature_required, replay_protection")
      .eq("company_id", admin.companyId)
      .order("command_type")
      .limit(200)).data ?? [];
  } catch {
    // leave lists empty
  }

  const activeIntegrations = integrations.filter((i) => i.status === "active").length;

  const integrationColumns: DataTableColumn<IntegrationRow>[] = [
    { key: "name", header: "Name", render: (i) => <strong>{i.name}</strong> },
    { key: "description", header: "Description", render: (i) => <span className="dim small">{i.description ?? "—"}</span> },
    { key: "status", header: "Status", render: (i) => <StatusBadge status={i.status} /> },
  ];

  const connectorColumns: DataTableColumn<ConnectorRow>[] = [
    { key: "name", header: "Name", render: (c) => <strong>{c.name}</strong> },
    {
      key: "application",
      header: "Application",
      render: (c) => {
        const app = integrations.find((i) => i.id === c.integration_id);
        return <span className="dim small">{app?.name ?? "—"}</span>;
      },
    },
    { key: "direction", header: "Direction", render: (c) => <Badge>{c.direction}</Badge> },
    { key: "protocol", header: "Protocol", render: (c) => <span className="mono dim small">{c.protocol}</span> },
    { key: "status", header: "Status", render: (c) => <StatusBadge status={c.status} /> },
  ];

  const flagBadge = (on: boolean) => (
    <Badge variant={on ? "ok" : "default"}>{on ? "Yes" : "No"}</Badge>
  );

  const eventColumns: DataTableColumn<EventContractRow>[] = [
    { key: "type", header: "Type", render: (e) => <strong>{e.event_type}</strong> },
    { key: "connector", header: "Connector", render: (e) => {
      const c = connectors.find((x) => x.id === e.connector_id);
      return <span className="dim small">{c?.name ?? "—"}</span>;
    } },
    { key: "signature", header: "Signature", render: (e) => flagBadge(e.signature_required) },
    { key: "replay", header: "Replay", render: (e) => flagBadge(e.replay_protection) },
  ];

  const commandColumns: DataTableColumn<CommandContractRow>[] = [
    { key: "type", header: "Type", render: (c) => <strong>{c.command_type}</strong> },
    { key: "connector", header: "Connector", render: (c) => {
      const x = connectors.find((cn) => cn.id === c.connector_id);
      return <span className="dim small">{x?.name ?? "—"}</span>;
    } },
    { key: "signature", header: "Signature", render: (c) => flagBadge(c.signature_required) },
    { key: "replay", header: "Replay", render: (c) => flagBadge(c.replay_protection) },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between wrap gap-2">
        <div>
          <h1>Integration Gateway</h1>
          <p className="muted mt-1">Applications, connectors and event/command contracts.</p>
        </div>
        <Link className="btn ghost sm" href="/app/admin">← Admin</Link>
      </div>

      <Card>
        <CardHeader title="New application" />
        <CardBody>
          <form action={createIntegration} className="row gap-2 wrap">
            <div style={{ flex: 2, minWidth: 160 }}>
              <FormField name="name" label="Application name" placeholder="e.g. QuickBooks bridge" required />
            </div>
            <div style={{ flex: 3, minWidth: 200 }}>
              <FormField name="description" label="Description" placeholder="What this application does" />
            </div>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <Button type="submit">Add</Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Applications (${integrations.length} · ${activeIntegrations} active)`} />
        <CardBody>
          <DataTable
            columns={integrationColumns}
            rows={integrations}
            keyExtractor={(i) => i.id}
            emptyTitle="No applications yet"
            emptyDescription="Create an application before adding connectors."
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="New connector" />
        <CardBody>
          <form action={createConnector} className="row gap-2 wrap">
            <div style={{ minWidth: 160, flex: 1 }}>
              <label htmlFor="connector-integration" className="label">Application</label>
              <select id="connector-integration" name="integration_id" className="input" required>
                <option value="">Choose application…</option>
                {integrations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 130 }}>
              <FormField name="name" label="Connector name" placeholder="e.g. invoice-out" required />
            </div>
            <div style={{ minWidth: 120, flex: "0 1 140px" }}>
              <label htmlFor="connector-direction" className="label">Direction</label>
              <select id="connector-direction" name="direction" className="input" defaultValue="bidirectional">
                <option value="bidirectional">Bidirectional</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </div>
            <div style={{ minWidth: 120, flex: "0 1 140px" }}>
              <label htmlFor="connector-protocol" className="label">Protocol</label>
              <select id="connector-protocol" name="protocol" className="input" defaultValue="https">
                <option value="https">HTTPS</option>
                <option value="webhook">Webhook</option>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="grpc">gRPC</option>
                <option value="file">File</option>
              </select>
            </div>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <Button type="submit">Add</Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Connectors (${connectors.length})`} />
        <CardBody>
          <DataTable
            columns={connectorColumns}
            rows={connectors}
            keyExtractor={(c) => c.id}
            emptyTitle="No connectors yet"
            emptyDescription="Connectors belong to an application and define a transport direction."
          />
        </CardBody>
      </Card>

      <div className="grid cols-2">
        <Card>
          <CardHeader title="New event contract" />
          <CardBody>
            <form action={createEventContract} className="stack gap-2">
              <div>
                <label htmlFor="event-connector" className="label">Connector</label>
                <select id="event-connector" name="connector_id" className="input" required>
                  <option value="">Choose connector…</option>
                  {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <FormField name="event_type" label="Event type" placeholder="e.g. invoice.paid" required />
              <FormField name="schema_ref" label="Schema reference" placeholder="e.g. schemas/invoice-paid/v1" />
              <label className="row gap-1 small">
                <input name="signature_required" type="checkbox" defaultChecked />
                Signature required
              </label>
              <label className="row gap-1 small">
                <input name="replay_protection" type="checkbox" defaultChecked />
                Replay protection
              </label>
              <Button type="submit">Add event contract</Button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="New command contract" />
          <CardBody>
            <form action={createCommandContract} className="stack gap-2">
              <div>
                <label htmlFor="command-connector" className="label">Connector</label>
                <select id="command-connector" name="connector_id" className="input" required>
                  <option value="">Choose connector…</option>
                  {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <FormField name="command_type" label="Command type" placeholder="e.g. create.invoice" required />
              <FormField name="schema_ref" label="Schema reference" placeholder="e.g. schemas/create-invoice/v1" />
              <label className="row gap-1 small">
                <input name="signature_required" type="checkbox" defaultChecked />
                Signature required
              </label>
              <label className="row gap-1 small">
                <input name="replay_protection" type="checkbox" defaultChecked />
                Replay protection
              </label>
              <Button type="submit">Add command contract</Button>
            </form>
          </CardBody>
        </Card>
      </div>

      <div className="grid cols-2">
        <Card>
          <CardHeader title={`Event contracts (${events.length})`} />
          <CardBody>
            <DataTable
              columns={eventColumns}
              rows={events}
              keyExtractor={(e) => e.id}
              emptyTitle="No event contracts"
              emptyDescription="Event contracts describe inbound messages this company accepts."
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={`Command contracts (${commands.length})`} />
          <CardBody>
            <DataTable
              columns={commandColumns}
              rows={commands}
              keyExtractor={(c) => c.id}
              emptyTitle="No command contracts"
              emptyDescription="Command contracts describe outbound actions this company can issue."
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
