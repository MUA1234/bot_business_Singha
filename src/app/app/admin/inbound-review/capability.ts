/**
 * The capability that governs the inbound review queue.
 *
 * It lives in its own module because a `"use server"` file may export only async functions, and both
 * the page and the server action need this constant.
 */
export const INBOUND_REVIEW_CAPABILITY = "operations.inbound.review";

/**
 * The ONE role the inbound-setup screen assigns.
 *
 * `admin_set_membership_role` accepts a wider list — a company also has to be able to appoint
 * managers — so the screen constrains itself rather than relying on the database's list being
 * narrow. The role key in the form is client-supplied; the server action checks it against this.
 */
export const REVIEWER_ROLE = "finance_reviewer";
