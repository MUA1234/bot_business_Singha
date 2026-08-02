/**
 * Chart-of-accounts fundamentals. Account type determines the "normal balance"
 * side, which the trial-balance and financial-statement logic rely on.
 */
export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Side on which an increase to this account type is recorded. */
export type NormalBalance = "debit" | "credit";

export function normalBalance(type: AccountType): NormalBalance {
  switch (type) {
    case "asset":
    case "expense":
      return "debit";
    case "liability":
    case "equity":
    case "income":
      return "credit";
  }
}

/** Whether this account type appears on the balance sheet (vs. P&L). */
export function isBalanceSheet(type: AccountType): boolean {
  return type === "asset" || type === "liability" || type === "equity";
}

export function isProfitAndLoss(type: AccountType): boolean {
  return type === "income" || type === "expense";
}
