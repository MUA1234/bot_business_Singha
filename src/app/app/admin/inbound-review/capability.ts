/**
 * The capability that governs the inbound review queue.
 *
 * It lives in its own module because a `"use server"` file may export only async functions, and both
 * the page and the server action need this constant.
 */
export const INBOUND_REVIEW_CAPABILITY = "operations.inbound.review";
