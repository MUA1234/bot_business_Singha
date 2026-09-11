import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { landingPathFor } from "@/lib/departments";

export default async function AppIndex() {
  const p = await requireProfile();
  // `landingPathFor` — not `/app/<department>` — because a non-admin in the `admin`
  // department has no openable dashboard and would otherwise redirect forever.
  redirect(landingPathFor(p));
}
