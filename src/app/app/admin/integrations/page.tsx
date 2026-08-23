/**
 * Admin → Integration Gateway (INT-001). Company-scoped registry of applications,
 * connectors, event contracts and command contracts with signature/replay flags.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { createIntegration, createConnector, createEventContract, createCommandContract } from "./actions";

export const metadata = { title: "Integration Gateway — Singha Central" };

export default async function IntegrationsPage() {
  const admin = await requireAdmin();

  let integrations: any[] = [];
  let connectors: any[] = [];
  let events: any[] = [];
  let commands: any[] = [];
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

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Integration Gateway</h1>
          <p className="muted mt-1">Applications, connectors and event/command contracts.</p>
        </div>
        <Link className="btn ghost sm" href="/app/admin">← Admin</Link>
      </div>

      <div className="card">
        <div className="card-title">New application</div>
        <form action={createIntegration} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Application name" required />
          <input name="description" className="input" style={{ flex: 3, minWidth: 200 }} placeholder="Description" />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Applications ({integrations.length} · {activeIntegrations} active)</div>
        {integrations.length === 0 ? (
          <div className="empty">No integrations yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Name</th><th>Description</th><th>Status</th></tr></thead>
              <tbody>
                {integrations.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 600 }}>{i.name}</td>
                    <td className="dim small">{i.description ?? "—"}</td>
                    <td><span className="badge">{i.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">New connector</div>
        <form action={createConnector} className="row gap-1 wrap mt-2">
          <select name="integration_id" className="input" style={{ minWidth: 160 }} required>
            <option value="">Application…</option>
            {integrations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <input name="name" className="input" style={{ flex: 1, minWidth: 130 }} placeholder="Connector name" required />
          <select name="direction" className="input" style={{ width: 140 }}>
            <option value="bidirectional">Bidirectional</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
          <select name="protocol" className="input" style={{ width: 120 }}>
            <option value="https">HTTPS</option>
            <option value="webhook">Webhook</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="grpc">gRPC</option>
            <option value="file">File</option>
          </select>
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Connectors ({connectors.length})</div>
        {connectors.length === 0 ? (
          <div className="empty">No connectors yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Name</th><th>Application</th><th>Direction</th><th>Protocol</th><th>Status</th></tr></thead>
              <tbody>
                {connectors.map((c) => {
                  const app = integrations.find((i) => i.id === c.integration_id);
                  return (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td className="dim small">{app?.name ?? "—"}</td>
                      <td><span className="badge">{c.direction}</span></td>
                      <td className="mono dim small">{c.protocol}</td>
                      <td><span className="badge">{c.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">New event contract</div>
          <form action={createEventContract} className="stack gap-1 mt-2">
            <select name="connector_id" className="input" required>
              <option value="">Connector…</option>
              {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input name="event_type" className="input" placeholder="Event type" required />
            <input name="schema_ref" className="input" placeholder="Schema reference" />
            <label className="row gap-1 small"><input name="signature_required" type="checkbox" defaultChecked /> Signature required</label>
            <label className="row gap-1 small"><input name="replay_protection" type="checkbox" defaultChecked /> Replay protection</label>
            <button className="btn" type="submit">Add event contract</button>
          </form>
        </div>

        <div className="card">
          <div className="card-title">New command contract</div>
          <form action={createCommandContract} className="stack gap-1 mt-2">
            <select name="connector_id" className="input" required>
              <option value="">Connector…</option>
              {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input name="command_type" className="input" placeholder="Command type" required />
            <input name="schema_ref" className="input" placeholder="Schema reference" />
            <label className="row gap-1 small"><input name="signature_required" type="checkbox" defaultChecked /> Signature required</label>
            <label className="row gap-1 small"><input name="replay_protection" type="checkbox" defaultChecked /> Replay protection</label>
            <button className="btn" type="submit">Add command contract</button>
          </form>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">Event contracts ({events.length})</div>
          {events.length === 0 ? (
            <div className="empty">No event contracts.</div>
          ) : (
            <div className="table-wrap mt-3">
              <table className="data">
                <thead><tr><th>Type</th><th>Signature</th><th>Replay</th></tr></thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td style={{ fontWeight: 600 }}>{e.event_type}</td>
                      <td><span className="badge">{e.signature_required ? "required" : "optional"}</span></td>
                      <td><span className="badge">{e.replay_protection ? "protected" : "open"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">Command contracts ({commands.length})</div>
          {commands.length === 0 ? (
            <div className="empty">No command contracts.</div>
          ) : (
            <div className="table-wrap mt-3">
              <table className="data">
                <thead><tr><th>Type</th><th>Signature</th><th>Replay</th></tr></thead>
                <tbody>
                  {commands.map((c) => (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 600 }}>{c.command_type}</td>
                      <td><span className="badge">{c.signature_required ? "required" : "optional"}</span></td>
                      <td><span className="badge">{c.replay_protection ? "protected" : "open"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
