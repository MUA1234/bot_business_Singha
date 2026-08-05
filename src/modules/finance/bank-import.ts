/**
 * Bank statement import parser (Architecture V2 change plan §8.3). Pure: parses
 * pasted "date, amount, description" lines into rows, with per-line errors. Amounts
 * stay as strings for decimal safety (Constitution §8); the caller persists them.
 */
export interface ParsedBankRow {
  date: string; // ISO date
  amount: string; // decimal string, sign = in/out
  description: string;
}

export interface ParseResult {
  rows: ParsedBankRow[];
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE = /^-?\d+(\.\d+)?$/;

/** Parse lines of `YYYY-MM-DD, amount, description`. Extra commas go to description. */
export function parseBankLines(text: string): ParseResult {
  const rows: ParsedBankRow[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");

  lines.forEach((line, i) => {
    const firstComma = line.indexOf(",");
    const secondComma = firstComma >= 0 ? line.indexOf(",", firstComma + 1) : -1;
    if (firstComma < 0 || secondComma < 0) {
      errors.push(`Line ${i + 1}: expected "date, amount, description"`);
      return;
    }
    const date = line.slice(0, firstComma).trim();
    const amount = line.slice(firstComma + 1, secondComma).trim();
    const description = line.slice(secondComma + 1).trim();
    if (!DATE_RE.test(date)) { errors.push(`Line ${i + 1}: bad date "${date}" (use YYYY-MM-DD)`); return; }
    if (!AMOUNT_RE.test(amount)) { errors.push(`Line ${i + 1}: bad amount "${amount}"`); return; }
    rows.push({ date, amount, description });
  });

  return { rows, errors };
}
