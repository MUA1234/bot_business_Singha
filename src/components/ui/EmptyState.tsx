import { Icon } from "@/components/Icon";
import { Button } from "./Button";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: string;
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
  className?: string;
}

/**
 * On-brand empty state. Always rendered inside a panel so it is readable over the
 * living background. If `action.href` is provided, renders a next/link wrapper
 * with an anchor-styled button.
 */
export function EmptyState({ title, description, icon = "inbox", action, className = "" }: EmptyStateProps) {
  return (
    <div className={`empty-state${className ? ` ${className}` : ""}`}>
      <div className="empty-state-icon" aria-hidden="true">
        <Icon name={icon} size={40} />
      </div>
      <div className="empty-state-title">{title}</div>
      {description && <p className="empty-state-desc">{description}</p>}
      {action && (
        <div className="empty-state-action">
          {action.href ? (
            <a href={action.href} className="btn sm">
              {action.label}
            </a>
          ) : (
            <Button size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
