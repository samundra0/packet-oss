import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken, type CustomerTokenPayload } from "./customer";
import { getStripe } from "@/lib/stripe";
import { resolveAllTeamsForEmail } from "@/lib/customer-resolver";
import { findSuspension } from "@/lib/customer-suspension";
import type Stripe from "stripe";

/**
 * Authenticated customer context returned by getAuthenticatedCustomer().
 */
export interface AuthenticatedCustomer {
  payload: CustomerTokenPayload;
  customer: Stripe.Customer;
  /** Primary team ID (first team found) — for backward compatibility */
  teamId: string | undefined;
  /** All team IDs across all Stripe customers for this email */
  allTeamIds: string[];
  stripe: Stripe;
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
 *   const { payload, customer, teamId, allTeamIds, stripe } = auth;
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

  // Resolve all teams for this email — handles customers with multiple
  // Stripe accounts (hourly + monthly) that link to different hosted.ai teams
  const resolved = await resolveAllTeamsForEmail(payload.email, payload.customerId);

  if (!resolved) {
    return NextResponse.json(
      { error: "Customer not found" },
      { status: 404 }
    );
  }

  // Block suspended customers (fraud lockout). Checks all linked Stripe
  // customer IDs since one suspended account locks the whole email out
  // for the entire duration of any still-valid JWT.
  const suspension = await findSuspension(resolved.allCustomerIds);
  if (suspension) {
    console.warn(`[Auth] Blocked suspended customer ${payload.email} (${resolved.primaryCustomer.id})`);
    return NextResponse.json(
      { error: "This account has been suspended. Contact support." },
      { status: 403 }
    );
  }

  const customer = resolved.primaryCustomer;
  const teamId = resolved.allTeamIds[0] || customer.metadata?.hostedai_team_id || undefined;

  return { payload, customer, teamId, allTeamIds: resolved.allTeamIds, stripe };
}
