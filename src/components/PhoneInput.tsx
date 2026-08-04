"use client";

import { useEffect, useMemo, useState } from "react";
import {
  COUNTRIES,
  DEFAULT_ISO2,
  countryByIso2,
  guessCountryIso2,
  toE164,
} from "@/lib/countries";

/**
 * Phone entry that auto-selects the caller's country so nobody has to know the
 * dial code. The country is guessed from the browser locale on mount (overridable
 * from the server via `defaultIso2`), and the dropdown is the manual override.
 * Emits the full E.164 number through a hidden input named `name` (default "phone").
 */
export function PhoneInput({
  name = "phone",
  label = "Phone number",
  defaultIso2,
  defaultLocal = "",
  required,
}: {
  name?: string;
  label?: string;
  defaultIso2?: string;
  defaultLocal?: string;
  required?: boolean;
}) {
  const [iso2, setIso2] = useState(defaultIso2 ?? DEFAULT_ISO2);
  const [local, setLocal] = useState(defaultLocal);

  // Auto-detect once, unless the server already told us the country.
  useEffect(() => {
    if (!defaultIso2) setIso2(guessCountryIso2());
  }, [defaultIso2]);

  const selected = countryByIso2(iso2) ?? countryByIso2(DEFAULT_ISO2)!;
  const e164 = useMemo(() => (local ? toE164(iso2, local) : ""), [iso2, local]);

  return (
    <div className="field">
      <label className="label">{label}</label>
      <div className="phone">
        <select
          className="select"
          value={iso2}
          onChange={(e) => setIso2(e.target.value)}
          aria-label="Country code"
        >
          {COUNTRIES.map((c) => (
            <option key={c.iso2} value={c.iso2}>
              {c.flag} +{c.dial}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="tel"
          inputMode="tel"
          placeholder="77 123 4567"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          required={required}
        />
      </div>
      <input type="hidden" name={name} value={e164} />
      {e164 && (
        <span className="small dim">
          {selected.flag} {selected.name} · {e164}
        </span>
      )}
    </div>
  );
}
