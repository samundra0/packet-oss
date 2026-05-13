/**
 * Customer suspension (fraud lockout).
 *
 * A suspended customer:
 *   - Cannot log in (login email refused, /verify returns 403)
 *   - Has their hosted.ai team suspended (no GPU access)
 *   - Has active Stripe subscriptions canceled
 *   - Has wallet balance zeroed out
 *
 * Suspension is keyed by Stripe customer ID, but applied to ALL customers
 * sharing the same email (a single user may have linked hourly + monthly accounts).
 */

import { prisma } from "@/lib/prisma";

export interface SuspensionInfo {
  suspended: boolean;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  suspendedBy: string | null;
}

/**
 * Check whether any of the given Stripe customer IDs is suspended.
 * Returns the first suspension record found, or null.
 */
export async function findSuspension(
  stripeCustomerIds: string[]
): Promise<SuspensionInfo | null> {
  if (stripeCustomerIds.length === 0) return null;
  const row = await prisma.customerSettings.findFirst({
    where: { stripeCustomerId: { in: stripeCustomerIds }, suspended: true },
    select: {
      suspended: true,
      suspendedAt: true,
      suspendedReason: true,
      suspendedBy: true,
    },
  });
  return row ?? null;
}

export async function isCustomerSuspended(stripeCustomerId: string): Promise<boolean> {
  const row = await prisma.customerSettings.findUnique({
    where: { stripeCustomerId },
    select: { suspended: true },
  });
  return !!row?.suspended;
}

export async function setSuspension(params: {
  stripeCustomerId: string;
  suspended: boolean;
  reason?: string | null;
  adminEmail?: string | null;
}): Promise<void> {
  const { stripeCustomerId, suspended, reason, adminEmail } = params;
  const data = suspended
    ? {
        suspended: true,
        suspendedAt: new Date(),
        suspendedReason: reason ?? null,
        suspendedBy: adminEmail ?? null,
      }
    : {
        suspended: false,
        suspendedAt: null,
        suspendedReason: null,
        suspendedBy: null,
      };

  await prisma.customerSettings.upsert({
    where: { stripeCustomerId },
    update: data,
    create: { stripeCustomerId, ...data },
  });
}
