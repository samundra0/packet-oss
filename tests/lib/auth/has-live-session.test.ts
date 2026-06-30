import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const SECRET = "test-customer-jwt-secret-key-for-testing";

// getJwtSecret() -> getSecret("CUSTOMER_JWT_SECRET")
vi.mock("@/lib/auth/secrets", () => ({
  getSecret: vi.fn(() => SECRET),
}));

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { customerSession: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

import { hasLiveSession } from "@/lib/auth/customer-session";

function refreshToken(jti = "11111111-1111-1111-1111-111111111111") {
  return jwt.sign({ jti, customerId: "oss_x", email: "u@x.com", type: "customer-refresh" }, SECRET);
}

describe("hasLiveSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("false for a malformed / wrong-secret token (no DB hit)", async () => {
    expect(await hasLiveSession("not-a-jwt")).toBe(false);
    expect(await hasLiveSession(jwt.sign({ jti: "a", type: "customer-refresh" }, "wrong-secret"))).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("false for a non-refresh token type", async () => {
    expect(await hasLiveSession(jwt.sign({ jti: "a", type: "customer-dashboard" }, SECRET))).toBe(false);
  });

  it("false when no session row exists (deleted/dead cookie)", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(await hasLiveSession(refreshToken())).toBe(false);
  });

  it("false when the row is revoked or expired", async () => {
    findUnique.mockResolvedValueOnce({ revokedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) });
    expect(await hasLiveSession(refreshToken())).toBe(false);

    findUnique.mockResolvedValueOnce({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) });
    expect(await hasLiveSession(refreshToken())).toBe(false);
  });

  it("true for a live, unrevoked, unexpired session", async () => {
    findUnique.mockResolvedValueOnce({ revokedAt: null, expiresAt: new Date(Date.now() + 1e9) });
    expect(await hasLiveSession(refreshToken())).toBe(true);
  });
});
