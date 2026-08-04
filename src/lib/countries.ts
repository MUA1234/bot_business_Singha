/**
 * Country dial codes for the phone input. The system auto-selects the caller's
 * country (see PhoneInput) so staff rarely touch this; the dropdown is the manual
 * override. Sorted so the home market (Sri Lanka) and neighbours are easy to find.
 */
export interface Country {
  iso2: string;
  name: string;
  dial: string; // without '+'
  flag: string;
}

// Broad, practical list (home market + major markets). Extend freely.
export const COUNTRIES: Country[] = [
  { iso2: "LK", name: "Sri Lanka", dial: "94", flag: "🇱🇰" },
  { iso2: "IN", name: "India", dial: "91", flag: "🇮🇳" },
  { iso2: "AE", name: "United Arab Emirates", dial: "971", flag: "🇦🇪" },
  { iso2: "SA", name: "Saudi Arabia", dial: "966", flag: "🇸🇦" },
  { iso2: "QA", name: "Qatar", dial: "974", flag: "🇶🇦" },
  { iso2: "KW", name: "Kuwait", dial: "965", flag: "🇰🇼" },
  { iso2: "SG", name: "Singapore", dial: "65", flag: "🇸🇬" },
  { iso2: "MY", name: "Malaysia", dial: "60", flag: "🇲🇾" },
  { iso2: "MV", name: "Maldives", dial: "960", flag: "🇲🇻" },
  { iso2: "PK", name: "Pakistan", dial: "92", flag: "🇵🇰" },
  { iso2: "BD", name: "Bangladesh", dial: "880", flag: "🇧🇩" },
  { iso2: "GB", name: "United Kingdom", dial: "44", flag: "🇬🇧" },
  { iso2: "US", name: "United States", dial: "1", flag: "🇺🇸" },
  { iso2: "CA", name: "Canada", dial: "1", flag: "🇨🇦" },
  { iso2: "AU", name: "Australia", dial: "61", flag: "🇦🇺" },
  { iso2: "NZ", name: "New Zealand", dial: "64", flag: "🇳🇿" },
  { iso2: "DE", name: "Germany", dial: "49", flag: "🇩🇪" },
  { iso2: "FR", name: "France", dial: "33", flag: "🇫🇷" },
  { iso2: "IT", name: "Italy", dial: "39", flag: "🇮🇹" },
  { iso2: "ES", name: "Spain", dial: "34", flag: "🇪🇸" },
  { iso2: "NL", name: "Netherlands", dial: "31", flag: "🇳🇱" },
  { iso2: "CH", name: "Switzerland", dial: "41", flag: "🇨🇭" },
  { iso2: "SE", name: "Sweden", dial: "46", flag: "🇸🇪" },
  { iso2: "NO", name: "Norway", dial: "47", flag: "🇳🇴" },
  { iso2: "IE", name: "Ireland", dial: "353", flag: "🇮🇪" },
  { iso2: "CN", name: "China", dial: "86", flag: "🇨🇳" },
  { iso2: "JP", name: "Japan", dial: "81", flag: "🇯🇵" },
  { iso2: "KR", name: "South Korea", dial: "82", flag: "🇰🇷" },
  { iso2: "HK", name: "Hong Kong", dial: "852", flag: "🇭🇰" },
  { iso2: "TH", name: "Thailand", dial: "66", flag: "🇹🇭" },
  { iso2: "ID", name: "Indonesia", dial: "62", flag: "🇮🇩" },
  { iso2: "PH", name: "Philippines", dial: "63", flag: "🇵🇭" },
  { iso2: "VN", name: "Vietnam", dial: "84", flag: "🇻🇳" },
  { iso2: "TR", name: "Turkey", dial: "90", flag: "🇹🇷" },
  { iso2: "ZA", name: "South Africa", dial: "27", flag: "🇿🇦" },
  { iso2: "NG", name: "Nigeria", dial: "234", flag: "🇳🇬" },
  { iso2: "KE", name: "Kenya", dial: "254", flag: "🇰🇪" },
  { iso2: "EG", name: "Egypt", dial: "20", flag: "🇪🇬" },
  { iso2: "BR", name: "Brazil", dial: "55", flag: "🇧🇷" },
  { iso2: "MX", name: "Mexico", dial: "52", flag: "🇲🇽" },
  { iso2: "OM", name: "Oman", dial: "968", flag: "🇴🇲" },
  { iso2: "BH", name: "Bahrain", dial: "973", flag: "🇧🇭" },
  { iso2: "NP", name: "Nepal", dial: "977", flag: "🇳🇵" },
];

const BY_ISO2 = new Map(COUNTRIES.map((c) => [c.iso2, c]));

export function countryByIso2(iso2: string | null | undefined): Country | undefined {
  return iso2 ? BY_ISO2.get(iso2.toUpperCase()) : undefined;
}

export const DEFAULT_ISO2 = "LK";

/**
 * Best-effort country guess from the browser, no network call:
 *   1. `navigator.language` region subtag (e.g. en-LK → LK)
 *   2. any `navigator.languages` entry with a region
 *   3. fall back to the home market.
 */
export function guessCountryIso2(): string {
  if (typeof navigator === "undefined") return DEFAULT_ISO2;
  const langs = [navigator.language, ...(navigator.languages ?? [])];
  for (const l of langs) {
    const region = l?.split("-")[1];
    if (region && BY_ISO2.has(region.toUpperCase())) return region.toUpperCase();
  }
  return DEFAULT_ISO2;
}

/** Normalise a country + local number into E.164-ish `+<dial><number>`. */
export function toE164(iso2: string, localNumber: string): string {
  const c = countryByIso2(iso2) ?? countryByIso2(DEFAULT_ISO2)!;
  const digits = localNumber.replace(/\D/g, "").replace(/^0+/, "");
  return `+${c.dial}${digits}`;
}
