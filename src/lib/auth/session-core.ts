/**
 * Pure session logic for PA-267 persistent customer sessions. No DB, no Next —
 * the DB/cookie wiring lives in customer-session.ts. Kept separate so the
 * expiry math, hashing, and the ephemeral-token guard are unit-testable.
 */
import crypto from "crypto";

export const SESSION_COOKIE_NAME = "packet_session";
export const SESSION_WINDOW_DAYS = 15; // rolling: each visit extends the session this far
export const SESSION_ABSOLUTE_CAP_DAYS = 30; // hard ceiling from creation, even with activity
export const ACCESS_TOKEN_HOURS = 12; // in-memory access token lifetime; refreshed from the cookie

const DAY_MS = 24 * 60 * 60 * 1000;

/** sha256(jti) hex — what we store in customer_session.token_hash. */
export function hashSessionToken(jti: string): string {
  return crypto.createHash("sha256").update(jti).digest("hex");
}

/**
 * Is this customer token ephemeral — i.e. must NEVER be written to the
 * persistent refresh cookie? Admin "Login as" mints skipTwoFactor tokens; a
 * future impersonator claim is covered too. Fails safe to `true` (don't persist)
 * when the payload is missing.
 */
export function isEphemeralToken(
  payload: { skipTwoFactor?: boolean; impersonator?: unknown } | null | undefined,
): boolean {
  if (!payload) return true;
  return payload.skipTwoFactor === true || payload.impersonator != null;
}

/**
 * Rolling expiry: each refresh pushes expiry to now + 15d, but never past the
 * 30-day absolute cap measured from session creation.
 */
export function computeSessionExpiry(
  nowMs: number,
  createdAtMs: number,
): { expiresAt: Date; absoluteExpiresAt: Date } {
  const absolute = createdAtMs + SESSION_ABSOLUTE_CAP_DAYS * DAY_MS;
  const rolling = Math.min(nowMs + SESSION_WINDOW_DAYS * DAY_MS, absolute);
  return { expiresAt: new Date(rolling), absoluteExpiresAt: new Date(absolute) };
}

/** A session row is usable iff not revoked and not past its (rolling) expiry. */
export function isSessionLive(
  row: { revokedAt: Date | null; expiresAt: Date },
  nowMs: number,
): boolean {
  if (row.revokedAt) return false;
  return row.expiresAt.getTime() > nowMs;
}

export interface SessionCookieConfig {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
}

/** httpOnly refresh cookie config. maxAge tracks the rolling window; the DB row
 *  is the real authority and the refresh JWT carries the absolute cap. */
export function buildSessionCookie(refreshToken: string, isProd: boolean): SessionCookieConfig {
  return {
    name: SESSION_COOKIE_NAME,
    value: refreshToken,
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_WINDOW_DAYS * 24 * 60 * 60,
  };
}

/** Cookie config that clears the session cookie (logout). */
export function buildClearedSessionCookie(isProd: boolean): SessionCookieConfig {
  return {
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  };
}
