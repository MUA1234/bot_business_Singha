"use client";

import Link from "next/link";
import { Card, CardBody } from "./Card";
import { Icon } from "@/components/Icon";

interface PermissionDeniedProps {
  title?: string;
  actionHref?: string;
  actionLabel?: string;
  children?: React.ReactNode;
}

/**
 * Consistent permission-denied state. Explains that the current role cannot use the
 * feature and offers a safe exit if an action href is provided.
 */
export function PermissionDenied({
  title = "Permission required",
  actionHref = "/app",
  actionLabel = "Back to dashboard",
  children,
}: PermissionDeniedProps) {
  return (
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
          <Icon name="shield-alert" size={24} />
        </div>
        <div style={{ fontSize: "1.05rem", fontWeight: 700 }}>{title}</div>
        <div className="muted small">{children}</div>
        {actionHref && (
          <div className="mt-1">
            <Link className="btn sm" href={actionHref}>
              {actionLabel}
            </Link>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
