/**
 * PA-271: billing data (wallet balance, transactions, payments, subscriptions)
 * must only be sent to users who hold the `billing.view` permission.
 *
 * The /api/account/verify response is the single source the dashboard reads
 * from — sidebar balance, the Spent/GPU-Hours/Projected cards, the Monthly
 * Subscriptions card, the Transactions modal, and the Billing tab all render
 * from these fields. Redacting them HERE (server-side, at the source) is the
 * real access boundary; client render-gates are only defense-in-depth/UX.
 *
 * Read-only Members and Team Members (no billing.view) therefore receive an
 * empty billing payload even when switched into the team owner's workspace.
 */

export interface BillingPayload {
  wallet: unknown | null;
  transactions: unknown[];
  subscription: unknown | null;
  subscriptions: unknown[];
  recentPayments: unknown[];
}

/**
 * Returns the payload unchanged for billing-permitted users; otherwise returns a
 * copy with all billing fields emptied. Non-billing fields on the object pass
 * through untouched.
 */
export function redactBillingPayload<T extends BillingPayload>(
  canViewBilling: boolean,
  payload: T,
): T {
  if (canViewBilling) return payload;
  return {
    ...payload,
    wallet: null,
    transactions: [],
    subscription: null,
    subscriptions: [],
    recentPayments: [],
  };
}
