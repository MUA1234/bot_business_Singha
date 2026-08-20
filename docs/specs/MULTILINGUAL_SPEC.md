# Multilingual — English, Sinhala and Tamil

> **IMPLEMENTATION STATUS: NOT STARTED.** There is no i18n layer, no locale storage, no translation
> catalogue and no language-aware routing anywhere in the repository. The branch reconciliation
> (`docs/verification/BRANCH_RECONCILIATION.md`) confirmed this has never existed on any branch or
> in any pull request. Today the words "Sinhala" and "Tamil" appear only inside a feature-flag
> *description string* and one sentence of a program vision document. This specification exists so
> the program cannot go missing again; nothing here may be reported as available or partial.

## 1. Languages

English (`en`), Sinhala (`si`), Tamil (`ta`). English is the fallback for every key and every
decision path.

## 2. Language preference and persistence

- A per-user preference stored on the profile, company-scoped, changeable by the user.
- Persisted across sessions and devices; never inferred silently from message content and never
  reset by a deployment.
- An explicit choice always beats detection. Detection may propose, never override.

## 3. UI translation

- Translation **keys**, not inline strings. No user-visible English literal in a component.
- A missing key falls back to English and is reported (a missing translation must be visible to the
  team, not silently rendered as a key name to a user).
- Interpolation is structured — never string concatenation, which breaks in languages with
  different word order.
- Dates, numbers and currency formatted per locale, while the **stored** value stays canonical and
  exact. Display language must never change a stored amount, a currency code or a rounding result.

## 4. Canonical business data is language-independent

This is the load-bearing rule. Status values, authority levels, capability names, account codes,
task states and audit actions are **canonical identifiers**, stored once and translated only at the
point of display. A record created in Sinhala and a record created in English must be the same
record, comparable, deduplicable and auditable.

## 5. Multilingual inbound handling

- Intent classification must produce the same intent, the same authority requirement and the same
  risk classification for materially equivalent messages in any of the three languages.
- Mixed-language messages, transliteration (Sinhala or Tamil written in Latin script), informal
  spelling and common misspellings must be handled.
- **Language never changes authority.** A payment request in Tamil requires exactly the authority a
  payment request in English requires — resolved by the deterministic engine, which sees a
  classified action and an amount, not prose.
- Ambiguity in any language escalates to a human; it is never resolved by guessing.

## 6. Legal, financial and authority-critical wording

- Approved, human-reviewed translations only, versioned and recorded.
- **No uncontrolled model translation** of binding, legal, financial or authority-critical text —
  quotations, invoices, contract terms, privacy and terms pages, approval prompts and anything that
  states an obligation.
- Where an approved translation does not exist, show English and say so, rather than machine-
  translating a commitment.

## 7. Mobile, PWA and accessibility

- Full support at mobile viewports; the PWA shell carries the locale.
- Fonts covering Sinhala and Tamil, bundled or self-hosted (the Content-Security-Policy forbids
  external font hosts), with correct line height and glyph rendering for each script.
- Accessible labels, `lang` attributes on rendered content, and screen-reader-correct language
  switching.

## 8. Testing

- Metamorphic tests: materially equivalent messages across the three languages must yield the same
  intent, authority and risk. Identical prose is **not** required and must not be asserted.
- Every UI key resolves in all three languages, or falls back to English visibly.
- No untranslated user-visible literal in a component (enforced by a lint or an architectural test).
- Formatting tests: locale display never alters the stored canonical value.
- Legal and financial surfaces render only approved translations.

## 9. Flags and rollout

Behind a **default-OFF** flag. English-only remains the shipped behaviour until translations for a
language are complete and reviewed; a half-translated language must not be selectable.

## 10. Explicitly out of scope

Customer-facing conversational AI in additional languages is **gated** by CLAUDE.md and is not part
of this program. This specification covers the staff application and deterministic inbound intent
handling only.
