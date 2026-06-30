import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

// Mock prisma + stripe so we can assert exactly what cacheCustomer upserts.
const upsert = vi.fn(() => Promise.resolve({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { customerCache: { upsert: (...a: unknown[]) => upsert(...a) } },
}));

let stripeValue: unknown = null;
vi.mock("@/lib/stripe", () => ({
  getStripeOrNull: vi.fn(() => Promise.resolve(stripeValue)),
}));

import { cacheCustomer } from "@/lib/customer-cache";

function synthetic(overrides: Partial<Stripe.Customer> = {}): Stripe.Customer {
  return {
    id: "oss_abc",
    email: "u@example.com",
    name: "U",
    balance: 0, // OSS synthetic customers never carry the real balance
    created: 1700000000,
    metadata: { hostedai_team_id: "team-1" },
    ...overrides,
  } as Stripe.Customer;
}

describe("cacheCustomer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeValue = null;
  });

  describe("OSS mode (no Stripe)", () => {
    // Regression: a dashboard request calls cacheCustomer with the synthetic
    // customer (balance:0); the old code wrote balanceCents:0 on update,
    // wiping an admin-set wallet balance on the next login/page load.
    it("does NOT overwrite balanceCents/billingType/teamId on update", async () => {
      stripeValue = null;
      await cacheCustomer(synthetic());

      const arg = upsert.mock.calls[0][0] as { update: Record<string, unknown> };
      expect(arg.update).not.toHaveProperty("balanceCents");
      expect(arg.update).not.toHaveProperty("billingType");
      expect(arg.update).not.toHaveProperty("teamId");
      // identity is still refreshed
      expect(arg.update.email).toBe("u@example.com");
      expect(arg.update.name).toBe("U");
    });

    it("still seeds billing fields on create (new customer)", async () => {
      stripeValue = null;
      await cacheCustomer(synthetic());
      const arg = upsert.mock.calls[0][0] as { create: Record<string, unknown> };
      expect(arg.create).toHaveProperty("balanceCents", 0);
      expect(arg.create).toHaveProperty("teamId", "team-1");
    });
  });

  describe("Pro mode (Stripe configured)", () => {
    it("DOES update balanceCents from the Stripe customer", async () => {
      stripeValue = {}; // any truthy Stripe client
      await cacheCustomer(synthetic({ id: "cus_x", balance: -12345 }));
      const arg = upsert.mock.calls[0][0] as { update: Record<string, unknown> };
      expect(arg.update).toHaveProperty("balanceCents", -12345);
    });
  });
});
