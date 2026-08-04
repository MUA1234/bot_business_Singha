import { requireDepartment } from "@/lib/auth";
import { Placeholder } from "@/components/Placeholder";

export const metadata = { title: "Suppliers — Singha" };

export default async function Suppliers() {
  await requireDepartment("procurement");
  return <Placeholder departmentKey="procurement" title="Suppliers" />;
}
