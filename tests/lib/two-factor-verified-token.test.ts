import { describe, it, expect } from "vitest";
import {
  generateCustomerToken,
  generateAdminBypassToken,
  generateTwoFactorVerifiedToken,
  verifyCustomerToken,
} from "@/lib/auth/customer";

// Regression for the auth review: re-signing a 2FA-verified token must NOT drop
// claims that affect isolation (skipTwoFactor), identity (userId/activeAccountId),
// or intent (next). Dropping them let an impersonation token be laundered into a
// persistent session and broke multi-team + deep-link for 2FA users.
describe("generateTwoFactorVerifiedToken claim preservation", () => {
  it("preserves skipTwoFactor so an impersonation token stays ephemeral (cannot be laundered)", () => {
    const bypass = generateAdminBypassToken("victim@example.com", "cus_victim");
    const verified = generateTwoFactorVerifiedToken(bypass);
    expect(verified).not.toBeNull();
    const p = verifyCustomerToken(verified!);
    expect(p?.skipTwoFactor).toBe(true);
    expect(p?.twoFactorVerified).toBe(true);
  });

  it("preserves userId, activeAccountId, and the next deep-link claim", () => {
    const token = generateCustomerToken("u@example.com", "cus_1", {
      userId: "user_1",
      activeAccountId: "cus_team",
      next: "/dashboard?gpu=b200&plan=monthly",
      expiresInHours: 1,
    });
    const p = verifyCustomerToken(generateTwoFactorVerifiedToken(token)!);
    expect(p?.userId).toBe("user_1");
    expect(p?.activeAccountId).toBe("cus_team");
    expect(p?.next).toBe("/dashboard?gpu=b200&plan=monthly");
    expect(p?.twoFactorVerified).toBe(true);
  });

  it("a normal token gains twoFactorVerified and does NOT acquire skipTwoFactor", () => {
    const token = generateCustomerToken("u@example.com", "cus_1", { expiresInHours: 1 });
    const p = verifyCustomerToken(generateTwoFactorVerifiedToken(token)!);
    expect(p?.twoFactorVerified).toBe(true);
    expect(p?.skipTwoFactor).toBeUndefined();
  });
});
