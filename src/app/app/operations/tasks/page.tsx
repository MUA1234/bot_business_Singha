import { requireDepartment } from "@/lib/auth";
import { Placeholder } from "@/components/Placeholder";

export const metadata = { title: "Tasks — Singha" };

export default async function OpsTasks() {
  await requireDepartment("operations");
  return <Placeholder departmentKey="operations" title="Tasks" />;
}
