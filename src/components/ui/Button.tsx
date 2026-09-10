"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon } from "@/components/Icon";

type ButtonVariant = "primary" | "ghost" | "danger" | "secondary";
type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: string;
  rightIcon?: string;
  children: ReactNode;
}

/**
 * Unified button. Always renders a real <button>; links should use next/link wrapped
 * around a button, or a styled <a> when semantically required.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      leftIcon,
      rightIcon,
      children,
      disabled,
      className = "",
      ...rest
    },
    ref,
  ) => {
    const sizeClass = size === "sm" ? "sm" : size === "lg" ? "lg" : "";
    const variantClass =
      variant === "ghost" ? "ghost" : variant === "danger" ? "danger" : variant === "secondary" ? "secondary" : "";
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        className={`btn${variantClass ? ` ${variantClass}` : ""}${sizeClass ? ` ${sizeClass}` : ""}${loading ? " loading" : ""}${className ? ` ${className}` : ""}`}
        disabled={isDisabled}
        aria-busy={loading}
        {...rest}
      >
        {loading && (
          <span className="btn-spinner" aria-hidden="true">
            <Icon name="loader-2" size={size === "sm" ? 14 : 16} className="spin" />
          </span>
        )}
        {!loading && leftIcon && <Icon name={leftIcon} size={size === "sm" ? 14 : 16} />}
        <span className="btn-label">{children}</span>
        {!loading && rightIcon && <Icon name={rightIcon} size={size === "sm" ? 14 : 16} />}
      </button>
    );
  },
);

Button.displayName = "Button";
