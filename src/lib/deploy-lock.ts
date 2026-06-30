import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { cacheCustomer } from "@/lib/customer-cache";

// Per-customer deployment lock. A new GPU deploy stamps the customer with a
// timestamp; a concurrent deploy within the TTL is rejected with 429. The
// lock lives in customer metadata so it survives across requests/instances.
//
// Two storage backends, chosen by whether Stripe is configured:
//   - Pro (Stripe present): the timestamp is stored in Stripe customer
//     metadata (the historical behavior).
//   - OSS (no Stripe): the synthetic customer has no Stripe record, so the
//     timestamp is persisted to customer_cache.metadataJson instead.
//
// In both cases the in-memory `customer.metadata` copy is kept consistent so
// the same request object reflects the lock without a round-trip.

const LOCK_KEY = "deploy_lock";
const LOCK_TTL_SECONDS = 60;

/**
 * True if the customer currently holds a non-expired deploy lock.
 * Reads customer.metadata, which both editions populate (OSS hydrates it
 * from customer_cache.metadataJson in the account resolver).
 */
export function isDeployLocked(customer: Stripe.Customer): boolean {
  const ts = customer.metadata?.[LOCK_KEY];
  if (!ts) return false;
  const lockTime = parseInt(ts, 10);
  if (Number.isNaN(lockTime)) return false;
  const now = Math.floor(Date.now() / 1000);
  return now - lockTime < LOCK_TTL_SECONDS;
}

/**
 * Stamp the deploy lock. Never throws — a lock failure must not block a
 * deploy, it only weakens the concurrency guard.
 */
export async function acquireDeployLock(
  customer: Stripe.Customer,
  stripe: Stripe | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000).toString();
  const meta = { ...customer.metadata, [LOCK_KEY]: now };
  customer.metadata = meta;
  try {
    if (stripe) {
      await stripe.customers.update(customer.id, { metadata: meta });
    } else {
      await persistOssMetadata(customer.id, meta);
    }
  } catch (err) {
    console.error("[Billing] Failed to acquire deploy lock:", err);
  }
}

/**
 * Clear the deploy lock. Never throws.
 */
export async function releaseDeployLock(
  customer: Stripe.Customer,
  stripe: Stripe | null,
): Promise<void> {
  try {
    if (stripe) {
      const fresh = (await stripe.customers.retrieve(customer.id)) as Stripe.Customer;
      cacheCustomer(fresh).catch(() => {});
      const meta = { ...fresh.metadata };
      delete meta[LOCK_KEY];
      const unlocked = await stripe.customers.update(customer.id, { metadata: meta });
      cacheCustomer(unlocked as Stripe.Customer).catch(() => {});
    } else {
      const meta = { ...customer.metadata };
      delete meta[LOCK_KEY];
      customer.metadata = meta;
      await persistOssMetadata(customer.id, meta);
    }
  } catch (err) {
    console.error("[Billing] Failed to release deploy lock:", err);
  }
}

/**
 * Persist the full metadata blob to customer_cache.metadataJson. Only the
 * JSON blob is touched — the derived teamId/billingType columns are left
 * intact since the lock never changes them.
 */
async function persistOssMetadata(
  customerId: string,
  metadata: Record<string, string>,
): Promise<void> {
  await prisma.customerCache.update({
    where: { id: customerId },
    data: { metadataJson: JSON.stringify(metadata), lastSyncedAt: new Date() },
  });
}
