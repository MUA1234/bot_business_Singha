import { requireDepartment } from "@/lib/auth";
import { Placeholder } from "@/components/Placeholder";

export const metadata = { title: "Staff — Singha" };

export default async function HrStaff() {
  await requireDepartment("hr");
  return <Placeholder departmentKey="hr" title="Staff" />;
}
