"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { createEmployee, type EmployeeFormState } from "./actions";
import { DEPARTMENTS } from "@/lib/departments";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn" type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create employee"}
    </button>
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
        <div className="field">
          <label className="label">Full name</label>
          <input name="full_name" className="input" placeholder="Nimal Perera" />
        </div>
        <div className="field">
          <label className="label">Username</label>
          <input
            name="username"
            className="input"
            placeholder="nimal"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </div>
      </div>
      <div className="grid cols-2">
        <div className="field">
          <label className="label">Department</label>
          <select name="department" className="select" defaultValue="sales" required>
            {DEPARTMENTS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.icon} {d.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label">Temporary password</label>
          <input name="password" type="text" className="input" placeholder="min 8 characters" required />
        </div>
      </div>
      <label className="row gap-1" style={{ fontSize: "0.85rem" }}>
        <input type="checkbox" name="is_admin" /> Grant administrator access (can manage all departments)
      </label>
      <div className="mt-1">
        <Submit />
      </div>
    </form>
  );
}
