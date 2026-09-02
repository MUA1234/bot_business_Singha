/**
 * Protected-attribute guard for people intelligence (R2B).
 *
 * The owner's rule: *"Do not use protected or sensitive personal attributes. Do not infer
 * health, ethnicity, religion, political opinion, family status or other protected
 * characteristics."*
 *
 * This is enforced with a **POSITIVE ALLOWLIST**, not a denylist of forbidden words.
 *
 * The R1 observation guard used a forbidden-key list, and that is the right shape there because
 * an observation's facts are open-ended business data. Here the opposite is true: the set of
 * things that may legitimately influence who is suitable for a task is SMALL, CLOSED and
 * knowable in advance. A denylist would have to anticipate every proxy — `postcode`, `age_band`,
 * `photo_url`, `pregnancy_status`, `visa_type`, `union_member` — and would be defeated by the
 * next word nobody thought of. An allowlist fails the other way: an attribute nobody has
 * approved is refused by default, and adding one is a reviewable code change.
 *
 * The guard runs when candidate evidence is CONSTRUCTED, not when it is read, so an attribute
 * that should never have been loaded cannot sit in memory waiting to be used by mistake.
 */

/**
 * Every signal that may lawfully influence suitability for a piece of work. Each is either a
 * system-of-record fact about the role, or a record of what the person has actually done.
 *
 * Adding a key here is a deliberate act. Do not add one to make a test pass.
 */
export const PERMITTED_SIGNAL_KEYS: ReadonlySet<string> = new Set([
  // Identity and scope — who they are TO THE COMPANY, never who they are as a person.
  "membershipId", "companyId", "candidateType", "active", "departmentIds", "organisationUnitIds",
  // Role, authority and permission.
  "roles", "capabilities", "authorityLevel", "authorityCeiling",
  // What the work needs and what they can offer it.
  "declaredSkills", "verifiedSkills", "languages",
  // Whether they can take it on right now.
  "available", "onLeave", "availableHours", "capacityStatus", "openAssignments",
  // Delegation.
  "delegatedFrom", "delegationScope", "delegationStartsAt", "delegationEndsAt",
  // External consultant.
  "providerId", "providerStatus", "complianceStatus", "insuranceStatus", "insuranceExpiry",
  "engagementScope",
  // What has actually happened, for learning.
  "outcomeCount", "verifiedOutcomeCount", "onTimeCount", "distinctDeciderCount", "lastOutcomeAt",
]);

/**
 * Attributes that are protected or are well-known proxies for one. This list does NOT do the
 * enforcing — the allowlist above does — but it is checked FIRST so that a violation produces a
 * message naming the actual problem ("religion is a protected attribute") instead of the generic
 * "not a permitted signal", which matters when a person is reading the failure.
 */
const NAMED_PROTECTED: ReadonlySet<string> = new Set([
  "ethnicity", "race", "nationality", "religion", "belief", "caste", "politicalopinion",
  "political", "unionmember", "unionmembership",
  "health", "disability", "medicalcondition", "pregnancy", "pregnancystatus", "sickleavecount",
  "sicknessrecord", "mentalhealth",
  "gender", "sex", "sexualorientation", "genderidentity",
  "maritalstatus", "familystatus", "children", "dependants", "dependents", "caringresponsibilities",
  "age", "ageband", "dateofbirth", "dob", "birthdate",
  "address", "homeaddress", "postcode", "postalcode", "residence",
  "photo", "photourl", "avatar", "image", "faceembedding", "biometric",
  "visastatus", "visatype", "immigrationstatus", "criminalrecord",
  "salary", "pay", "payrate", "wage", "remuneration",
]);

const normalise = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

export class ProtectedAttributeError extends Error {
  constructor(public readonly key: string, message: string) {
    super(message);
    this.name = "ProtectedAttributeError";
  }
}

/**
 * Refuse any key that is not an approved signal.
 *
 * Called on the top-level keys of every candidate evidence record. Throws rather than filtering:
 * silently dropping a protected attribute would let a caller believe it had been considered, and
 * would hide a loader that is reading data it should never have queried.
 */
export function assertNoProtectedAttributes(record: Record<string, unknown>, context: string): void {
  for (const key of Object.keys(record)) {
    if (PERMITTED_SIGNAL_KEYS.has(key)) continue;

    const n = normalise(key);
    if (NAMED_PROTECTED.has(n)) {
      throw new ProtectedAttributeError(
        key,
        `${context}: "${key}" is a protected or sensitive personal attribute and may never influence suitability`,
      );
    }
    throw new ProtectedAttributeError(
      key,
      `${context}: "${key}" is not a permitted suitability signal. ` +
        `Suitability may only use approved role, capability, availability and outcome evidence ` +
        `(src/kernel/people/protected.ts). Adding a signal is a deliberate, reviewable change.`,
    );
  }
}

/**
 * Is this key a protected attribute? Exposed so the UI and the adversarial tests can assert the
 * classification directly without constructing a whole evidence record.
 */
export function isProtectedAttribute(key: string): boolean {
  return NAMED_PROTECTED.has(normalise(key));
}
