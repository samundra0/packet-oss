import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken, type CustomerTokenPayload } from "./customer";
import { getStripe } from "@/lib/stripe";
import { resolveOperatingContext } from "./account-resolver";
import { findSuspension } from "@/lib/customer-suspension";
import {
  resolveMembership,
  type ResolvedMembership,
} from "./membership";
import { can as canPure, type Permission } from "./role-permissions";
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
  stripe: Stripe;
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

  const stripe = await getStripe();

  // PA-175: unified resolution. Honors JWT.activeAccountId for the multi-team
  // case; falls back to user's own Stripe customer; falls back to team-only
  // (invitee with no own Stripe customer) lookup via team_membership.
  const ctx = await resolveOperatingContext({
    email: payload.email,
    jwtCustomerId: payload.customerId,
    activeAccountId: payload.activeAccountId,
  });

  if (!ctx) {
    return NextResponse.json(
      { error: "Customer not found" },
      { status: 404 }
    );
  }

  // Block suspended customers (fraud lockout). Checks all linked Stripe
  // customer IDs since one suspended account locks the whole email out
  // for the entire duration of any still-valid JWT.
  const suspension = await findSuspension(ctx.allCustomerIds);
  if (suspension) {
    console.warn(`[Auth] Blocked suspended customer ${payload.email} (${ctx.accountId})`);
    return NextResponse.json(
      { error: "This account has been suspended. Contact support." },
      { status: 403 }
    );
  }

  const customer = ctx.customer;
  const teamId = customer.metadata?.hostedai_team_id || ctx.allTeamIds[0] || undefined;
  const accountId = ctx.accountId;

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
    allTeamIds: ctx.allTeamIds,
    stripe,
    accountId,
    membership,
    can,
  };
}
