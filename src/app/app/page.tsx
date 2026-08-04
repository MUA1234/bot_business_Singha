import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { homePathFor } from "@/lib/departments";

export default async function AppIndex() {
  const p = await requireProfile();
  redirect(homePathFor(p.isAdmin ? "admin" : p.department));
}
