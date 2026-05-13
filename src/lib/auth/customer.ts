import jwt from "jsonwebtoken";
import { getSecret } from "./secrets";

function getJwtSecret(): string {
  return getSecret("CUSTOMER_JWT_SECRET");
}

export interface CustomerTokenPayload {
  email: string;
  customerId: string;
  type: "customer-dashboard";
  skipTwoFactor?: boolean; // Set to true for admin bypass tokens
  twoFactorVerified?: boolean; // Set after user completes TOTP verification
}

export function generateCustomerToken(
  email: string,
  customerId: string,
  expiresInHours: number = 1
): string {
  return jwt.sign(
    {
      email: email.toLowerCase(),
      customerId,
      type: "customer-dashboard",
    },
    getJwtSecret(),
    { expiresIn: `${expiresInHours}h` } // Dashboard links valid for user's preference (default 1 hour)
  );
}

/**
 * Generate a customer token that bypasses 2FA.
 * Used by admins for the "Login As" feature.
 */
export function generateAdminBypassToken(email: string, customerId: string): string {
  return jwt.sign(
    {
      email: email.toLowerCase(),
      customerId,
      type: "customer-dashboard",
      skipTwoFactor: true,
    },
    getJwtSecret(),
    { expiresIn: "1h" }
  );
}

/**
 * Re-sign a customer token with the twoFactorVerified flag set.
 * Preserves the original token's expiry so the session isn't extended.
 */
export function generateTwoFactorVerifiedToken(originalToken: string): string | null {
  try {
    const decoded = jwt.verify(originalToken, getJwtSecret(), { algorithms: ['HS256'] }) as CustomerTokenPayload & { exp: number };
    if (decoded.type !== "customer-dashboard") return null;

    const remainingSeconds = decoded.exp - Math.floor(Date.now() / 1000);
    if (remainingSeconds <= 0) return null;

    return jwt.sign(
      {
        email: decoded.email,
        customerId: decoded.customerId,
        type: "customer-dashboard",
        twoFactorVerified: true,
      },
      getJwtSecret(),
      { expiresIn: remainingSeconds }
    );
  } catch {
    return null;
  }
}

export function verifyCustomerToken(token: string): CustomerTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as CustomerTokenPayload;
    if (decoded.type !== "customer-dashboard") {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Generate a long-lived token for drip email unsubscribe links.
 * Valid for 90 days — outlives the drip sequence itself.
 */
export function generateUnsubscribeToken(email: string): string {
  return jwt.sign(
    { email: email.toLowerCase(), type: "drip-unsubscribe" },
    getJwtSecret(),
    { expiresIn: "90d" }
  );
}

/**
 * Verify a drip unsubscribe token.
 */
export function verifyUnsubscribeToken(token: string): { email: string } | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as { email: string; type: string };
    if (decoded.type !== "drip-unsubscribe") {
      return null;
    }
    return { email: decoded.email };
  } catch {
    return null;
  }
}
