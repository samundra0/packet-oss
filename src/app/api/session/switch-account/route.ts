// POST /session/switch-account — switch the active account context for a
// user who's a member of multiple accounts. Returns a new JWT with
// activeAccountId set to the target account.
//
// Authorization: caller must be an active, non-revoked member of the target
// account (verified by reading the membership row).

import { NextRequest, NextResponse } from "next/server";
import {
  verifyCustomerToken,
  generateCustomerToken,
} from "@/lib/customer-auth";
import {
  reissueRefreshTokenWithAccount,
  buildSessionCookie,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/customer-session";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import type Stripe from "stripe";
import { materializeImplicitOwner } from "@/lib/auth/membership";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const tokenJwt = authHeader?.replace("Bearer ", "");
  if (!tokenJwt) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const payload = verifyCustomerToken(tokenJwt);
  if (!payload) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { accountId?: string };
  const targetAccountId = body.accountId;
  if (!targetAccountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const lower = payload.email.toLowerCase();
  let user = await prisma.user.findUnique({ where: { email: lower } });

  let membership =
    user
      ? await prisma.teamMembership.findUnique({
          where: {
            userId_stripeCustomerId: {
              userId: user.id,
              stripeCustomerId: targetAccountId,
            },
          },
        })
      : null;

  // Implicit-Owner fallback: no team_membership row yet, but the user owns
  // this Stripe customer by email match. Materialize the row + User on the fly.
  if (!membership) {
    const stripe = await getStripe();
    let customer: Stripe.Customer | null;
    try {
      customer = (await stripe.customers.retrieve(
        targetAccountId,
      )) as Stripe.Customer;
      if (customer.deleted) customer = null;
    } catch {
      customer = null;
    }
    if (
      customer &&
      typeof customer.email === "string" &&
      customer.email.toLowerCase() === lower
    ) {
      const materialized = await materializeImplicitOwner({
        email: payload.email,
        accountId: targetAccountId,
        displayName:
          typeof customer.name === "string" ? customer.name : null,
      });
      user = await prisma.user.findUnique({ where: { email: lower } });
      membership = await prisma.teamMembership.findUnique({
        where: {
          userId_stripeCustomerId: {
            userId: materialized.userId,
            stripeCustomerId: targetAccountId,
          },
        },
      });
    }
  }

  if (!user || !membership || membership.revokedAt || membership.status !== "active") {
    return NextResponse.json(
      { error: "You are not an active member of that account." },
      { status: 403 },
    );
  }

  // Mint a new JWT scoped to the target account. customerId stays the same
  // (it's the JWT's authentication identity — the Stripe customer Stripe knows
  // about). activeAccountId is the workspace the user is operating in.
  const newToken = generateCustomerToken(payload.email, payload.customerId, {
    userId: user.id,
    activeAccountId: targetAccountId,
    expiresInHours: 1,
  });

  const res = NextResponse.json({
    token: newToken,
    accountId: targetAccountId,
    role: membership.role,
    isOwner: membership.isOwner,
  });

  // PA-267: if this is a persistent (cookie) session, propagate the new operating
  // account into the refresh cookie (same jti, same expiry) so the switch survives
  // a later access-token refresh instead of silently reverting to the default
  // account. The membership check above already authorized targetAccountId.
  const refreshCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (refreshCookie) {
    const reissued = reissueRefreshTokenWithAccount(refreshCookie, targetAccountId);
    if (reissued) {
      res.cookies.set(buildSessionCookie(reissued, process.env.NODE_ENV === "production"));
    }
  }

  return res;
}
