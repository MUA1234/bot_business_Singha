import { requireDepartment } from "@/lib/auth";
import { Placeholder } from "@/components/Placeholder";

export const metadata = { title: "Marketing — Singha" };

export default async function MarketingHome() {
  await requireDepartment("marketing");
  return <Placeholder departmentKey="marketing" />;
}
