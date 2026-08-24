"use client";

import Link from "next/link";
import { Card, CardHeader, CardBody, Badge, DataTable, type DataTableColumn } from "@/components/ui";

type PlainObject = Record<string, unknown>;

export interface AlertRow {
  key: string;
  severity: "critical" | "warning" | "info";
  message: string;
}

export interface BacklogMetricsData {
  pending: { label: string; danger: boolean };
  processing: { label: string; danger: boolean };
  retryWait: { label: string; danger: boolean };
  expiredLease: { label: string; danger: boolean };
  deadLetter: { label: string; danger: boolean };
  oldestPendingLabel: string;
  unavailable: boolean;
}

export interface SystemHealthPanelData {
  health: { level: "critical" | "warn" | "ok"; issues: string[] };
  healthVariant: "danger" | "warn" | "ok";
  alerts: AlertRow[];
  tiles: { k: string; v: string; danger: boolean }[];
  aiCost: string;
  auditsLabel: string;
  backlog: BacklogMetricsData;
}

interface SystemHealthPanelContentProps {
  data: PlainObject;
  embedded?: boolean;
}

export function SystemHealthPanelContent({ data, embedded }: SystemHealthPanelContentProps) {
  const {
    health,
    healthVariant,
    alerts,
    tiles,
    aiCost,
    auditsLabel,
    backlog,
  } = data as unknown as SystemHealthPanelData;

  const alertColumns: DataTableColumn<AlertRow>[] = [
    {
      key: "severity",
      header: "Severity",
      render: (a) => (
        <Badge variant={a.severity === "critical" ? "danger" : a.severity === "warning" ? "warn" : "info"}>
          {a.severity}
        </Badge>
      ),
    },
    { key: "message", header: "Message", render: (a) => a.message },
  ];

  return (
    <div className="stack gap-3">
      {!embedded && (
        <div className="row between wrap">
          <div>
            <h1>System Health</h1>
            <p className="muted mt-1">
              Queues, failures, and AI cost.{" "}
              <Badge variant={healthVariant}>{health.level.toUpperCase()}</Badge>
            </p>
          </div>
          <Link className="btn ghost sm" href="/app/admin">← Admin</Link>
        </div>
      )}

      {health.issues.length > 0 && (
        <div className={`notice ${health.level === "critical" ? "err" : "ok"}`}>
          {health.issues.map((i, idx) => (
            <div key={idx}>• {i}</div>
          ))}
        </div>
      )}

      {alerts.length > 0 && (
        <Card>
          <CardHeader title={`Alerts (${alerts.length})`} />
          <CardBody>
            <DataTable columns={alertColumns} rows={alerts} keyExtractor={(a) => a.key} />
          </CardBody>
        </Card>
      )}

      <div className="grid cols-3">
        {tiles.map((t) => (
          <Card key={t.k} className="stat">
            <div className="k">{t.k}</div>
            <div className="v" style={{ color: t.danger ? "var(--danger)" : undefined }}>
              {t.v}
            </div>
          </Card>
        ))}
      </div>

      <div className="grid cols-2">
        <Card className="stat">
          <div className="k">AI cost (USD)</div>
          <div className="v" style={{ color: "var(--info)" }}>
            {aiCost}
          </div>
        </Card>
        <Card className="stat">
          <div className="k">Audit events</div>
          <div className="v">{auditsLabel}</div>
        </Card>
      </div>

      {/* CTL-003 — surface the migration 0069 backlog RPC so the operator sees the durable inbound pipeline. */}
      <Card>
        <CardHeader title="Source-event backlog" />
        <CardBody>
          <div className="grid cols-3">
            <Card className="stat">
              <div className="k">Pending</div>
              <div className="v">{backlog.pending.label}</div>
            </Card>
            <Card className="stat">
              <div className="k">Processing</div>
              <div className="v">{backlog.processing.label}</div>
            </Card>
            <Card className="stat">
              <div className="k">Retry wait</div>
              <div className="v">{backlog.retryWait.label}</div>
            </Card>
            <Card className="stat">
              <div className="k">Expired lease</div>
              <div
                className="v"
                style={{ color: backlog.expiredLease.danger ? "var(--danger)" : undefined }}
              >
                {backlog.expiredLease.label}
              </div>
            </Card>
            <Card className="stat">
              <div className="k">Dead letter</div>
              <div
                className="v"
                style={{ color: backlog.deadLetter.danger ? "var(--danger)" : undefined }}
              >
                {backlog.deadLetter.label}
              </div>
            </Card>
            <Card className="stat">
              <div className="k">Oldest pending</div>
              <div className="v">{backlog.oldestPendingLabel}</div>
            </Card>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
