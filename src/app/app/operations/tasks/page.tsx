/**
 * Operations → Tasks. Server page wrapper around the reusable `TasksPanel`.
 */
import { requireDepartment } from "@/lib/auth";
import { TasksPanel } from "@/components/spatial/panels/TasksPanel";

export const metadata = { title: "Tasks — Singha Central" };

export default async function OpsTasks() {
  const p = await requireDepartment("operations");
  return <TasksPanel companyId={p.companyId} />;
}
