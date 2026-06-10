import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { reissueRefreshTokenWithAccount } from "@/lib/auth/customer-session";

// PA-175 + PA-267: account-switch re-issues the refresh cookie so the switched
// workspace survives a later access-token refresh. The re-issue must keep the
// same jti (same DB row) and the same absolute expiry (no cap extension).
const SECRET = process.env.CUSTOMER_JWT_SECRET as string;
const mintRefresh = (extra: Record<string, unknown> = {}) =>
  jwt.sign(
    { jti: "jti-1", customerId: "cus_1", email: "u@x.com", userId: "user_1", type: "customer-refresh", ...extra },
    SECRET,
    { expiresIn: "30d" },
  );
const decode = (t: string) => jwt.verify(t, SECRET) as Record<string, unknown>;

describe("reissueRefreshTokenWithAccount", () => {
  it("swaps activeAccountId while keeping jti, userId, and the original expiry", () => {
    const orig = mintRefresh();
    const origExp = decode(orig).exp;
    const reissued = reissueRefreshTokenWithAccount(orig, "cus_teamB");
    expect(reissued).not.toBeNull();
    const p = decode(reissued!);
    expect(p.jti).toBe("jti-1");
    expect(p.activeAccountId).toBe("cus_teamB");
    expect(p.userId).toBe("user_1");
    expect(p.type).toBe("customer-refresh");
    expect(p.exp).toBe(origExp); // absolute cap not extended
  });

  it("clears activeAccountId when switching back to none", () => {
    const orig = mintRefresh({ activeAccountId: "cus_old" });
    const p = decode(reissueRefreshTokenWithAccount(orig, undefined)!);
    expect(p.activeAccountId).toBeUndefined();
  });

  it("returns null for an invalid or non-refresh token", () => {
    expect(reissueRefreshTokenWithAccount("garbage", "cus_x")).toBeNull();
    const access = jwt.sign(
      { customerId: "c", email: "e", type: "customer-dashboard" },
      SECRET,
      { expiresIn: "1h" },
    );
    expect(reissueRefreshTokenWithAccount(access, "cus_x")).toBeNull();
  });
});
