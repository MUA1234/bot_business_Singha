/**
 * The capability that governs the duplicate-review queue (OF-016, migration 0087).
 *
 * It lives in its own module because a `"use server"` file may export only async functions, and
 * both the page and the server action need this constant.
 */
export const DUPLICATE_REVIEW_CAPABILITY = "finance.duplicate.resolve";

/** The two decisions a reviewer may record. Mirrors the database's own CHECK constraint. */
export const RESOLUTIONS = ["confirmed_duplicate", "dismissed_distinct"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
