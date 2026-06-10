/**
 * PA-267 logout. Revokes the server-side session row (so a copied refresh token
 * is dead immediately) and clears the cookie. `?all=1` revokes every session for
 * the customer ("log out everywhere"), identified from the Bearer access token.
 *
 * Impersonation never creates a session row (the verify route gates on
 * isEphemeralToken), so a customer logout can never touch an impersonation.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  revokeSessionByToken,
  revokeAllSessionsForCustomer,
  decodeRefreshCustomerId,
  buildClearedSessionCookie,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/customer-session";
import { verifyCustomerToken } from "@/lib/auth/customer";

export async function POST(request: NextRequest) {
  const isProd = process.env.NODE_ENV === "production";
  const refresh = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const all = request.nextUrl.searchParams.get("all") === "1";

  if (all) {
    // Identify the customer from the refresh cookie first (it outlives the
    // short Bearer access token, which is often already expired at logout);
    // fall back to the Bearer only when there's no cookie.
    let customerId: string | null = refresh ? decodeRefreshCustomerId(refresh) : null;
    if (!customerId) {
      const bearer = request.headers.get("authorization")?.replace("Bearer ", "");
      const payload = bearer ? verifyCustomerToken(bearer) : null;
      customerId = payload?.customerId ?? null;
    }
    if (customerId) {
      await revokeAllSessionsForCustomer(customerId);
    }
  }

  if (refresh) {
    await revokeSessionByToken(refresh);
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(buildClearedSessionCookie(isProd));
  return res;
}
