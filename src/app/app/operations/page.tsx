import { requireDepartment } from "@/lib/auth";
import { Placeholder } from "@/components/Placeholder";

export const metadata = { title: "Operations — Singha" };

export default async function OperationsHome() {
  await requireDepartment("operations");
  return <Placeholder departmentKey="operations" />;
}
