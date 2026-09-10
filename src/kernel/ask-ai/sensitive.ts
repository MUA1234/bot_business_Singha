/**
 * R2D — sensitive staff topics, classified BEFORE anything is written down.
 *
 * Ordinary operational guidance is a company work record that authorised managers may review. A
 * grievance, a health disclosure or a whistleblowing report is not, and the difference cannot be
 * repaired afterwards: once such a question is in an operational history, the disclosure has
 * already happened. So classification runs before persistence, not after it.
 *
 * The bias is deliberate and one-directional. A false positive costs someone a redirection to a
 * human they could have reached anyway; a false negative puts a protected disclosure in front of
 * their manager. Those are not symmetric, so the matching is broad and the thresholds are low.
 *
 * WHAT THIS IS NOT. It is not a protected case-management system, and this repository does not
 * contain one. Ask-AI directs the person to a human channel and records that it did so; it does
 * not open a case, notify anyone, or store what was said.
 */

export const SENSITIVE_CATEGORIES = [
  "grievance",
  "harassment",
  "health",
  "disability",
  "whistleblowing",
  "protected_hr",
  "disciplinary",
  "legal_privilege",
] as const;

export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

/**
 * What to do with a question, decided before anything is written down.
 *
 *   ordinary   — routine operational guidance; answered and kept as a company work record.
 *   sensitive  — a confident match on a protected topic; redirected to a human, no content
 *                stored, only a coded event.
 *   unverified — the classifier cannot honestly say which of the two this is, because its
 *                coverage of this language is thin. Answered operationally, but NOT written
 *                into reviewable history and NOT exposed to manager review.
 *
 * The third mode exists because the alternatives are both wrong. Treating an unclassifiable
 * question as ordinary can file a grievance where a manager will read it. Treating it as a
 * grievance tells someone asking about a delivery schedule that they appear to have raised a
 * complaint — a false accusation of the system's own making, and a reason never to use it
 * again in their own language.
 */
export type AskMode = "ordinary" | "sensitive" | "unverified";

export interface SensitiveVerdict {
  mode: AskMode;
  /** Present only for a CONFIDENT match. Never inferred from thin coverage. */
  category?: SensitiveCategory;
  /** True when the text is in a language this classifier covers only thinly. */
  lowCoverageLanguage?: boolean;
}

/**
 * English signals, by category.
 *
 * Word-boundary matched. Substring matching was tried in an earlier phase of this recovery and
 * matched "manage" inside "management" and "health" inside "healthy" — noise that trains people
 * to ignore the mechanism.
 */
const SIGNALS: Record<SensitiveCategory, readonly RegExp[]> = {
  grievance: [
    /\bgrievance\b/i, /\bcomplain(t|ing|ts)?\b.*\b(manager|supervisor|boss|hr)\b/i,
    /\braise (a|an) (issue|concern)\b.*\b(manager|hr|supervisor)\b/i,
    /\bunfair(ly)? (treated|treatment|dismissed)\b/i,
  ],
  harassment: [
    /\bharass(ed|ment|ing)?\b/i, /\bbully(ing|ied)?\b/i, /\bintimidat(ed|ion|ing)\b/i,
    /\b(sexual|racial|religious) (harassment|abuse|discrimination)\b/i,
    /\bdiscriminat(ed|ion|ing)\b/i, /\bhostile work environment\b/i,
  ],
  health: [
    /\b(my|his|her|their) (illness|diagnosis|medical|mental health|depression|anxiety)\b/i,
    /\bsick (leave|note|certificate)\b/i, /\bmedical (leave|report|condition|certificate)\b/i,
    /\b(pregnan(t|cy)|maternity|paternity)\b/i, /\bhospital(ised|ized|isation)\b/i,
    /\bmental health\b/i, /\btherapy|counsell?ing\b/i,
  ],
  disability: [
    /\bdisab(led|ility|ilities)\b/i, /\bimpairment\b/i,
    /\breasonable adjustment(s)?\b/i, /\baccommodation(s)? for my\b/i,
  ],
  whistleblowing: [
    /\bwhistle ?blow(er|ing)?\b/i, /\breport(ing)? (fraud|corruption|bribery|misconduct)\b/i,
    /\b(illegal|unlawful|criminal) (activity|conduct|behaviour|behavior)\b/i,
    /\bcover(ing)? up\b/i, /\bembezzl(e|ing|ement)\b/i,
  ],
  protected_hr: [
    /\bmy (salary|wage|pay|contract|termination|resignation)\b/i,
    /\b(personal|confidential) (file|record|information) about (me|my)\b/i,
    /\bsomeone else'?s (salary|pay|contract|performance|medical)\b/i,
    /\banother (employee|staff member)'?s (personal|private|medical|salary)\b/i,
  ],
  disciplinary: [
    /\bdisciplinary\b/i, /\bwritten warning\b/i, /\bmisconduct hearing\b/i,
    /\bsuspend(ed|ion) from (work|duty)\b/i, /\bdismissal\b/i,
  ],
  legal_privilege: [
    /\blegal (advice|privilege|counsel)\b/i, /\bmy (lawyer|attorney|solicitor)\b/i,
    /\b(sue|suing|litigation|tribunal|court case)\b/i, /\bprivileged (communication|document)\b/i,
  ],
};

/**
 * Sinhala and Tamil signals — DELIBERATELY THIN, and treated as such.
 *
 * These few terms are the ones that can be asserted without native-speaker review. That is not
 * adequate coverage, and pretending otherwise would create the worst version of this feature: a
 * grievance written in Sinhala being filed into an operational history a manager can read, while
 * the same words in English are protected. The gap is handled by `lowCoverageLanguage`, which
 * makes the classifier conservative for these languages rather than confident.
 *
 * Native-speaker review of this list is a required staging gate, recorded in the R2D report.
 */
const SI_TA_SIGNALS: readonly { re: RegExp; category: SensitiveCategory }[] = [
  { re: /පැමිණිල්ල/u, category: "grievance" },      // complaint (si)
  { re: /හිරිහැර/u, category: "harassment" },       // harassment (si)
  { re: /රෝගී|අසනීප/u, category: "health" },        // ill / sick (si)
  { re: /වෛද්‍ය/u, category: "health" },             // medical (si)
  { re: /புகார்/u, category: "grievance" },          // complaint (ta)
  { re: /துன்புறுத்தல்/u, category: "harassment" },  // harassment (ta)
  { re: /உடல்நலம்|நோய்/u, category: "health" },     // health / illness (ta)
  { re: /மருத்துவ/u, category: "health" },           // medical (ta)
];

/** Does the text contain Sinhala or Tamil script? */
export function hasSinhalaOrTamil(text: string): boolean {
  return /[඀-෿஀-௿]/u.test(text);
}

/**
 * Classify a question before it is stored.
 *
 * A single signal is enough. Requiring corroboration would mean a clearly-worded disclosure that
 * happens to use one phrase is treated as routine.
 */
export function classifySensitive(question: string): SensitiveVerdict {
  const lowCoverage = hasSinhalaOrTamil(question);

  // A confident match, in either script. Each Sinhala and Tamil term carries its OWN meaning
  // — "complaint" is a grievance, "medical" is health — so they map individually. Collapsing
  // them into one category would tell someone asking about a doctor's note that they appear
  // to have raised an HR matter.
  for (const category of SENSITIVE_CATEGORIES) {
    for (const pattern of SIGNALS[category]) {
      if (pattern.test(question)) {
        return { mode: "sensitive", category, lowCoverageLanguage: lowCoverage };
      }
    }
  }
  for (const { re, category } of SI_TA_SIGNALS) {
    if (re.test(question)) {
      return { mode: "sensitive", category, lowCoverageLanguage: true };
    }
  }

  // No match — but in Sinhala or Tamil that means "nothing in a thin list matched", which is
  // not the same as "this is routine". The question is answered, and simply not filed where
  // it could be read by someone else.
  //
  // This is a real asymmetry: a Sinhala or Tamil speaker gets no thread history and no
  // manager review until native-speaker review closes the gap. That cost is visible and
  // temporary; a protected disclosure sitting in a reviewable history is neither.
  if (lowCoverage) return { mode: "unverified", lowCoverageLanguage: true };

  return { mode: "ordinary", lowCoverageLanguage: false };
}

/**
 * Where a redirected person is sent.
 *
 * A label, not a workflow. This repository has no protected case-management system, and inventing
 * one — a case id, a queue, a promise that "HR has been notified" — would be worse than saying
 * plainly that this needs a human, because someone might rely on it.
 */
export const PROTECTED_CHANNEL = "human_hr_or_management_channel";

/**
 * Shown when a question is answered but not kept.
 *
 * It says what happened and why, and it does NOT say or imply that the person raised a
 * complaint — because they may simply have asked when a delivery is due.
 */
export function privacyNoticeMessage(language: "en" | "si" | "ta"): string {
  switch (language) {
    case "si":
      return "සටහන: සිංහල භාෂාවෙන් ඇසූ ප්‍රශ්න මේ වන විට මෙහෙයුම් ඉතිහාසයේ සුරකින්නේ නැත, කළමනාකරුවන්ට පෙනෙන්නේද නැත. ඔබට ඉංග්‍රීසියෙන් ඇසිය හැකිය, නැතහොත් පුද්ගලික කරුණක් සඳහා මිනිස් සම්පත් අංශය අමතන්න.";
    case "ta":
      return "குறிப்பு: தமிழில் கேட்கப்படும் கேள்விகள் தற்போது செயல்பாட்டு வரலாற்றில் சேமிக்கப்படுவதில்லை, மேலாளர்களுக்கும் தெரிவதில்லை. நீங்கள் ஆங்கிலத்தில் கேட்கலாம், அல்லது தனிப்பட்ட விஷயத்திற்கு மனிதவளத் துறையை அணுகவும்.";
    default:
      return (
        "Note: questions asked in Sinhala or Tamil are not yet saved to your guidance " +
        "history and are not visible to managers, because this system cannot yet check them " +
        "for private matters as reliably as it can in English. You may ask in English if you " +
        "would like the answer kept, or contact HR directly for anything personal."
      );
  }
}

export function redirectionMessage(language: "en" | "si" | "ta"): string {
  switch (language) {
    case "si":
      return "මෙය මිනිස් සම්පත් හෝ කළමනාකරණ නාලිකාව හරහා කෙලින්ම කථා කළ යුතු කරුණකි. එය මෙම මෙහෙයුම් සහායක ඉතිහාසයේ සුරකින්නේ නැත.";
    case "ta":
      return "இது மனிதவள அல்லது நிர்வாகத் தடத்தின் மூலம் நேரடியாகப் பேச வேண்டிய விஷயம். இது இந்த செயல்பாட்டு வழிகாட்டி வரலாற்றில் சேமிக்கப்படவில்லை.";
    default:
      return (
        "This needs a person, not operational guidance. Please raise it directly through your " +
        "HR or management channel. Your question has not been saved to this guidance history."
      );
  }
}
