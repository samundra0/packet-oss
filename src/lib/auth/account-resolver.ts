// Operating-context resolver. Bridges the two identity models that coexist
// in the codebase:
//
//   1. LEGACY (pre-PA-175): A user IS a Stripe customer. JWT.email matches
//      customer.email. Single Stripe customer per email (or hourly+monthly
//      pair for the same identity).
//
//   2. PA-175: A user has a row in the `user` table and one or more
//      team_memberships pointing to Stripe customers (the accounts). The
//      user need NOT be a Stripe customer themselves — they were invited.
//
// Single entry-point for the verify route + getAuthenticatedCustomer.
// Resolution order:
//   a. JWT.activeAccountId set → load that account; require active membership
//      (team_membership row or email-matches-customer implicit-Owner).
//   b. No activeAccountId, user has own Stripe customer → primary customer.
//   c. No activeAccountId, no own Stripe customer → first active membership
//      (ordered by acceptedAt desc). User can switch via /switch-account.
//
// Always returns the Stripe customer of the OPERATING account, not the
// "primary" customer of the email. Downstream code that uses `customer.id`
// gets the right account context automatically.

import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import {
  resolveAllTeamsForEmail,
  type ResolvedCustomer,
} from "@/lib/customer-resolver";

export interface OperatingContext {
  customer: Stripe.Customer;
  accountId: string;
  allTeamIds: string[];
  allCustomerIds: string[];
  monthlyCustomerIds: string[];
}

async function loadCustomer(
  stripe: Stripe,
  id: string,
): Promise<Stripe.Customer | null> {
  try {
    const c = (await stripe.customers.retrieve(id)) as Stripe.Customer;
    if (c.deleted) return null;
    return c;
  } catch {
    return null;
  }
}

function contextFromResolved(resolved: ResolvedCustomer): OperatingContext {
  return {
    customer: resolved.primaryCustomer,
    accountId: resolved.primaryCustomer.id,
    allTeamIds: resolved.allTeamIds,
    allCustomerIds: resolved.allCustomerIds,
    monthlyCustomerIds: resolved.monthlyCustomerIds,
  };
}

function contextFromAccount(
  customer: Stripe.Customer,
  ownResolved: ResolvedCustomer | null,
): OperatingContext {
  // Monthly subs of the OPERATING account live on its own linked monthly
  // customers (cross-referenced via metadata.monthly_stripe_customer_ids
  // by the Stripe webhook). When a user is operating in someone else's
  // team (e.g., a Read-only Member viewing the owner's team), we MUST
  // read these IDs from the operating customer, not from the user's own
  // resolution — otherwise the owner's subscriptions are invisible.
  const linkedMonthlyIds = (customer.metadata?.monthly_stripe_customer_ids ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return {
    customer,
    accountId: customer.id,
    allTeamIds: customer.metadata?.hostedai_team_id
      ? [customer.metadata.hostedai_team_id]
      : (ownResolved?.allTeamIds ?? []),
    // Suspension check should still consider the user's OWN customers as
    // well — a suspended-from-fraud user locks out cross-account.
    allCustomerIds: ownResolved
      ? Array.from(new Set([...ownResolved.allCustomerIds, customer.id]))
      : [customer.id],
    monthlyCustomerIds: linkedMonthlyIds,
  };
}

export async function resolveOperatingContext({
  email,
  jwtCustomerId,
  activeAccountId,
}: {
  email: string;
  jwtCustomerId?: string;
  activeAccountId?: string;
}): Promise<OperatingContext | null> {
  const stripe = await getStripe();
  const lower = email.toLowerCase();

  // Always try to resolve the user's own Stripe customer(s) first. We need
  // this anyway for suspension checks even when operating in another account.
  const ownResolved = await resolveAllTeamsForEmail(email, jwtCustomerId);

  // (a) Explicit activeAccountId in the JWT wins. Verify the user has
  // access to it — either via team_membership or implicit-Owner email match.
  if (activeAccountId) {
    const user = await prisma.user.findUnique({
      where: { email: lower },
      select: { id: true },
    });

    let hasAccess = false;
    if (user) {
      const membership = await prisma.teamMembership.findUnique({
        where: {
          userId_stripeCustomerId: {
            userId: user.id,
            stripeCustomerId: activeAccountId,
          },
        },
      });
      if (
        membership &&
        membership.status === "active" &&
        !membership.revokedAt
      ) {
        hasAccess = true;
      }
    }

    const customer = await loadCustomer(stripe, activeAccountId);
    if (!customer) return null;

    // Implicit-Owner fallback: no team_membership row yet, but JWT email
    // matches the Stripe customer's email.
    if (
      !hasAccess &&
      typeof customer.email === "string" &&
      customer.email.toLowerCase() === lower
    ) {
      hasAccess = true;
    }
    if (!hasAccess) return null;

    return contextFromAccount(customer, ownResolved);
  }

  // (b) No activeAccountId, user has their own Stripe customer → primary.
  if (ownResolved) {
    return contextFromResolved(ownResolved);
  }

  // (c) Team-only user: no Stripe customer of their own. Pick the first
  // active membership; user can switch via /api/session/switch-account.
  const user = await prisma.user.findUnique({
    where: { email: lower },
    select: { id: true },
  });
  if (!user) return null;

  const memberships = await prisma.teamMembership.findMany({
    where: { userId: user.id, status: "active", revokedAt: null },
    orderBy: { acceptedAt: "desc" },
  });
  if (memberships.length === 0) return null;

  const customer = await loadCustomer(stripe, memberships[0].stripeCustomerId);
  if (!customer) return null;

  return contextFromAccount(customer, null);
}
