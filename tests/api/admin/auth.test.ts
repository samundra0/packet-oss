// Tests for src/app/api/admin/auth/route.ts — the admin login endpoint.
//
// This route multiplexes four distinct auth flows through one POST handler:
//   1. OSS password login (first-run bootstrap, normal login, optional TOTP)
//   2. Pro magic-link send (email → 15m JWT link)
//   3. Pro magic-link verify (token → optional TOTP → optional PIN → session)
//   4. Pre-auth token verify (OSS password + 2FA second step)
// plus GET (session check) and DELETE (logout).
//
// What this suite protects:
//   * Failed logins must never leak which part was wrong (same generic 401
//     for unknown email / no password set / wrong password).
//   * The magic-link send must return identical success for admins and
//     non-admins (email enumeration prevention) — and must NOT send mail
//     to non-admins.
//   * A session cookie is only ever set AFTER every configured factor
//     (password, TOTP, PIN) has passed — never on intermediate responses.
//   * Rate limiting short-circuits before any credential evaluation.
//
// Everything is mocked at the lib module boundary (same pattern as
// tests/api/admin/customers-search.test.ts); the route's own branching is
// the unit under test.

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockIsAdmin,
  mockGenerateAdminToken,
  mockVerifyAdminToken,
  mockGeneratePreAuthToken,
  mockVerifyPreAuthToken,
  mockGenerateSessionToken,
  mockVerifySessionToken,
  mockSendEmail,
  mockRateLimit,
  mockGetClientIp,
  mockGetTwoFactorStatus,
  mockVerifyTwoFactorCode,
  mockIsTwoFactorEnabled,
  mockGetAdminPinStatus,
  mockSetAdminPin,
  mockVerifyAdminPin,
  mockLogAdminLogin,
  mockLogAdminActivity,
  mockIsOSS,
  mockVerifyAdminPassword,
  mockAdminHasPassword,
  mockIsFirstRun,
  mockBootstrapFirstAdminWithPassword,
  mockLogLoginAttempt,
  mockLoadTemplate,
} = vi.hoisted(() => ({
  mockIsAdmin: vi.fn(),
  mockGenerateAdminToken: vi.fn(),
  mockVerifyAdminToken: vi.fn(),
  mockGeneratePreAuthToken: vi.fn(),
  mockVerifyPreAuthToken: vi.fn(),
  mockGenerateSessionToken: vi.fn(),
  mockVerifySessionToken: vi.fn(),
  mockSendEmail: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetClientIp: vi.fn(),
  mockGetTwoFactorStatus: vi.fn(),
  mockVerifyTwoFactorCode: vi.fn(),
  mockIsTwoFactorEnabled: vi.fn(),
  mockGetAdminPinStatus: vi.fn(),
  mockSetAdminPin: vi.fn(),
  mockVerifyAdminPin: vi.fn(),
  mockLogAdminLogin: vi.fn(),
  mockLogAdminActivity: vi.fn(),
  mockIsOSS: vi.fn(),
  mockVerifyAdminPassword: vi.fn(),
  mockAdminHasPassword: vi.fn(),
  mockIsFirstRun: vi.fn(),
  mockBootstrapFirstAdminWithPassword: vi.fn(),
  mockLogLoginAttempt: vi.fn(),
  mockLoadTemplate: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({
  isAdmin: mockIsAdmin,
  generateAdminToken: mockGenerateAdminToken,
  verifyAdminToken: mockVerifyAdminToken,
  generatePreAuthToken: mockGeneratePreAuthToken,
  verifyPreAuthToken: mockVerifyPreAuthToken,
  generateSessionToken: mockGenerateSessionToken,
  verifySessionToken: mockVerifySessionToken,
}));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/email/utils", () => ({
  emailLayout: ({ body }: { body: string }) => `<html>${body}</html>`,
  emailButton: (label: string, url: string) => `<a href="${url}">${label}</a>`,
  emailText: (text: string) => `<p>${text}</p>`,
  emailMuted: (text: string) => `<p class="muted">${text}</p>`,
  emailSignoff: () => "<p>signoff</p>",
  plainTextFooter: () => "\nfooter",
}));
vi.mock("@/lib/email/template-loader", () => ({
  loadTemplate: mockLoadTemplate,
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: mockRateLimit,
  getClientIp: mockGetClientIp,
}));
vi.mock("@/lib/two-factor", () => ({
  getTwoFactorStatus: mockGetTwoFactorStatus,
  verifyTwoFactorCode: mockVerifyTwoFactorCode,
  isTwoFactorEnabled: mockIsTwoFactorEnabled,
}));
vi.mock("@/lib/admin-pin", () => ({
  getAdminPinStatus: mockGetAdminPinStatus,
  setAdminPin: mockSetAdminPin,
  verifyAdminPin: mockVerifyAdminPin,
}));
vi.mock("@/lib/admin-activity", () => ({
  logAdminLogin: mockLogAdminLogin,
  logAdminActivity: mockLogAdminActivity,
}));
vi.mock("@/lib/branding", () => ({ getBrandName: () => "Packet" }));
vi.mock("@/lib/edition", () => ({ isOSS: mockIsOSS }));
vi.mock("@/lib/auth/admin", () => ({
  verifyAdminPassword: mockVerifyAdminPassword,
  adminHasPassword: mockAdminHasPassword,
  isFirstRun: mockIsFirstRun,
  bootstrapFirstAdminWithPassword: mockBootstrapFirstAdminWithPassword,
}));
vi.mock("@/lib/auth/login-log", () => ({
  logLoginAttempt: mockLogLoginAttempt,
}));

import { NextRequest } from "next/server";
import { POST, GET, DELETE } from "@/app/api/admin/auth/route";

const ADMIN_EMAIL = "admin@example.com";
const SESSION_TOKEN = "session-token-abc";

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "vitest" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeGet(sessionCookie?: string): NextRequest {
  const headers = new Headers();
  if (sessionCookie !== undefined) {
    headers.set("cookie", `admin_session=${sessionCookie}`);
  }
  return new NextRequest("http://localhost/api/admin/auth", {
    method: "GET",
    headers,
  });
}

/** Assert the response carries a freshly minted admin_session cookie. */
function expectSessionCookie(res: Response) {
  const cookie = (res as import("next/server").NextResponse).cookies.get(
    "admin_session"
  );
  expect(cookie?.value).toBe(SESSION_TOKEN);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("lax");
  expect(cookie?.maxAge).toBe(60 * 60 * 4);
}

/** Assert the response did NOT set a session cookie (intermediate step). */
function expectNoSessionCookie(res: Response) {
  const cookie = (res as import("next/server").NextResponse).cookies.get(
    "admin_session"
  );
  expect(cookie).toBeUndefined();
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: Pro edition, rate limit open, happy-path helpers.
  mockIsOSS.mockReturnValue(false);
  mockRateLimit.mockReturnValue({ success: true });
  mockGetClientIp.mockReturnValue("10.0.0.1");
  mockIsAdmin.mockReturnValue(true);
  mockGenerateSessionToken.mockReturnValue(SESSION_TOKEN);
  mockGenerateAdminToken.mockReturnValue("magic-link-token");
  mockGeneratePreAuthToken.mockReturnValue("pre-auth-token");
  mockVerifyAdminToken.mockReturnValue(null);
  mockVerifyPreAuthToken.mockReturnValue(null);
  mockVerifySessionToken.mockReturnValue(null);
  mockIsFirstRun.mockReturnValue(false);
  mockAdminHasPassword.mockReturnValue(true);
  mockVerifyAdminPassword.mockResolvedValue(false);
  mockBootstrapFirstAdminWithPassword.mockResolvedValue(true);
  mockIsTwoFactorEnabled.mockResolvedValue(false);
  mockGetTwoFactorStatus.mockResolvedValue({ enabled: false });
  mockVerifyTwoFactorCode.mockResolvedValue({ success: true });
  mockGetAdminPinStatus.mockResolvedValue({ hasPin: true, expired: false });
  mockSetAdminPin.mockResolvedValue({ success: true });
  mockVerifyAdminPin.mockResolvedValue({ success: true });
  mockLogAdminLogin.mockResolvedValue(undefined);
  mockLogAdminActivity.mockResolvedValue(undefined);
  mockSendEmail.mockResolvedValue(undefined);
  // loadTemplate echoes its fallback so the route's email path is exercised.
  mockLoadTemplate.mockImplementation(
    async (_name: string, _vars: unknown, fallback: unknown) => fallback
  );
});

describe("POST /api/admin/auth — rate limiting", () => {
  it("returns 429 before evaluating any credentials", async () => {
    mockRateLimit.mockReturnValue({ success: false });

    const res = await POST(makePost({ email: ADMIN_EMAIL, password: "hunter22" }));

    expect(res.status).toBe(429);
    // Nothing downstream may run on a rate-limited request.
    expect(mockVerifyAdminPassword).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("keys the rate limit on the client IP", async () => {
    mockGetClientIp.mockReturnValue("203.0.113.9");

    await POST(makePost({ email: ADMIN_EMAIL }));

    expect(mockRateLimit).toHaveBeenCalledWith(
      "admin-auth:203.0.113.9",
      expect.objectContaining({ maxRequests: 5, windowMs: 300000 })
    );
  });
});

describe("POST /api/admin/auth — OSS password login", () => {
  beforeEach(() => {
    mockIsOSS.mockReturnValue(true);
  });

  it("returns 400 when email is missing", async () => {
    const res = await POST(makePost({ password: "irrelevant1" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Email is required");
  });

  describe("first run (no admin exists yet)", () => {
    beforeEach(() => {
      mockIsFirstRun.mockReturnValue(true);
    });

    it("returns setup mode when no password supplied yet", async () => {
      const res = await POST(makePost({ email: ADMIN_EMAIL }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe("setup");
      expectNoSessionCookie(res);
    });

    it("rejects passwords shorter than 8 characters", async () => {
      const res = await POST(makePost({ email: ADMIN_EMAIL, password: "short1" }));

      expect(res.status).toBe(400);
      expect(mockBootstrapFirstAdminWithPassword).not.toHaveBeenCalled();
    });

    it("bootstraps the first admin and issues a session", async () => {
      const res = await POST(
        makePost({ email: ADMIN_EMAIL, password: "longenough1" })
      );

      expect(res.status).toBe(200);
      expect(mockBootstrapFirstAdminWithPassword).toHaveBeenCalledWith(
        ADMIN_EMAIL,
        "longenough1"
      );
      expectSessionCookie(res);
      expect(mockLogAdminLogin).toHaveBeenCalledWith(ADMIN_EMAIL);
    });

    it("returns 500 when bootstrap fails", async () => {
      mockBootstrapFirstAdminWithPassword.mockResolvedValue(false);

      const res = await POST(
        makePost({ email: ADMIN_EMAIL, password: "longenough1" })
      );

      expect(res.status).toBe(500);
      expectNoSessionCookie(res);
    });
  });

  it("returns 400 when password is missing (not first run)", async () => {
    const res = await POST(makePost({ email: ADMIN_EMAIL }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Email and password are required");
  });

  it("returns the same generic 401 for an unknown email", async () => {
    mockIsAdmin.mockReturnValue(false);

    const res = await POST(makePost({ email: "nobody@example.com", password: "whatever1" }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid email or password");
    // Must not even attempt password verification for unknown accounts.
    expect(mockVerifyAdminPassword).not.toHaveBeenCalled();
  });

  it("returns the same generic 401 for an admin with no password set", async () => {
    mockAdminHasPassword.mockReturnValue(false);

    const res = await POST(makePost({ email: ADMIN_EMAIL, password: "whatever1" }));

    expect(res.status).toBe(401);
    // Identical message to unknown-email — no account-state leakage.
    expect((await res.json()).error).toBe("Invalid email or password");
  });

  it("returns the same generic 401 for a wrong password", async () => {
    mockVerifyAdminPassword.mockResolvedValue(false);

    const res = await POST(makePost({ email: ADMIN_EMAIL, password: "wrongpass1" }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid email or password");
    expect(mockLogLoginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, reason: "invalid-password" })
    );
  });

  it("issues a session on valid password without 2FA", async () => {
    mockVerifyAdminPassword.mockResolvedValue(true);

    const res = await POST(makePost({ email: ADMIN_EMAIL, password: "correct-horse1" }));

    expect(res.status).toBe(200);
    expectSessionCookie(res);
    expect(mockLogLoginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, method: "password" })
    );
  });

  it("returns a pre-auth token (and NO session) when 2FA is enabled", async () => {
    mockVerifyAdminPassword.mockResolvedValue(true);
    mockIsTwoFactorEnabled.mockResolvedValue(true);

    const res = await POST(makePost({ email: ADMIN_EMAIL, password: "correct-horse1" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresTwoFactor).toBe(true);
    expect(body.token).toBe("pre-auth-token");
    // The password alone must never mint a session when 2FA is on.
    expectNoSessionCookie(res);
  });
});

describe("POST /api/admin/auth — pre-auth token (OSS password + 2FA step 2)", () => {
  beforeEach(() => {
    mockVerifyPreAuthToken.mockReturnValue({ email: ADMIN_EMAIL });
  });

  it("returns 403 when the pre-auth email is no longer an admin", async () => {
    mockIsAdmin.mockReturnValue(false);

    const res = await POST(makePost({ token: "pre-auth-token" }));

    expect(res.status).toBe(403);
  });

  it("asks for the TOTP code when none is supplied", async () => {
    const res = await POST(makePost({ token: "pre-auth-token" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresTwoFactor).toBe(true);
    expect(body.email).toBe(ADMIN_EMAIL);
    expectNoSessionCookie(res);
  });

  it("returns 400 on an invalid TOTP code", async () => {
    mockVerifyTwoFactorCode.mockResolvedValue({ success: false, error: "Invalid code" });

    const res = await POST(makePost({ token: "pre-auth-token", twoFactorCode: "000000" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid code");
    expectNoSessionCookie(res);
  });

  it("issues a session on a valid TOTP code", async () => {
    const res = await POST(makePost({ token: "pre-auth-token", twoFactorCode: "123456" }));

    expect(res.status).toBe(200);
    expect(mockVerifyTwoFactorCode).toHaveBeenCalledWith(ADMIN_EMAIL, "123456");
    expectSessionCookie(res);
  });
});

describe("POST /api/admin/auth — magic-link verification (Pro)", () => {
  beforeEach(() => {
    mockVerifyAdminToken.mockReturnValue({ email: ADMIN_EMAIL });
  });

  it("returns 401 for an invalid or expired token", async () => {
    mockVerifyAdminToken.mockReturnValue(null);

    const res = await POST(makePost({ token: "expired-token" }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid or expired link");
  });

  it("returns 403 when the token's email is not an admin", async () => {
    mockIsAdmin.mockReturnValue(false);

    const res = await POST(makePost({ token: "valid-token" }));

    expect(res.status).toBe(403);
  });

  describe("with TOTP enabled", () => {
    beforeEach(() => {
      mockGetTwoFactorStatus.mockResolvedValue({ enabled: true });
    });

    it("asks for the code when none supplied", async () => {
      const res = await POST(makePost({ token: "valid-token" }));

      const body = await res.json();
      expect(body.requiresTwoFactor).toBe(true);
      expectNoSessionCookie(res);
    });

    it("returns 400 on a bad code", async () => {
      mockVerifyTwoFactorCode.mockResolvedValue({ success: false });

      const res = await POST(makePost({ token: "valid-token", twoFactorCode: "999999" }));

      expect(res.status).toBe(400);
      expectNoSessionCookie(res);
    });

    it("issues a session on a good code", async () => {
      const res = await POST(makePost({ token: "valid-token", twoFactorCode: "123456" }));

      expect(res.status).toBe(200);
      expectSessionCookie(res);
    });
  });

  describe("PIN second factor (no TOTP)", () => {
    it("requests PIN setup when no PIN exists", async () => {
      mockGetAdminPinStatus.mockResolvedValue({ hasPin: false, expired: false });

      const res = await POST(makePost({ token: "valid-token" }));

      const body = await res.json();
      expect(body.requiresPin).toBe(true);
      expect(body.pinSetup).toBe(true);
      expect(body.pinExpired).toBe(false);
      expectNoSessionCookie(res);
    });

    it("sets a new PIN and issues a session in one round-trip", async () => {
      mockGetAdminPinStatus.mockResolvedValue({ hasPin: false, expired: false });

      const res = await POST(makePost({ token: "valid-token", newPin: "246810" }));

      expect(res.status).toBe(200);
      expect(mockSetAdminPin).toHaveBeenCalledWith(ADMIN_EMAIL, "246810");
      expect(mockLogAdminActivity).toHaveBeenCalledWith(
        ADMIN_EMAIL,
        "admin_pin_set",
        expect.any(String)
      );
      expectSessionCookie(res);
    });

    it("returns 400 when the new PIN is rejected", async () => {
      mockGetAdminPinStatus.mockResolvedValue({ hasPin: false, expired: false });
      mockSetAdminPin.mockResolvedValue({ success: false, error: "PIN too weak" });

      const res = await POST(makePost({ token: "valid-token", newPin: "111111" }));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("PIN too weak");
      expectNoSessionCookie(res);
    });

    it("requests the PIN when one exists but none was supplied", async () => {
      const res = await POST(makePost({ token: "valid-token" }));

      const body = await res.json();
      expect(body.requiresPin).toBe(true);
      expect(body.pinSetup).toBe(false);
      expectNoSessionCookie(res);
    });

    it("returns 400 on a wrong PIN", async () => {
      mockVerifyAdminPin.mockResolvedValue({ success: false, error: "Invalid PIN" });

      const res = await POST(makePost({ token: "valid-token", pinCode: "000000" }));

      expect(res.status).toBe(400);
      expectNoSessionCookie(res);
    });

    it("switches the client to PIN re-setup when the PIN expired mid-verify", async () => {
      mockVerifyAdminPin.mockResolvedValue({
        success: false,
        expired: true,
        error: "PIN expired",
      });

      const res = await POST(makePost({ token: "valid-token", pinCode: "123456" }));

      // Deliberately 200 — the client must transition to setup, not show an error.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.requiresPin).toBe(true);
      expect(body.pinSetup).toBe(true);
      expect(body.pinExpired).toBe(true);
      expectNoSessionCookie(res);
    });

    it("issues a session on a correct PIN", async () => {
      const res = await POST(makePost({ token: "valid-token", pinCode: "135790" }));

      expect(res.status).toBe(200);
      expect(mockVerifyAdminPin).toHaveBeenCalledWith(ADMIN_EMAIL, "135790");
      expectSessionCookie(res);
      expect(mockLogLoginAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, method: "magic-link" })
      );
    });
  });
});

describe("POST /api/admin/auth — magic-link send (Pro)", () => {
  it("returns 400 when neither token nor email is supplied", async () => {
    const res = await POST(makePost({}));

    expect(res.status).toBe(400);
  });

  it("returns identical success for non-admins WITHOUT sending email (enumeration prevention)", async () => {
    mockIsAdmin.mockReturnValue(false);

    const res = await POST(makePost({ email: "stranger@example.com" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("If you're an admin");
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockGenerateAdminToken).not.toHaveBeenCalled();
  });

  it("sends a login link to admins with the same response body", async () => {
    const res = await POST(makePost({ email: ADMIN_EMAIL }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Same message as the non-admin case — responses must be indistinguishable.
    expect(body.message).toContain("If you're an admin");
    expect(mockGenerateAdminToken).toHaveBeenCalledWith(ADMIN_EMAIL);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ADMIN_EMAIL })
    );
  });

  it("returns 503 when email delivery fails (so the client can retry)", async () => {
    mockSendEmail.mockRejectedValue(new Error("smtp down"));

    const res = await POST(makePost({ email: ADMIN_EMAIL }));

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Email delivery failed");
  });

  it("returns 500 on a malformed (non-JSON) body", async () => {
    const res = await POST(makePost("this is not json"));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to process request");
  });
});

describe("GET /api/admin/auth — session check", () => {
  it("returns 401 with no extras in Pro mode when no cookie is present", async () => {
    const res = await GET(makeGet());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
    expect(body.loginMode).toBeUndefined();
  });

  it("tells OSS clients to use password login when no cookie is present", async () => {
    mockIsOSS.mockReturnValue(true);
    mockIsFirstRun.mockReturnValue(true);

    const res = await GET(makeGet());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.loginMode).toBe("password");
    expect(body.isFirstRun).toBe(true);
  });

  it("returns 401 and clears the cookie when the session token is invalid", async () => {
    mockVerifySessionToken.mockReturnValue(null);

    const res = await GET(makeGet("tampered-token"));

    expect(res.status).toBe(401);
    // The invalid cookie must be deleted (set to empty) so the client stops sending it.
    const cookie = (res as import("next/server").NextResponse).cookies.get(
      "admin_session"
    );
    expect(cookie?.value).toBe("");
  });

  it("returns the session email for a valid token", async () => {
    mockVerifySessionToken.mockReturnValue({ email: ADMIN_EMAIL });

    const res = await GET(makeGet("valid-session-token"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.email).toBe(ADMIN_EMAIL);
  });
});

describe("DELETE /api/admin/auth — logout", () => {
  it("clears the session cookie and returns success", async () => {
    const res = await DELETE(makeGet("any-token"));

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    const cookie = (res as import("next/server").NextResponse).cookies.get(
      "admin_session"
    );
    expect(cookie?.value).toBe("");
  });
});
