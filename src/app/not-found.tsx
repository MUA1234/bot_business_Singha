import Link from "next/link";
import { Brand } from "@/components/Brand";
import { SpatialEnvironment } from "@/components/os/SpatialEnvironment";

export const metadata = { title: "Not found — Singha Central" };

export default function NotFound() {
  return (
    <>
      <SpatialEnvironment />
      <div className="auth-wrap">
        <div className="card auth-card" style={{ textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
            <Brand size={48} />
          </div>
          <h1>Page not found</h1>
          <p className="muted mt-2">
            The page you requested does not exist or you do not have permission to view it.
          </p>
          <div className="mt-3">
            <Link href="/app" className="btn">
              Go to dashboard
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
