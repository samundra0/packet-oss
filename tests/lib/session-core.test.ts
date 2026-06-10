import { describe, it, expect } from "vitest";
import {
  hashSessionToken,
  isEphemeralToken,
  computeSessionExpiry,
  isSessionLive,
  buildSessionCookie,
  buildClearedSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_WINDOW_DAYS,
  SESSION_ABSOLUTE_CAP_DAYS,
} from "@/lib/auth/session-core";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("hashSessionToken", () => {
  it("is a deterministic 64-char hex sha256", () => {
    const h = hashSessionToken("jti-123");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken("jti-123")).toBe(h);
    expect(hashSessionToken("jti-124")).not.toBe(h);
  });
});

describe("isEphemeralToken", () => {
  it("flags impersonation/skipTwoFactor tokens as non-persistable", () => {
    expect(isEphemeralToken({ skipTwoFactor: true })).toBe(true);
    expect(isEphemeralToken({ impersonator: { adminEmail: "a@b.com" } })).toBe(true);
  });
  it("allows a normal customer token to persist", () => {
    expect(isEphemeralToken({})).toBe(false);
    expect(isEphemeralToken({ skipTwoFactor: false })).toBe(false);
  });
  it("fails safe to ephemeral for a missing payload", () => {
    expect(isEphemeralToken(null)).toBe(true);
    expect(isEphemeralToken(undefined)).toBe(true);
  });
});

describe("computeSessionExpiry", () => {
  it("rolls to now + 15d while under the absolute cap", () => {
    const now = 1_000_000_000_000;
    const createdAt = now - 2 * DAY_MS; // 2 days old
    const { expiresAt, absoluteExpiresAt } = computeSessionExpiry(now, createdAt);
    expect(expiresAt.getTime()).toBe(now + SESSION_WINDOW_DAYS * DAY_MS);
    expect(absoluteExpiresAt.getTime()).toBe(createdAt + SESSION_ABSOLUTE_CAP_DAYS * DAY_MS);
  });

  it("caps the rolling expiry at createdAt + 30d", () => {
    const createdAt = 1_000_000_000_000;
    const now = createdAt + 29 * DAY_MS; // 29 days in; now+15d would exceed the cap
    const { expiresAt } = computeSessionExpiry(now, createdAt);
    expect(expiresAt.getTime()).toBe(createdAt + SESSION_ABSOLUTE_CAP_DAYS * DAY_MS);
    expect(expiresAt.getTime()).toBeLessThan(now + SESSION_WINDOW_DAYS * DAY_MS);
  });
});

describe("isSessionLive", () => {
  const now = 1_000_000_000_000;
  it("is live when not revoked and not expired", () => {
    expect(isSessionLive({ revokedAt: null, expiresAt: new Date(now + DAY_MS) }, now)).toBe(true);
  });
  it("is dead when revoked", () => {
    expect(isSessionLive({ revokedAt: new Date(now - DAY_MS), expiresAt: new Date(now + DAY_MS) }, now)).toBe(false);
  });
  it("is dead when expired", () => {
    expect(isSessionLive({ revokedAt: null, expiresAt: new Date(now - 1) }, now)).toBe(false);
  });
});

describe("session cookie config", () => {
  it("is httpOnly, lax, root-path, secure only in prod, with the rolling maxAge", () => {
    const c = buildSessionCookie("refresh.jwt", true);
    expect(c.name).toBe(SESSION_COOKIE_NAME);
    expect(c.httpOnly).toBe(true);
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe("lax");
    expect(c.path).toBe("/");
    expect(c.maxAge).toBe(SESSION_WINDOW_DAYS * 24 * 60 * 60);
    expect(buildSessionCookie("x", false).secure).toBe(false);
  });
  it("clears with maxAge 0", () => {
    const c = buildClearedSessionCookie(true);
    expect(c.name).toBe(SESSION_COOKIE_NAME);
    expect(c.value).toBe("");
    expect(c.maxAge).toBe(0);
    expect(c.httpOnly).toBe(true);
  });
});
