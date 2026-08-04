import { requireDepartment } from "@/lib/auth";
import { Placeholder } from "@/components/Placeholder";

export const metadata = { title: "Human Resources — Singha" };

export default async function HrHome() {
  await requireDepartment("hr");
  return <Placeholder departmentKey="hr" />;
}
