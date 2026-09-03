/**
 * R2D — multilingual semantic preservation, on a frozen corpus.
 *
 * The danger in a translated operational answer is not that it reads awkwardly. It is that it
 * says the opposite: an amount changed, a date shifted, a "not approved" became "approved", or a
 * requirement to get authorisation quietly disappeared. Someone acts on that.
 *
 * So these are semantic assertions, not fluency ones. The corpus is FROZEN — changing an expected
 * string is a deliberate act, reviewed as such — and every case carries the same operational
 * meaning in all three languages.
 *
 * WHAT THIS DOES NOT PROVE. That the Sinhala and Tamil read naturally to a native speaker. No
 * amount of deterministic testing establishes that, and it is recorded as a staging gate rather
 * than implied here.
 */
import { describe, expect, it } from "vitest";
import { LANGUAGES, type Language } from "@/kernel/ask-ai/contract";
import { redirectionMessage, privacyNoticeMessage } from "@/kernel/ask-ai/sensitive";

/**
 * A frozen operational phrase in all three languages.
 *
 * `mustContain` are the tokens that carry the meaning and MUST survive translation verbatim —
 * identifiers, amounts, currencies, dates. `mustNotContain` are the words that would invert it.
 */
interface Phrase {
  id: string;
  en: string;
  si: string;
  ta: string;
  mustContain: readonly string[];
  /** Per-language forbidden substrings — the inversion that would be dangerous. */
  mustNotContain?: Partial<Record<Language, readonly string[]>>;
}

export const CORPUS: readonly Phrase[] = [
  {
    id: "overdue",
    en: "Task TSK-4821 is overdue. It was due on 2026-01-15.",
    si: "කාර්යය TSK-4821 කල් ඉකුත් වී ඇත. එය 2026-01-15 දින නියමිතව තිබුණි.",
    ta: "பணி TSK-4821 காலாவதியாகிவிட்டது. இது 2026-01-15 அன்று நிறைவேற வேண்டியிருந்தது.",
    mustContain: ["TSK-4821", "2026-01-15"],
  },
  {
    id: "not_overdue",
    en: "Task TSK-4822 is not overdue. It is due on 2026-03-01.",
    si: "කාර්යය TSK-4822 කල් ඉකුත් වී නොමැත. එය 2026-03-01 දින නියමිතය.",
    ta: "பணி TSK-4822 காலாவதியாகவில்லை. இது 2026-03-01 அன்று நிறைவேற வேண்டும்.",
    mustContain: ["TSK-4822", "2026-03-01"],
    // The negation must survive. "නොමැත" / "இல்லை" carry the "not".
    mustNotContain: { si: ["කල් ඉකුත් වී ඇත."], ta: ["காலாவதியாகிவிட்டது."] },
  },
  {
    id: "amount",
    en: "The outstanding balance is LKR 1,250,000.50 on invoice INV-2026-0043.",
    si: "INV-2026-0043 ඉන්වොයිසය මත හිඟ ශේෂය LKR 1,250,000.50 කි.",
    ta: "INV-2026-0043 விலைப்பட்டியலில் நிலுவைத் தொகை LKR 1,250,000.50 ஆகும்.",
    mustContain: ["LKR", "1,250,000.50", "INV-2026-0043"],
  },
  {
    id: "not_approved",
    en: "This purchase has NOT been approved. Approval is required before you proceed.",
    si: "මෙම මිලදී ගැනීම අනුමත කර නොමැත. ඉදිරියට යාමට පෙර අනුමැතිය අවශ්‍ය වේ.",
    ta: "இந்தக் கொள்முதல் அங்கீகரிக்கப்படவில்லை. நீங்கள் தொடர்வதற்கு முன் ஒப்புதல் தேவை.",
    mustContain: [],
    mustNotContain: {
      en: ["has been approved."],
      si: ["අනුමත කර ඇත."],
      ta: ["அங்கீகரிக்கப்பட்டுள்ளது."],
    },
  },
  {
    id: "may_not_act",
    en: "You may not approve this yourself. It must go to a manager with the authority.",
    si: "ඔබට මෙය ඔබ විසින්ම අනුමත කළ නොහැක. එය බලය ඇති කළමනාකරුවෙකු වෙත යා යුතුය.",
    ta: "இதை நீங்களே அங்கீகரிக்க முடியாது. இது அதிகாரம் உள்ள மேலாளரிடம் செல்ல வேண்டும்.",
    mustContain: [],
    mustNotContain: { si: ["අනුමත කළ හැක."], ta: ["அங்கீகரிக்க முடியும்."] },
  },
  {
    id: "uncertain",
    en: "I am not certain. The evidence for this is incomplete.",
    si: "මට විශ්වාස නැත. මේ සඳහා සාක්ෂි අසම්පූර්ණයි.",
    ta: "எனக்கு உறுதியாகத் தெரியவில்லை. இதற்கான ஆதாரம் முழுமையற்றது.",
    mustContain: [],
    mustNotContain: { si: ["මට විශ්වාසයි."], ta: ["எனக்கு உறுதியாகத் தெரியும்."] },
  },
  {
    id: "missing_evidence",
    en: "I have no authorised evidence for this, so I am not going to guess.",
    si: "මට මේ සඳහා අවසර ලත් සාක්ෂි නොමැත, එබැවින් මම අනුමාන කරන්නේ නැත.",
    ta: "இதற்கு எனக்கு அங்கீகரிக்கப்பட்ட ஆதாரம் இல்லை, எனவே நான் ஊகிக்கப் போவதில்லை.",
    mustContain: [],
  },
  {
    id: "escalate",
    en: "This needs a person. Please raise it through your HR or management channel.",
    si: "මෙයට පුද්ගලයෙකු අවශ්‍යයි. කරුණාකර එය මානව සම්පත් හෝ කළමනාකරණ නාලිකාව හරහා ඉදිරිපත් කරන්න.",
    ta: "இதற்கு ஒரு நபர் தேவை. தயவுசெய்து அதை மனிதவள அல்லது நிர்வாகத் தடத்தின் மூலம் தெரிவிக்கவும்.",
    mustContain: [],
  },
  {
    id: "permission_denied",
    en: "You are not authorised to see this record, so it is not included.",
    si: "මෙම වාර්තාව බැලීමට ඔබට අවසර නැත, එබැවින් එය ඇතුළත් කර නොමැත.",
    ta: "இந்தப் பதிவைப் பார்க்க உங்களுக்கு அனுமதி இல்லை, எனவே அது சேர்க்கப்படவில்லை.",
    mustContain: [],
  },
];

const norm = (s: string) => s.normalize("NFC");

describe("the frozen multilingual corpus", () => {
  it("covers every declared language for every phrase", () => {
    expect(LANGUAGES).toEqual(["en", "si", "ta"]);
    for (const p of CORPUS) {
      for (const lang of LANGUAGES) {
        expect(p[lang], `${p.id}.${lang}`).toBeTruthy();
        expect(p[lang].trim().length, `${p.id}.${lang} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("preserves IDENTIFIERS, AMOUNTS, CURRENCY and DATES verbatim in every language", () => {
    // The failure that matters most: a translation that changes a number. An identifier or an
    // amount is not a word to be rendered — it is a value to be carried through untouched.
    for (const p of CORPUS) {
      for (const token of p.mustContain) {
        for (const lang of LANGUAGES) {
          expect(norm(p[lang]), `${p.id}.${lang} lost "${token}"`).toContain(norm(token));
        }
      }
    }
  });

  it("never inverts a NEGATION, an APPROVAL or an AUTHORITY limit", () => {
    // "not approved" becoming "approved" is the difference between someone waiting and someone
    // spending company money.
    for (const p of CORPUS) {
      for (const lang of LANGUAGES) {
        for (const forbidden of p.mustNotContain?.[lang] ?? []) {
          expect(norm(p[lang]), `${p.id}.${lang} contains the inverted form "${forbidden}"`)
            .not.toContain(norm(forbidden));
        }
      }
    }
  });

  it("keeps the negative and positive forms DISTINCT within each language", () => {
    // A translation that renders "overdue" and "not overdue" identically would pass every
    // token check above while being useless — and dangerous.
    const pairs: readonly [string, string][] = [["overdue", "not_overdue"]];
    for (const [aId, bId] of pairs) {
      const a = CORPUS.find((p) => p.id === aId)!;
      const b = CORPUS.find((p) => p.id === bId)!;
      for (const lang of LANGUAGES) {
        expect(norm(a[lang]), `${aId} and ${bId} are identical in ${lang}`).not.toBe(norm(b[lang]));
      }
    }
  });

  it("uses the right SCRIPT for each language", () => {
    // A Sinhala slot silently holding English would pass a token check and fail a reader.
    for (const p of CORPUS) {
      expect(/[඀-෿]/u.test(p.si), `${p.id}.si is not in Sinhala script`).toBe(true);
      expect(/[஀-௿]/u.test(p.ta), `${p.id}.ta is not in Tamil script`).toBe(true);
    }
  });

  it("is FROZEN — a phrase count change is a deliberate act", () => {
    // Not busywork: it means a corpus entry cannot be quietly deleted to make a failing
    // assertion pass.
    expect(CORPUS).toHaveLength(9);
    expect(CORPUS.map((p) => p.id)).toEqual([
      "overdue", "not_overdue", "amount", "not_approved", "may_not_act",
      "uncertain", "missing_evidence", "escalate", "permission_denied",
    ]);
  });
});

describe("system-produced messages are translated, not left in English", () => {
  it("redirects a sensitive topic in the reader's language", () => {
    for (const lang of LANGUAGES) {
      const msg = redirectionMessage(lang);
      expect(msg.length, lang).toBeGreaterThan(20);
      if (lang === "si") expect(/[඀-෿]/u.test(msg)).toBe(true);
      if (lang === "ta") expect(/[஀-௿]/u.test(msg)).toBe(true);
    }
  });

  it("explains a non-persisted answer WITHOUT implying a complaint was made", () => {
    // The person may simply have asked when a delivery is due. Telling them their question
    // looked like a grievance would be an accusation the system invented.
    for (const lang of LANGUAGES) {
      const msg = privacyNoticeMessage(lang);
      expect(msg.length, lang).toBeGreaterThan(20);
      expect(msg, lang).not.toMatch(/grievance|complaint|පැමිණිල්ල|புகார்/i);
    }
  });

  it("distinguishes the redirection from the privacy notice", () => {
    // They mean different things — "take this to a human" versus "answered but not filed" — and
    // must not collapse into one string.
    for (const lang of LANGUAGES) {
      expect(redirectionMessage(lang)).not.toBe(privacyNoticeMessage(lang));
    }
  });
});
