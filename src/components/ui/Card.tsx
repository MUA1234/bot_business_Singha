import { type ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: "sm" | "md" | "lg";
  as?: "div" | "article" | "section";
  ariaLabel?: string;
}

export function Card({ children, className = "", padding = "md", as: Tag = "div", ariaLabel }: CardProps) {
  const padClass = padding === "sm" ? "pad-sm" : padding === "lg" ? "pad-lg" : "";
  return (
    <Tag className={`card${padClass ? ` ${padClass}` : ""}${className ? ` ${className}` : ""}`} aria-label={ariaLabel}>
      {children}
    </Tag>
  );
}

interface CardHeaderProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  icon?: string;
  className?: string;
}

export function CardHeader({ title, subtitle, action, className = "" }: CardHeaderProps) {
  return (
    <div className={`card-header${className ? ` ${className}` : ""}`}>
      <div className="card-header-text">
        {title && <div className="card-title">{title}</div>}
        {subtitle && <div className="card-sub">{subtitle}</div>}
      </div>
      {action && <div className="card-header-action">{action}</div>}
    </div>
  );
}

interface CardBodyProps {
  children: ReactNode;
  className?: string;
}

export function CardBody({ children, className = "" }: CardBodyProps) {
  return <div className={`card-body${className ? ` ${className}` : ""}`}>{children}</div>;
}

interface CardFooterProps {
  children: ReactNode;
  className?: string;
}

export function CardFooter({ children, className = "" }: CardFooterProps) {
  return <div className={`card-footer${className ? ` ${className}` : ""}`}>{children}</div>;
}
