import { Icon } from "@/components/Icon";

export type BadgeVariant = "default" | "ok" | "warn" | "danger" | "info" | "accent";

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  icon?: string;
  className?: string;
  title?: string;
}

/**
 * Small status pill. `variant` uses reserved semantic colours except `accent`,
 * which is reserved for brand highlights (never for status).
 */
export function Badge({ children, variant = "default", icon, className = "", title }: BadgeProps) {
  const variantClass = variant === "default" ? "" : ` ${variant}`;
  return (
    <span className={`badge${variantClass}${className ? ` ${className}` : ""}`} title={title}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

/**
 * Canonical status maps. Keep these in sync with the domain enums used in the
 * database so UI status colours stay consistent across the app.
 */
export const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  active: "ok",
  completed: "ok",
  done: "ok",
  paid: "ok",
  accepted: "ok",
  approved: "ok",
  sent: "info",
  open: "info",
  pending: "warn",
  draft: "default",
  overloaded: "danger",
  rejected: "danger",
  cancelled: "danger",
  overdue: "danger",
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className = "" }: StatusBadgeProps) {
  const normalized = status.toLowerCase();
  const variant = STATUS_VARIANTS[normalized] ?? "default";
  return (
    <Badge variant={variant} className={className}>
      {status}
    </Badge>
  );
}
