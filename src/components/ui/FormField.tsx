import { type InputHTMLAttributes, type ReactNode, forwardRef, useId, isValidElement, cloneElement } from "react";

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  children?: ReactNode;
}

/**
 * Standard labelled field. Supports a native <input> via `input` props, or any
 * custom control passed as `children`. When a single child element is provided,
 * it is cloned with the field id and ARIA descriptors so the label stays linked
 * to the real control.
 */
export const FormField = forwardRef<HTMLInputElement, FormFieldProps>(
  ({ label, hint, error, id, children, className = "", ...inputProps }, ref) => {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    const errorId = `${fieldId}-error`;
    const hintId = hint ? `${fieldId}-hint` : undefined;
    const describedBy = [hintId, error ? errorId : undefined].filter(Boolean).join(" ") || undefined;

    return (
      <div className={`field${className ? ` ${className}` : ""}`}>
        <label htmlFor={fieldId} className="label">
          {label}
        </label>
        {children ? (
          isValidElement(children) ? (
            cloneElement(children as React.ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>, {
              id: fieldId,
              "aria-describedby": describedBy,
              "aria-invalid": !!error,
            })
          ) : (
            <div id={fieldId} aria-describedby={describedBy} aria-invalid={!!error}>
              {children}
            </div>
          )
        ) : (
          <input
            ref={ref}
            id={fieldId}
            className={`input${error ? " invalid" : ""}`}
            aria-describedby={describedBy}
            aria-invalid={!!error}
            {...inputProps}
          />
        )}
        {hint && !error && (
          <span id={hintId} className="field-hint">
            {hint}
          </span>
        )}
        {error && (
          <span id={errorId} className="field-error" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  },
);

FormField.displayName = "FormField";
