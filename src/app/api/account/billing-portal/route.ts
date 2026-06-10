import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { getStripe } from "@/lib/stripe";
import { gatePermission } from "@/lib/auth/gate";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";

/**
 * POST /api/account/billing-portal
 *
 * Creates a fresh Stripe Billing Portal session and redirects the user.
 * Portal sessions expire quickly, so we generate a new one each time.
 */
export async function POST(request: NextRequest) {
  try {
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

    // PA-175: resolve the OPERATING account. Invited Team Admin / Finance
    // Manager need to open the team Owner's Stripe portal (the billing
    // they're empowered to manage), not their own personal Stripe customer.
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // PA-175 gate: portal exposes payment methods and invoices — billing.manage only.
    const customerEmail =
      typeof ctx.customer.email === "string" ? ctx.customer.email : null;
    const denial = await gatePermission({
      payload,
      accountId: ctx.accountId,
      customerEmail,
      permission: "billing.manage",
      request,
    });
    if (denial) return denial;

    // Create a fresh billing portal session for the OPERATING account.
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: ctx.accountId,
      // PA-267: no token in the return URL — the session cookie re-bootstraps the
      // access token on /dashboard load, so the JWT can't linger in history/referrer.
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    });

    return NextResponse.json({
      url: portalSession.url,
    });
  } catch (error) {
    console.error("Billing portal error:", error);
    return NextResponse.json(
      { error: "Failed to create billing portal session" },
      { status: 500 }
    );
  }
}
