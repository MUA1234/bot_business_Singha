"use client";

import { useId, useState, type InputHTMLAttributes, forwardRef } from "react";
import { Icon } from "@/components/Icon";

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  clearLabel?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ label = "Search", clearLabel = "Clear search", className = "", value, onChange, ...rest }, ref) => {
    const id = useId();
    const [internal, setInternal] = useState("");
    const controlled = value !== undefined;
    const current = controlled ? String(value ?? "") : internal;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!controlled) setInternal(e.target.value);
      onChange?.(e);
    };

    const clear = () => {
      if (!controlled) setInternal("");
      // Dispatch a synthetic change event so controlled callers can react.
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (nativeInputValueSetter && input) {
        nativeInputValueSetter.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };

    return (
      <div className={`search-input${className ? ` ${className}` : ""}`}>
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <Icon name="search" size={16} className="search-input-icon" />
        <input
          ref={ref}
          id={id}
          type="search"
          className="input"
          placeholder={rest.placeholder ?? label}
          value={current}
          onChange={handleChange}
          {...rest}
        />
        {current && (
          <button
            type="button"
            className="search-input-clear"
            onClick={clear}
            aria-label={clearLabel}
            title={clearLabel}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
    );
  },
);

SearchInput.displayName = "SearchInput";
