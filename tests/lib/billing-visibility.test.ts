/**
 * PA-271 — verify response must not leak billing data to users without
 * billing.view. redactBillingPayload() is the server-side boundary.
 */
import { describe, it, expect } from "vitest";
import { redactBillingPayload } from "@/lib/billing-visibility";

const FULL = {
  wallet: { balance: -5000, balanceFormatted: "$50.00", currency: "usd" },
  transactions: [{ id: "txn_1", amount: 5000 }],
  subscription: { id: "sub_1" },
  subscriptions: [{ id: "sub_1" }, { id: "sub_2" }],
  recentPayments: [{ id: "pi_1" }],
  // a non-billing field that must always survive:
  role: "member" as const,
  can: { "billing.view": false },
};

describe("redactBillingPayload — PA-271", () => {
  it("returns the full payload unchanged when the user can view billing", () => {
    const out = redactBillingPayload(true, FULL);
    expect(out).toBe(FULL); // same reference — no copy when permitted
    expect(out.transactions).toHaveLength(1);
    expect(out.wallet).not.toBeNull();
  });

  it("empties every billing field when the user cannot view billing", () => {
    const out = redactBillingPayload(false, FULL);
    expect(out.wallet).toBeNull();
    expect(out.transactions).toEqual([]);
    expect(out.subscription).toBeNull();
    expect(out.subscriptions).toEqual([]);
    expect(out.recentPayments).toEqual([]);
  });

  it("preserves non-billing fields when redacting", () => {
    const out = redactBillingPayload(false, FULL);
    expect(out.role).toBe("member");
    expect(out.can).toEqual({ "billing.view": false });
  });

  it("does not mutate the input payload", () => {
    redactBillingPayload(false, FULL);
    expect(FULL.wallet).not.toBeNull();
    expect(FULL.transactions).toHaveLength(1);
    expect(FULL.subscriptions).toHaveLength(2);
  });
});
