import { type ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: "sm" | "md" | "lg";
  as?: "div" | "article" | "section";
  ariaLabel?: string;
  style?: React.CSSProperties;
}

export function Card({ children, className = "", padding = "md", as: Tag = "div", ariaLabel, style }: CardProps) {
  const padClass = padding === "sm" ? "pad-sm" : padding === "lg" ? "pad-lg" : "";
  return (
    <Tag
      className={`card${padClass ? ` ${padClass}` : ""}${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
      style={style}
    >
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
  padding?: "sm" | "md" | "lg" | "none";
}

export function CardBody({ children, className = "", padding = "md" }: CardBodyProps) {
  const padClass =
    padding === "sm" ? "pad-sm" : padding === "lg" ? "pad-lg" : padding === "none" ? "pad-none" : "";
  return <div className={`card-body${padClass ? ` ${padClass}` : ""}${className ? ` ${className}` : ""}`}>{children}</div>;
}

interface CardFooterProps {
  children: ReactNode;
  className?: string;
}

export function CardFooter({ children, className = "" }: CardFooterProps) {
  return <div className={`card-footer${className ? ` ${className}` : ""}`}>{children}</div>;
}
