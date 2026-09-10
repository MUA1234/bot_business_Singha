"use client";

import { useFormState } from "react-dom";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
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
      <div>
        <label htmlFor="channel-account-channel" className="label">Channel</label>
        <select id="channel-account-channel" name="channel" className="input" defaultValue="whatsapp">
          <option value="whatsapp">WhatsApp</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
        </select>
      </div>
      <FormField
        name="account"
        label="Receiving account id"
        hint="WhatsApp: metadata.phone_number_id from Meta"
        placeholder="e.g. 123456789012345"
        required
      />
      <FormField
        name="label"
        label="Label"
        hint="Helps people recognise the number or address"
        placeholder="Main Colombo WhatsApp"
      />
      <Button type="submit">Save mapping (inactive)</Button>
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
      <Button type="submit" size="sm" variant="ghost">
        {active ? "Deactivate" : "Activate"}
      </Button>
      <Notice state={state} />
    </form>
  );
}

export function ReviewerForm({ userId, name, hasRole }: { userId: string; name: string; hasRole: boolean }) {
  const [state, action] = useFormState<SetupState, FormData>(setReviewerRole, {});
  return (
    <form action={action} className="row gap-2 wrap" style={{ alignItems: "center" }}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="roleKey" value="finance_reviewer" />
      <input type="hidden" name="grant" value={String(!hasRole)} />
      <span className="grow">{name}</span>
      <Button type="submit" size="sm" variant={hasRole ? "danger" : "secondary"}>
        {hasRole ? "Remove reviewer role" : "Make reviewer"}
      </Button>
      <Notice state={state} />
    </form>
  );
}
