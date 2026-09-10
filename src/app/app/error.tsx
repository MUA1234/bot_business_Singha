"use client";

import { useEffect } from "react";
import { Card, CardBody, CardFooter } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";

export default function AppErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("App error boundary caught:", error);
  }, [error]);

  return (
    <div className="stack gap-3" role="alert" aria-live="assertive">
      <div>
        <h1>Something went wrong</h1>
        <p className="muted mt-1">The application hit an unexpected problem.</p>
      </div>

      <Card>
        <CardBody className="stack gap-2" style={{ textAlign: "center" }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              margin: "0 auto",
              background: "var(--panel-strong)",
              border: "1px solid var(--panel-border)",
              color: "var(--danger)",
            }}
            aria-hidden="true"
          >
            <Icon name="alert-triangle" size={24} />
          </div>
          <div style={{ fontSize: "1.05rem", fontWeight: 700 }}>{error.message || "Unknown error"}</div>
          {error.digest && <div className="mono small dim">Ref: {error.digest}</div>}
          <p className="muted small">
            If retrying does not help, contact support with the reference above.
          </p>
        </CardBody>
        <CardFooter>
          <Button onClick={() => reset()} leftIcon="refresh-cw">
            Try again
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
