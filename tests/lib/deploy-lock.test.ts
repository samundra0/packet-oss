import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";
import {
  isDeployLocked,
  acquireDeployLock,
  releaseDeployLock,
} from "@/lib/deploy-lock";

// Mock prisma + customer-cache so the OSS branch is exercised without a DB.
const customerCacheUpdate = vi.fn(() => Promise.resolve({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    customerCache: {
      update: (...args: unknown[]) => customerCacheUpdate(...args),
    },
  },
}));
vi.mock("@/lib/customer-cache", () => ({
  cacheCustomer: vi.fn(() => Promise.resolve()),
}));

function makeCustomer(metadata: Record<string, string> = {}): Stripe.Customer {
  return { id: "oss_abc123", email: "u@example.com", metadata } as Stripe.Customer;
}

describe("deploy-lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isDeployLocked", () => {
    it("is false when no lock present", () => {
      expect(isDeployLocked(makeCustomer())).toBe(false);
    });

    it("is true for a fresh lock", () => {
      const now = Math.floor(Date.now() / 1000).toString();
      expect(isDeployLocked(makeCustomer({ deploy_lock: now }))).toBe(true);
    });

    it("is false for an expired lock (>60s old)", () => {
      const old = (Math.floor(Date.now() / 1000) - 120).toString();
      expect(isDeployLocked(makeCustomer({ deploy_lock: old }))).toBe(false);
    });

    it("is false for a non-numeric lock value", () => {
      expect(isDeployLocked(makeCustomer({ deploy_lock: "nope" }))).toBe(false);
    });
  });

  describe("OSS mode (stripe = null)", () => {
    // Regression: the deploy path used to call stripe.customers.update
    // unconditionally, which threw in OSS (no Stripe). The lock must persist
    // to customer_cache instead and never touch Stripe.
    it("acquire persists to customer_cache.metadataJson and does not throw", async () => {
      const customer = makeCustomer({ hostedai_team_id: "team-1" });
      await acquireDeployLock(customer, null);

      expect(customerCacheUpdate).toHaveBeenCalledTimes(1);
      const arg = customerCacheUpdate.mock.calls[0][0] as {
        where: { id: string };
        data: { metadataJson: string };
      };
      expect(arg.where.id).toBe("oss_abc123");
      const persisted = JSON.parse(arg.data.metadataJson);
      expect(persisted.deploy_lock).toBeDefined();
      expect(persisted.hostedai_team_id).toBe("team-1"); // existing metadata preserved
      // in-memory copy updated so the same request sees the lock
      expect(isDeployLocked(customer)).toBe(true);
    });

    it("release removes the lock key and persists", async () => {
      const now = Math.floor(Date.now() / 1000).toString();
      const customer = makeCustomer({ deploy_lock: now, hostedai_team_id: "team-1" });
      await releaseDeployLock(customer, null);

      expect(customerCacheUpdate).toHaveBeenCalledTimes(1);
      const arg = customerCacheUpdate.mock.calls[0][0] as {
        data: { metadataJson: string };
      };
      const persisted = JSON.parse(arg.data.metadataJson);
      expect(persisted.deploy_lock).toBeUndefined();
      expect(persisted.hostedai_team_id).toBe("team-1");
      expect(isDeployLocked(customer)).toBe(false);
    });

    it("acquire swallows persistence errors (never blocks deploy)", async () => {
      customerCacheUpdate.mockRejectedValueOnce(new Error("db down"));
      await expect(acquireDeployLock(makeCustomer(), null)).resolves.toBeUndefined();
    });
  });

  describe("Pro mode (stripe present)", () => {
    it("acquire writes to Stripe customer metadata, not customer_cache", async () => {
      const update = vi.fn(() => Promise.resolve({}));
      const stripe = { customers: { update } } as unknown as Stripe;
      const customer = makeCustomer();

      await acquireDeployLock(customer, stripe);

      expect(update).toHaveBeenCalledTimes(1);
      expect(customerCacheUpdate).not.toHaveBeenCalled();
      const [id, body] = update.mock.calls[0] as [string, { metadata: Record<string, string> }];
      expect(id).toBe("oss_abc123");
      expect(body.metadata.deploy_lock).toBeDefined();
    });

    it("release retrieves, strips the key, and updates Stripe", async () => {
      const now = Math.floor(Date.now() / 1000).toString();
      const retrieve = vi.fn(() =>
        Promise.resolve({ id: "oss_abc123", metadata: { deploy_lock: now, keep: "1" } }),
      );
      const update = vi.fn(() => Promise.resolve({ id: "oss_abc123", metadata: { keep: "1" } }));
      const stripe = { customers: { retrieve, update } } as unknown as Stripe;

      await releaseDeployLock(makeCustomer({ deploy_lock: now }), stripe);

      expect(retrieve).toHaveBeenCalledTimes(1);
      const [, body] = update.mock.calls[0] as [string, { metadata: Record<string, string> }];
      expect(body.metadata.deploy_lock).toBeUndefined();
      expect(body.metadata.keep).toBe("1");
      expect(customerCacheUpdate).not.toHaveBeenCalled();
    });
  });
});
