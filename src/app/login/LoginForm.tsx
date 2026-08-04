"use client";

import { useFormState, useFormStatus } from "react-dom";
import { signIn, type LoginState } from "./actions";

function SubmitBtn() {
  const { pending } = useFormStatus();
  return (
    <button className="btn block" type="submit" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export function LoginForm() {
  const [state, formAction] = useFormState<LoginState, FormData>(signIn, {});
  return (
    <form action={formAction} className="stack gap-2">
      {state.error && <div className="notice err">{state.error}</div>}
      <div className="field">
        <label className="label" htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          className="input"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="e.g. nimal"
          required
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="current-password"
          placeholder="••••••••"
          required
        />
      </div>
      <div className="mt-1">
        <SubmitBtn />
      </div>
    </form>
  );
}
