import { SpatialEnvironment } from "@/components/os/SpatialEnvironment";
import { Brand } from "@/components/Brand";
import { getProfile } from "@/lib/auth";
import { homePathFor } from "@/lib/departments";
import { redirect } from "next/navigation";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in — Singha Central" };

export default async function LoginPage() {
  const existing = await getProfile();
  if (existing) redirect(homePathFor(existing.department));

  return (
    <>
      <SpatialEnvironment />
      <main className="auth-wrap">
        <div className="auth-card stack gap-3">
          <div className="stack gap-2 center" style={{ textAlign: "center" }}>
            <Brand size={44} />
            <div>
              <h1 style={{ fontSize: "1.5rem" }}>Sign in</h1>
              <p className="muted mt-1">Your work, ready where you left it.</p>
            </div>
          </div>
          <div className="card pad-lg">
            <LoginForm />
          </div>
          <p className="small dim" style={{ textAlign: "center" }}>
            Accounts are created by your administrator. Forgot your password? Ask an admin to reset
            it.
          </p>
        </div>
      </main>
    </>
  );
}
