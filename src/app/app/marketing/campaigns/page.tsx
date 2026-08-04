import { requireDepartment } from "@/lib/auth";
import { Placeholder } from "@/components/Placeholder";

export const metadata = { title: "Campaigns — Singha" };

export default async function Campaigns() {
  await requireDepartment("marketing");
  return <Placeholder departmentKey="marketing" title="Campaigns" />;
}
