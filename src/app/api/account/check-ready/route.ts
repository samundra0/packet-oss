import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { generateCustomerToken } from "@/lib/customer-auth";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");

  if (!sessionId) {
    return NextResponse.json(
      { error: "session_id is required" },
      { status: 400 }
    );
  }

  try {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session || !session.customer_email) {
      return NextResponse.json({ ready: false });
    }

    const customerId = session.customer as string | null;
    if (!customerId) {
      return NextResponse.json({ ready: false });
    }

    const customer = await stripe.customers.retrieve(customerId);
    if ("deleted" in customer && customer.deleted) {
      return NextResponse.json({ ready: false });
    }

    // Standard path: this Stripe customer owns a hosted.ai team (new-user signup,
    // hourly or first-time monthly).
    let resolvedCustomerId = customerId;
    let resolvedCustomer = customer;
    let teamId = customer.metadata?.hostedai_team_id;

    // Existing-user monthly path: the monthly subscription creates a separate
    // Stripe customer that does NOT carry hostedai_team_id. Instead the webhook
    // sets primary_stripe_customer_id pointing at the primary (hourly) customer
    // that owns the team. Follow that link.
    if (!teamId && customer.metadata?.primary_stripe_customer_id) {
      const primaryId = customer.metadata.primary_stripe_customer_id;
      const primary = await stripe.customers.retrieve(primaryId);
      if (!("deleted" in primary && primary.deleted)) {
        const primaryTeamId = primary.metadata?.hostedai_team_id;
        if (primaryTeamId) {
          teamId = primaryTeamId;
          resolvedCustomerId = primary.id;
          resolvedCustomer = primary;
        }
      }
    }

    if (!teamId) {
      return NextResponse.json({ ready: false });
    }

    // Account is ready - generate auto-login token for the primary customer
    // (so the dashboard shows the combined hourly + monthly view).
    const token = generateCustomerToken(
      session.customer_email.toLowerCase(),
      resolvedCustomerId
    );
    const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?token=${token}`;

    return NextResponse.json({
      ready: true,
      dashboardUrl,
      email: session.customer_email,
      name: resolvedCustomer.name || null,
      amountCents: session.amount_total || 0,
      customerId: resolvedCustomerId,
    });
  } catch (error) {
    console.error("Check-ready error:", error);
    return NextResponse.json({ ready: false });
  }
}
