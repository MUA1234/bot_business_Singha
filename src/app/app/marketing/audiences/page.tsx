import { requireDepartment } from "@/lib/auth";
import { Placeholder } from "@/components/Placeholder";

export const metadata = { title: "Audiences — Singha" };

export default async function Audiences() {
  await requireDepartment("marketing");
  return <Placeholder departmentKey="marketing" title="Audiences" />;
}
