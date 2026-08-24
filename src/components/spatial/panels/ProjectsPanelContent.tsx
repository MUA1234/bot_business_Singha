import Link from "next/link";
import * as React from "react";
import { Card, CardHeader, CardBody, Badge, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { type ProjectPriority } from "@/modules/project/portfolio-prioritisation";

export type PlainObject = Record<string, unknown>;

export interface Project {
  id: string;
  name: string;
  code: string | null;
  status: string;
  created_at: string;
}

export function statusVariant(status: string) {
  if (status === "active") return "ok";
  if (status === "on_hold") return "warn";
  if (status === "cancelled") return "danger";
  return "default";
}

export interface ProjectsPanelContentProps {
  data: PlainObject;
  embedded?: boolean;
}

export function ProjectsPanelContent({ data, embedded }: ProjectsPanelContentProps) {
  const { sortedProjects, priorityMap } = data as { sortedProjects: Project[]; priorityMap: Record<string, ProjectPriority> };

  const columns: DataTableColumn<Project & { index: number }>[] = [
    {
      key: "priority",
      header: "Priority",
      render: (row) => <Badge variant="ok">#{row.index}</Badge>,
    },
    {
      key: "project",
      header: "Project",
      render: (proj) => (
        <Link className="link" href={`/app/operations/projects/${proj.id}`} style={{ fontWeight: 600 }}>
          {proj.name}
        </Link>
      ),
    },
    {
      key: "code",
      header: "Code",
      className: "dim small mono",
      render: (proj) => proj.code ?? "—",
    },
    {
      key: "status",
      header: "Status",
      render: (proj) => <Badge variant={statusVariant(proj.status)}>{proj.status.replace(/_/g, " ")}</Badge>,
    },
    {
      key: "valueRank",
      header: "Value rank",
      align: "right",
      render: (proj) => priorityMap[proj.id]?.valueRank ?? "—",
    },
    {
      key: "riskRank",
      header: "Risk rank",
      align: "right",
      render: (proj) => priorityMap[proj.id]?.riskRank ?? "—",
    },
    {
      key: "capacityRank",
      header: "Capacity rank",
      align: "right",
      render: (proj) => priorityMap[proj.id]?.capacityRank ?? "—",
    },
    {
      key: "dependencyRank",
      header: "Dependency rank",
      align: "right",
      render: (proj) => priorityMap[proj.id]?.dependencyRank ?? "—",
    },
    {
      key: "created",
      header: "Created",
      className: "dim small",
      render: (proj) => fmtDate(proj.created_at),
    },
  ];

  const tableRows = sortedProjects.map((proj, idx) => ({ ...proj, index: idx + 1 }));

  return (
    <div className="stack gap-3">
      {!embedded && (
        <div className="row between">
          <div>
            <h1>Projects</h1>
            <p className="muted mt-1">Reusable project registry with lifecycle states and portfolio prioritisation.</p>
          </div>
          <Link className="btn ghost sm" href="/app/operations">← Operations</Link>
        </div>
      )}

      <Card>
        <CardHeader title="Project registry — prioritised" />
        <CardBody>
          <DataTable
            columns={columns}
            rows={tableRows}
            keyExtractor={(r) => r.id}
            emptyTitle="No projects yet"
            emptyDescription="Create a project to see it ranked."
          />
          <p className="small muted mt-2">
            Priority is a weighted combination of value (higher is better), risk, capacity pressure and overdue/blocked dependencies.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
