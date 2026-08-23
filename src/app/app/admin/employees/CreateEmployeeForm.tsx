"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { createEmployee, type EmployeeFormState } from "./actions";
import { DEPARTMENTS } from "@/lib/departments";
import { FormField } from "@/components/ui/FormField";
import { Button } from "@/components/ui/Button";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} aria-label="Create employee">
      {pending ? "Creating…" : "Create employee"}
    </Button>
  );
}

export function CreateEmployeeForm() {
  const [state, action] = useFormState<EmployeeFormState, FormData>(createEmployee, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form ref={formRef} action={action} className="stack gap-2">
      {state.error && <div className="notice err">{state.error}</div>}
      {state.ok && <div className="notice ok">{state.ok}</div>}
      <div className="grid cols-2">
        <FormField label="Full name" name="full_name" placeholder="Nimal Perera" />
        <FormField
          label="Username"
          name="username"
          placeholder="nimal"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </div>
      <div className="grid cols-2">
        <div className="field">
          <label htmlFor="department" className="label">Department</label>
          <select id="department" name="department" className="select" defaultValue="sales" required>
            {DEPARTMENTS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <FormField
          label="Temporary password"
          name="password"
          type="text"
          placeholder="min 8 characters"
          required
        />
      </div>
      <label className="row gap-1" style={{ fontSize: "0.85rem" }}>
        <input type="checkbox" name="is_admin" aria-label="Grant administrator access" /> Grant administrator access (can manage all departments)
      </label>
      <div className="mt-1">
        <Submit />
      </div>
    </form>
  );
}
