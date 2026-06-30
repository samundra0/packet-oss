import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken, type CustomerTokenPayload } from "./customer";
import { getStripeOrNull } from "@/lib/stripe";
import { resolveOperatingContext } from "./account-resolver";
import { findSuspension } from "@/lib/customer-suspension";
import {
  resolveMembership,
  type ResolvedMembership,
} from "./membership";
import { can as canPure, type Permission } from "./role-permissions";
import { prisma } from "@/lib/prisma";
import type Stripe from "stripe";

/**
 * Authenticated customer context returned by getAuthenticatedCustomer().
 *
 * `membership` is the resolved (role, isOwner) tuple for the active account.
 * `can(perm)` is bound to that tuple — call it from route handlers to gate.
 *
 * Per-request cache: routes call `auth.can(perm)` as many times as they need
 * without re-reading the DB. The cache IS this object — it lives for one
 * request because getAuthenticatedCustomer is invoked once per request.
 */
export interface AuthenticatedCustomer {
  payload: CustomerTokenPayload;
  customer: Stripe.Customer;
  /** Primary team ID (first team found) — for backward compatibility */
  teamId: string | undefined;
  /** All team IDs across all Stripe customers for this email */
  allTeamIds: string[];
  stripe: Stripe | null;
  /** stripe_customer_id of the account this request is acting on (de-facto account_id) */
  accountId: string;
  /** Resolved membership (role, isOwner, revokedAt). Implicit when the JWT email matches customer.email but no row exists yet. */
  membership: ResolvedMembership;
  /** Bound permission check. Always true for owners; consults ROLE_PERMISSIONS otherwise. */
  can: (permission: Permission) => boolean;
}

/**
 * Extract and verify the Bearer token + Stripe customer from a request.
 *
 * Resolves ALL teams for the user's email (handles multi-account customers
 * with separate hourly + monthly Stripe accounts that may have different teams).
 *
 * Returns either the authenticated context or a NextResponse error.
 * Usage in routes:
 *
 *   const auth = await getAuthenticatedCustomer(request);
 *   if (auth instanceof NextResponse) return auth;
 *   if (!auth.can("gpu.provision")) return forbidden(auth, "gpu.provision");
 *   const { payload, customer, teamId, stripe } = auth;
 */
export async function getAuthenticatedCustomer(
  request: NextRequest
): Promise<AuthenticatedCustomer | NextResponse> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = verifyCustomerToken(token);
  if (!payload) {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 401 }
    );
  }

  const stripe = await getStripeOrNull();

  let customer: Stripe.Customer;
  let teamId: string | undefined;
  let accountId: string;
  let allTeamIds: string[];

  if (stripe) {
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });

    if (!ctx) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    const suspension = await findSuspension(ctx.allCustomerIds);
    if (suspension) {
      console.warn(`[Auth] Blocked suspended customer ${payload.email} (${ctx.accountId})`);
      return NextResponse.json({ error: "This account has been suspended. Contact support." }, { status: 403 });
    }

    customer = ctx.customer;
    teamId = customer.metadata?.hostedai_team_id || ctx.allTeamIds[0] || undefined;
    accountId = ctx.accountId;
    allTeamIds = ctx.allTeamIds;
  } else {
    // No Stripe — build minimal context from local cache
    const cached = await prisma.customerCache.findUnique({ where: { id: payload.customerId } });
    if (!cached) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    customer = {
      id: cached.id, email: cached.email, name: cached.name, metadata: { ...(cached.teamId ? { hostedai_team_id: cached.teamId } : {}) },
      balance: 0, created: Math.floor((cached.stripeCreatedAt?.getTime() || Date.now()) / 1000),
      currency: "usd", delinquent: null, description: null, discount: null,
      invoice_prefix: "", invoice_settings: {}, livemode: false,
      next_invoice_sequence: null, phone: null, preferred_locales: [],
      shipping: null, tax_exempt: "none", tax_ids: null, default_source: null,
      object: "customer",
    } as unknown as Stripe.Customer;
    teamId = cached.teamId || undefined;
    accountId = cached.id;
    // allTeamIds holds hosted.ai TEAM ids (consumers pass each entry to
    // getUnifiedInstances / connection-info / pool ops). In OSS it must be the
    // cached team id, NOT the synthetic oss_* customer id — otherwise every
    // HAI lookup (terminal, connection-info, start/stop) misses and 404s.
    allTeamIds = cached.teamId ? [cached.teamId] : [];
  }

  const customerEmail =
    typeof customer.email === "string" ? customer.email : null;

  const membership = await resolveMembership({
    userId: payload.userId,
    email: payload.email,
    accountId,
    customerEmail,
  });

  if (!membership) {
    // No membership row AND email doesn't match customer.email → this user
    // doesn't belong to this account. Deny early.
    console.warn(
      `[Auth] No membership for ${payload.email} on account ${accountId}`,
    );
    return NextResponse.json(
      { error: "You do not have access to this account." },
      { status: 403 },
    );
  }

  if (membership.revokedAt) {
    console.warn(
      `[Auth] Revoked membership for ${payload.email} on account ${accountId} (revoked at ${membership.revokedAt.toISOString()})`,
    );
    return NextResponse.json(
      { error: "Your access to this account has been revoked." },
      { status: 403 },
    );
  }

  // Bind can() to this membership. Closure over (role, isOwner) so route
  // handlers can call auth.can("perm") without re-loading the row.
  const can = (permission: Permission): boolean =>
    canPure(membership.role, membership.isOwner, permission);

  return {
    payload,
    customer,
    teamId,
    allTeamIds,
    stripe,
    accountId,
    membership,
    can,
  };
}
