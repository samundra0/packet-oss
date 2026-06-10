// PA-225 — Invite form regression tests.
//
// Bug: a name longer than 255 chars hit the VarChar(255) constraint on
// team_invitation.invitee_name, Prisma threw, the route did not catch it,
// and the client surfaced "Unexpected end of JSON input" because the 500
// response body wasn't JSON. The fix is server-side length validation that
// returns a clean 400 JSON error before we touch the DB.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { AuthenticatedCustomer } from "@/lib/auth/helpers";

const {
  mockGetAuthenticatedCustomer,
  mockRequirePermission,
  mockUserFindUnique,
  mockMembershipFindUnique,
  mockInvitationUpsert,
  mockAuditCreate,
  mockSendInviteEmail,
} = vi.hoisted(() => ({
  mockGetAuthenticatedCustomer: vi.fn(),
  mockRequirePermission: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockMembershipFindUnique: vi.fn(),
  mockInvitationUpsert: vi.fn(),
  mockAuditCreate: vi.fn(),
  mockSendInviteEmail: vi.fn(),
}));

vi.mock("@/lib/auth/helpers", () => ({
  getAuthenticatedCustomer: (...args: unknown[]) =>
    mockGetAuthenticatedCustomer(...args),
}));

vi.mock("@/lib/auth/audit", () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
}));

vi.mock("@/lib/auth/membership", () => ({
  materializeImplicitOwner: vi.fn().mockResolvedValue({ userId: "user_alice" }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => mockUserFindUnique(...args) },
    teamMembership: {
      findUnique: (...args: unknown[]) => mockMembershipFindUnique(...args),
    },
    teamInvitation: {
      upsert: (...args: unknown[]) => mockInvitationUpsert(...args),
    },
    teamAuditLog: {
      create: (...args: unknown[]) => mockAuditCreate(...args),
    },
  },
}));

vi.mock("@/lib/email/templates/team-invite", () => ({
  sendTeamInviteEmail: (...args: unknown[]) => mockSendInviteEmail(...args),
}));

import { POST } from "@/app/api/accounts/[accountId]/invitations/route";

function makeAuth(): AuthenticatedCustomer {
  return {
    payload: { email: "owner@example.com" } as never,
    customer: { email: "owner@example.com", name: "Owner" } as never,
    teamId: undefined,
    allTeamIds: [],
    stripe: {} as never,
    accountId: "cus_test",
    membership: {
      membershipId: "tm_owner",
      userId: "user_alice",
      accountId: "cus_test",
      role: "teamAdmin" as never,
      isOwner: true,
      revokedAt: null,
      isImplicit: false,
    },
    can: () => true,
  };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/accounts/cus_test/invitations", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer x" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ accountId: "cus_test" });

describe("POST /api/accounts/[accountId]/invitations — PA-225", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthenticatedCustomer.mockResolvedValue(makeAuth());
    mockRequirePermission.mockReturnValue(null);
    mockUserFindUnique.mockResolvedValue(null);
    mockMembershipFindUnique.mockResolvedValue(null);
    mockInvitationUpsert.mockResolvedValue({
      id: "inv_1",
      email: "new@example.com",
      role: "readOnlyMember",
      token: "deadbeef",
      expiresAt: new Date("2099-01-01"),
    });
    mockAuditCreate.mockResolvedValue({});
    mockSendInviteEmail.mockResolvedValue(undefined);
  });

  it("returns 400 JSON (not a 500/empty body) when inviteeName is longer than the DB column allows", async () => {
    const longName = "Read Only ".repeat(50); // 500 chars — exceeds VarChar(255)
    const response = await POST(makeRequest({
      email: "new@example.com",
      role: "readOnlyMember",
      inviteeName: longName,
    }), { params });

    expect(response.status).toBe(400);
    // The headline assertion: the response body MUST be parseable JSON.
    // Pre-fix, this throws because the response was a 500 with HTML/empty body.
    const body = await response.json();
    expect(body.error).toMatch(/name/i);
    // And the DB was never hit (validation short-circuits before upsert).
    expect(mockInvitationUpsert).not.toHaveBeenCalled();
  });

  it("accepts a normal-length name", async () => {
    const response = await POST(makeRequest({
      email: "new@example.com",
      role: "readOnlyMember",
      inviteeName: "Olga Kovalova",
    }), { params });

    expect(response.status).toBe(200);
    expect(mockInvitationUpsert).toHaveBeenCalledOnce();
  });

  it("accepts an empty/omitted inviteeName", async () => {
    const response = await POST(makeRequest({
      email: "new@example.com",
      role: "readOnlyMember",
    }), { params });

    expect(response.status).toBe(200);
    expect(mockInvitationUpsert).toHaveBeenCalledOnce();
  });
});
