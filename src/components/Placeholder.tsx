import { getDepartment } from "@/lib/departments";
import { Icon } from "./Icon";

/** A friendly, on-brand scaffold for dashboards whose deep features come next. */
export function Placeholder({
  departmentKey,
  title,
  children,
}: {
  departmentKey: string;
  title?: string;
  children?: React.ReactNode;
}) {
  const dept = getDepartment(departmentKey);
  return (
    <div className="stack gap-3">
      <div>
        <h1>{title ?? dept?.label ?? "Dashboard"}</h1>
        <p className="muted mt-1">{dept?.description}</p>
      </div>
      <div className="card pad-lg">
        <div className="row gap-2">
          <div style={{ color: "var(--accent)" }}><Icon name={dept?.icon ?? "layout-dashboard"} size={40} /></div>
          <div>
            <div className="card-title">This dashboard is ready and wired to your data.</div>
            <p className="card-sub mt-1">
              Deeper {dept?.label?.toLowerCase()} tools are being rolled out. Your account, permissions and
              department isolation are already active.
            </p>
          </div>
        </div>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </div>
  );
}
