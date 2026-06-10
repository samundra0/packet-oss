// Tests for src/app/api/admin/auth/setup/route.ts — invite-token claim flow.
//
// GET validates an invite token (the setup page calls this to prefill the
// email); POST claims it: validate → set password → mark token used → mint
// an admin_session.
//
// What this suite protects:
//   * An invite token must be single-use: the route must call
//     markInviteTokenUsed only after the password was actually set.
//   * All password validation (presence, length, match) happens BEFORE the
//     token is validated or consumed — a bad form must not burn the invite.
//   * The session cookie is only set on full success.

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockIsAdmin,
  mockGenerateSessionToken,
  mockSetAdminPassword,
  mockValidateInviteToken,
  mockMarkInviteTokenUsed,
  mockLogAdminLogin,
  mockRateLimit,
  mockGetClientIp,
} = vi.hoisted(() => ({
  mockIsAdmin: vi.fn(),
  mockGenerateSessionToken: vi.fn(),
  mockSetAdminPassword: vi.fn(),
  mockValidateInviteToken: vi.fn(),
  mockMarkInviteTokenUsed: vi.fn(),
  mockLogAdminLogin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetClientIp: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({
  isAdmin: mockIsAdmin,
  generateSessionToken: mockGenerateSessionToken,
}));
vi.mock("@/lib/auth/admin", () => ({
  setAdminPassword: mockSetAdminPassword,
}));
vi.mock("@/lib/auth/invite-tokens", () => ({
  validateInviteToken: mockValidateInviteToken,
  markInviteTokenUsed: mockMarkInviteTokenUsed,
}));
vi.mock("@/lib/admin-activity", () => ({
  logAdminLogin: mockLogAdminLogin,
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: mockRateLimit,
  getClientIp: mockGetClientIp,
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/admin/auth/setup/route";

const ADMIN_EMAIL = "new-admin@example.com";
const INVITE = "invite-token-xyz";

function makeGet(invite?: string): NextRequest {
  const url = invite
    ? `http://localhost/api/admin/auth/setup?invite=${encodeURIComponent(invite)}`
    : "http://localhost/api/admin/auth/setup";
  return new NextRequest(url, { method: "GET" });
}

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ success: true });
  mockGetClientIp.mockReturnValue("10.0.0.1");
  mockIsAdmin.mockReturnValue(true);
  mockGenerateSessionToken.mockReturnValue("setup-session-token");
  mockSetAdminPassword.mockResolvedValue(true);
  mockValidateInviteToken.mockReturnValue({ valid: true, email: ADMIN_EMAIL });
  mockLogAdminLogin.mockResolvedValue(undefined);
});

describe("GET /api/admin/auth/setup — invite validation", () => {
  it("returns 429 when rate limited", async () => {
    mockRateLimit.mockReturnValue({ success: false });

    const res = await GET(makeGet(INVITE));

    expect(res.status).toBe(429);
    expect(mockValidateInviteToken).not.toHaveBeenCalled();
  });

  it("returns 400 when the invite param is missing", async () => {
    const res = await GET(makeGet());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Missing invite token");
  });

  it("returns 400 with the validator's error for an invalid token", async () => {
    mockValidateInviteToken.mockReturnValue({ valid: false, error: "Token expired" });

    const res = await GET(makeGet("stale-token"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.error).toBe("Token expired");
  });

  it("returns the associated email for a valid token", async () => {
    const res = await GET(makeGet(INVITE));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.email).toBe(ADMIN_EMAIL);
  });
});

describe("POST /api/admin/auth/setup — claim invite", () => {
  const validBody = {
    invite: INVITE,
    password: "longenough1",
    confirmPassword: "longenough1",
  };

  it("returns 429 when rate limited", async () => {
    mockRateLimit.mockReturnValue({ success: false });

    const res = await POST(makePost(validBody));

    expect(res.status).toBe(429);
    expect(mockSetAdminPassword).not.toHaveBeenCalled();
  });

  it.each([
    ["missing invite", { password: "longenough1", confirmPassword: "longenough1" }, "Missing invite token"],
    ["missing password", { invite: INVITE, confirmPassword: "longenough1" }, "Password and confirmation are required"],
    ["missing confirmation", { invite: INVITE, password: "longenough1" }, "Password and confirmation are required"],
    ["short password", { invite: INVITE, password: "short1", confirmPassword: "short1" }, "Password must be at least 8 characters"],
    ["mismatched passwords", { invite: INVITE, password: "longenough1", confirmPassword: "different1" }, "Passwords do not match"],
  ])("returns 400 for %s without consuming the invite", async (_label, body, error) => {
    const res = await POST(makePost(body));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    // Form errors must never validate or burn the token.
    expect(mockValidateInviteToken).not.toHaveBeenCalled();
    expect(mockMarkInviteTokenUsed).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid invite token", async () => {
    mockValidateInviteToken.mockReturnValue({ valid: false, error: "Token already used" });

    const res = await POST(makePost(validBody));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Token already used");
    expect(mockSetAdminPassword).not.toHaveBeenCalled();
  });

  it("returns 404 when the admin record no longer exists", async () => {
    mockIsAdmin.mockReturnValue(false);

    const res = await POST(makePost(validBody));

    expect(res.status).toBe(404);
    expect(mockSetAdminPassword).not.toHaveBeenCalled();
    expect(mockMarkInviteTokenUsed).not.toHaveBeenCalled();
  });

  it("returns 500 (token NOT consumed) when setting the password fails", async () => {
    mockSetAdminPassword.mockResolvedValue(false);

    const res = await POST(makePost(validBody));

    expect(res.status).toBe(500);
    // The invite must stay claimable so the user can retry.
    expect(mockMarkInviteTokenUsed).not.toHaveBeenCalled();
  });

  it("sets the password, consumes the token, and mints a session on success", async () => {
    const res = await POST(makePost(validBody));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.email).toBe(ADMIN_EMAIL);

    expect(mockSetAdminPassword).toHaveBeenCalledWith(ADMIN_EMAIL, "longenough1");
    expect(mockMarkInviteTokenUsed).toHaveBeenCalledWith(INVITE);
    expect(mockLogAdminLogin).toHaveBeenCalledWith(ADMIN_EMAIL);

    const cookie = (res as import("next/server").NextResponse).cookies.get(
      "admin_session"
    );
    expect(cookie?.value).toBe("setup-session-token");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.maxAge).toBe(60 * 60 * 4);
  });

  it("returns 500 on a malformed (non-JSON) body", async () => {
    const res = await POST(makePost("not json"));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to process setup");
  });
});
