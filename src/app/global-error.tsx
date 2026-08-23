"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("Global error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ background: "var(--bg-0)" }}>
        <div className="auth-wrap">
          <div className="card auth-card" style={{ textAlign: "center" }}>
            <h1 style={{ color: "var(--danger)" }}>Something went wrong</h1>
            <p className="muted mt-2">
              The application hit an unexpected error. Try reloading the page, or contact support if
              the problem persists.
            </p>
            {error.digest && <p className="small dim mt-2">Reference: {error.digest}</p>}
            <div className="mt-3 row center gap-2">
              <button onClick={() => reset()} className="btn">
                Try again
              </button>
              <a href="/app" className="btn ghost">
                Dashboard
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
