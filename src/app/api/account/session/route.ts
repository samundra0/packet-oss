/**
 * PA-267 session refresh.
 *
 * Reads the httpOnly `packet_session` refresh cookie, validates + rolls the
 * session row, and returns a fresh short-lived access token for the existing
 * Bearer flow. The dashboard calls this on load (when there's no URL token) and
 * after an access-token 401, so a returning user stays logged in for up to 15
 * days without a new magic link.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  validateAndRotateSession,
  buildSessionCookie,
  buildClearedSessionCookie,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/customer-session";
import { ACCESS_TOKEN_HOURS } from "@/lib/auth/session-core";
import { generateCustomerToken } from "@/lib/auth/customer";

export async function POST(request: NextRequest) {
  const isProd = process.env.NODE_ENV === "production";
  const refresh = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!refresh) {
    return NextResponse.json({ error: "No session" }, { status: 401 });
  }

  const identity = await validateAndRotateSession(refresh);
  if (!identity) {
    // Cookie present but dead (revoked/expired) — clear it so the browser stops sending it.
    const res = NextResponse.json({ error: "Session expired" }, { status: 401 });
    res.cookies.set(buildClearedSessionCookie(isProd));
    return res;
  }

  const token = generateCustomerToken(identity.email, identity.customerId, {
    userId: identity.userId,
    // PA-175: preserve the operating account so a switched workspace survives refresh.
    activeAccountId: identity.activeAccountId,
    expiresInHours: ACCESS_TOKEN_HOURS,
  });

  const res = NextResponse.json({ token });
  // Re-set the cookie to roll its browser-side expiry (the DB row was rolled too).
  res.cookies.set(buildSessionCookie(refresh, isProd));
  return res;
}
