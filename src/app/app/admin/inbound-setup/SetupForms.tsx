"use client";

import { useFormState } from "react-dom";
import { addChannelAccount, setChannelAccountActive, setReviewerRole, type SetupState } from "./actions";

function Notice({ state }: { state: SetupState }) {
  return (
    <>
      {state.error && <div className="notice err mt-2">{state.error}</div>}
      {state.ok && <div className="notice ok mt-2">{state.ok}</div>}
    </>
  );
}

export function AddAccountForm() {
  const [state, action] = useFormState<SetupState, FormData>(addChannelAccount, {});
  return (
    <form action={action} className="stack gap-2 mt-2" style={{ maxWidth: 560 }}>
      <select name="channel" className="input" defaultValue="whatsapp">
        <option value="whatsapp">WhatsApp</option>
        <option value="email">Email</option>
        <option value="sms">SMS</option>
      </select>
      <input name="account" className="input" placeholder="Receiving account id — WhatsApp: metadata.phone_number_id from Meta" required />
      <input name="label" className="input" placeholder="Label for people to recognise it (optional)" />
      <button className="btn" type="submit">Save mapping (inactive)</button>
      <p className="muted small">
        A new mapping is saved INACTIVE and changes nothing until you activate it. Nothing here
        invents a mapping or guesses which number belongs to you.
      </p>
      <Notice state={state} />
    </form>
  );
}

export function ActivateForm({ id, active }: { id: string; active: boolean }) {
  const [state, action] = useFormState<SetupState, FormData>(setChannelAccountActive, {});
  return (
    <form action={action} className="row gap-2">
      <input type="hidden" name="accountId" value={id} />
      <input type="hidden" name="active" value={String(!active)} />
      <button className="btn" type="submit">{active ? "Deactivate" : "Activate"}</button>
      <Notice state={state} />
    </form>
  );
}

export function ReviewerForm({ userId, name, hasRole }: { userId: string; name: string; hasRole: boolean }) {
  const [state, action] = useFormState<SetupState, FormData>(setReviewerRole, {});
  return (
    <form action={action} className="row gap-2" style={{ alignItems: "center" }}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="roleKey" value="finance_reviewer" />
      <input type="hidden" name="grant" value={String(!hasRole)} />
      <span>{name}</span>
      <button className="btn" type="submit">{hasRole ? "Remove reviewer role" : "Make reviewer"}</button>
      <Notice state={state} />
    </form>
  );
}
