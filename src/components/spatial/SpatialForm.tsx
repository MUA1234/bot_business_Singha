"use client";

import { useCallback, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/**
 * A client form wrapper that calls an existing server action and then refreshes the
 * current route so embedded windows in the spatial workspace stay up to date.
 *
 * Existing actions continue to revalidate their own routes; this wrapper adds a
 * refresh of `/app/spatial` without modifying the underlying mutation logic.
 */
interface SpatialFormProps {
  action: (formData: FormData) => Promise<void>;
  children?: ReactNode;
  submitLabel?: string;
  submitVariant?: "primary" | "ghost" | "danger" | "secondary";
  submitSize?: "sm" | "md" | "lg";
  hidden?: Record<string, string>;
  className?: string;
  style?: React.CSSProperties;
}

export function SpatialForm({
  action,
  children,
  submitLabel,
  submitVariant = "primary",
  submitSize = "sm",
  hidden,
  className = "",
  style,
}: SpatialFormProps) {
  const router = useRouter();

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      const formData = new FormData(form);
      await action(formData);
      router.refresh();
      form.reset();
    },
    [action, router],
  );

  return (
    <form onSubmit={handleSubmit} className={className} style={style}>
      {hidden &&
        Object.entries(hidden).map(([name, value]) => (
          <input type="hidden" name={name} value={value} key={name} />
        ))}
      {children}
      {submitLabel && (
        <Button type="submit" variant={submitVariant} size={submitSize}>
          {submitLabel}
        </Button>
      )}
    </form>
  );
}
