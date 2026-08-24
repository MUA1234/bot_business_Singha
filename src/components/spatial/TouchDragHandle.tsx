"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

/**
 * A clearly separated drag handle for windows. It is at least 48×48 px, has no
 * default button behaviour, and is labelled for screen readers.
 */
export const TouchDragHandle = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function TouchDragHandle({ className = "", ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={`touch-drag-handle${className ? ` ${className}` : ""}`}
        aria-label="Drag window"
        title="Drag"
        {...props}
      >
        <span className="drag-grip" aria-hidden="true" />
      </button>
    );
  },
);
