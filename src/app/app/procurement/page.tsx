import { requireDepartment } from "@/lib/auth";
import { Placeholder } from "@/components/Placeholder";

export const metadata = { title: "Procurement — Singha" };

export default async function ProcurementHome() {
  await requireDepartment("procurement");
  return <Placeholder departmentKey="procurement" />;
}
