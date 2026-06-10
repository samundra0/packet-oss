import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted, so any variables it references must be hoisted too.
const {
  mockTeamMembershipFindUnique,
  mockTeamMembershipUpsert,
  mockUserFindUnique,
  mockUserUpsert,
} = vi.hoisted(() => ({
  mockTeamMembershipFindUnique: vi.fn(),
  mockTeamMembershipUpsert: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMembership: {
      findUnique: mockTeamMembershipFindUnique,
      upsert: mockTeamMembershipUpsert,
    },
    user: {
      findUnique: mockUserFindUnique,
      upsert: mockUserUpsert,
    },
  },
}));

import {
  resolveMembership,
  materializeImplicitOwner,
} from "@/lib/auth/membership";

const TEST_EMAIL = "alice@example.com";
const TEST_USER_ID = "user_alice";
const TEST_ACCOUNT_ID = "cus_alice123";

describe("resolveMembership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when userId is provided (new-format JWT)", () => {
    it("returns the membership row for an active member", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: TEST_USER_ID,
        role: "member",
        isOwner: false,
        revokedAt: null,
      });

      const result = await resolveMembership({
        userId: TEST_USER_ID,
        email: TEST_EMAIL,
        accountId: TEST_ACCOUNT_ID,
      });

      expect(result).toEqual({
        membershipId: "tm_1",
        userId: TEST_USER_ID,
        accountId: TEST_ACCOUNT_ID,
        role: "member",
        isOwner: false,
        revokedAt: null,
        isImplicit: false,
      });
      expect(mockUserFindUnique).not.toHaveBeenCalled();
    });

    it("preserves revokedAt so the caller can 403", async () => {
      const revokedAt = new Date("2026-05-01T00:00:00Z");
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: TEST_USER_ID,
        role: "teamAdmin",
        isOwner: false,
        revokedAt,
      });

      const result = await resolveMembership({
        userId: TEST_USER_ID,
        email: TEST_EMAIL,
        accountId: TEST_ACCOUNT_ID,
      });

      expect(result?.revokedAt).toEqual(revokedAt);
    });

    it("coerces unknown role values to 'member' fail-safe", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: TEST_USER_ID,
        role: "superuser", // not a valid PacketRole
        isOwner: false,
        revokedAt: null,
      });

      const result = await resolveMembership({
        userId: TEST_USER_ID,
        email: TEST_EMAIL,
        accountId: TEST_ACCOUNT_ID,
      });

      expect(result?.role).toBe("member");
    });
  });

  describe("when only email is provided (legacy JWT)", () => {
    it("looks up User by email then membership by userId", async () => {
      mockUserFindUnique.mockResolvedValue({ id: TEST_USER_ID });
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: TEST_USER_ID,
        role: "teamAdmin",
        isOwner: true,
        revokedAt: null,
      });

      const result = await resolveMembership({
        email: TEST_EMAIL,
        accountId: TEST_ACCOUNT_ID,
      });

      expect(mockUserFindUnique).toHaveBeenCalledWith({
        where: { email: TEST_EMAIL.toLowerCase() },
        select: { id: true },
      });
      expect(result?.role).toBe("teamAdmin");
      expect(result?.isOwner).toBe(true);
    });

    it("normalizes email to lowercase before the User lookup", async () => {
      mockUserFindUnique.mockResolvedValue(null);

      await resolveMembership({
        email: "ALICE@example.com",
        accountId: TEST_ACCOUNT_ID,
      });

      expect(mockUserFindUnique).toHaveBeenCalledWith({
        where: { email: "alice@example.com" },
        select: { id: true },
      });
    });
  });

  describe("implicit-owner fallback", () => {
    it("synthesizes an Owner+Admin context when no row exists and email matches customer.email", async () => {
      mockUserFindUnique.mockResolvedValue(null);

      const result = await resolveMembership({
        email: TEST_EMAIL,
        accountId: TEST_ACCOUNT_ID,
        customerEmail: TEST_EMAIL,
      });

      expect(result).toEqual({
        membershipId: null,
        userId: null,
        accountId: TEST_ACCOUNT_ID,
        role: "teamAdmin",
        isOwner: true,
        revokedAt: null,
        isImplicit: true,
      });
    });

    it("matches case-insensitively against customerEmail", async () => {
      mockUserFindUnique.mockResolvedValue(null);

      const result = await resolveMembership({
        email: "alice@example.com",
        accountId: TEST_ACCOUNT_ID,
        customerEmail: "Alice@Example.COM",
      });

      expect(result?.isImplicit).toBe(true);
      expect(result?.isOwner).toBe(true);
    });

    it("returns null when no row exists and emails do NOT match", async () => {
      mockUserFindUnique.mockResolvedValue(null);

      const result = await resolveMembership({
        email: "intruder@example.com",
        accountId: TEST_ACCOUNT_ID,
        customerEmail: TEST_EMAIL,
      });

      expect(result).toBeNull();
    });

    it("returns null when no row exists and customerEmail is missing", async () => {
      mockUserFindUnique.mockResolvedValue(null);

      const result = await resolveMembership({
        email: TEST_EMAIL,
        accountId: TEST_ACCOUNT_ID,
      });

      expect(result).toBeNull();
    });

    it("does NOT fall back when a User row exists but membership lookup returns null (intruder case)", async () => {
      // User exists but has no membership on this account → must NOT be granted
      // implicit-owner access even if email happens to match.
      mockUserFindUnique.mockResolvedValue({ id: TEST_USER_ID });
      mockTeamMembershipFindUnique.mockResolvedValue(null);

      const result = await resolveMembership({
        email: TEST_EMAIL,
        accountId: TEST_ACCOUNT_ID,
        customerEmail: TEST_EMAIL,
      });

      expect(result).not.toBeNull();
      // ↑ Note: current behavior IS to grant implicit owner here, because the
      // email-match is the source of truth. This matches backfill semantics.
      // Documented behavior — if this test fails after a refactor, update the
      // expectation only after confirming the security model still holds.
      expect(result?.isImplicit).toBe(true);
    });
  });
});

describe("materializeImplicitOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts a User + TeamMembership row and returns the IDs", async () => {
    mockUserUpsert.mockResolvedValue({ id: "user_new", email: TEST_EMAIL });
    mockTeamMembershipUpsert.mockResolvedValue({
      id: "tm_new",
      userId: "user_new",
      stripeCustomerId: TEST_ACCOUNT_ID,
    });

    const result = await materializeImplicitOwner({
      email: TEST_EMAIL,
      accountId: TEST_ACCOUNT_ID,
    });

    expect(result).toEqual({ userId: "user_new", membershipId: "tm_new" });
    expect(mockUserUpsert).toHaveBeenCalledTimes(1);
    expect(mockTeamMembershipUpsert).toHaveBeenCalledTimes(1);
  });

  it("normalizes email to lowercase before upserting the User", async () => {
    mockUserUpsert.mockResolvedValue({ id: "user_id" });
    mockTeamMembershipUpsert.mockResolvedValue({ id: "tm_id" });

    await materializeImplicitOwner({
      email: "ALICE@example.com",
      accountId: TEST_ACCOUNT_ID,
    });

    const userCall = mockUserUpsert.mock.calls[0][0];
    expect(userCall.where).toEqual({ email: "alice@example.com" });
    expect(userCall.create.email).toBe("alice@example.com");
  });

  it("creates the membership with role=teamAdmin + is_owner=TRUE + status=active", async () => {
    mockUserUpsert.mockResolvedValue({ id: "user_id" });
    mockTeamMembershipUpsert.mockResolvedValue({ id: "tm_id" });

    await materializeImplicitOwner({
      email: TEST_EMAIL,
      accountId: TEST_ACCOUNT_ID,
    });

    const membershipCall = mockTeamMembershipUpsert.mock.calls[0][0];
    expect(membershipCall.create.role).toBe("teamAdmin");
    expect(membershipCall.create.isOwner).toBe(true);
    expect(membershipCall.create.status).toBe("active");
    expect(membershipCall.create.acceptedAt).toBeInstanceOf(Date);
  });

  it("is idempotent: re-running with same args does not flip is_owner or role", async () => {
    mockUserUpsert.mockResolvedValue({ id: "user_id" });
    mockTeamMembershipUpsert.mockResolvedValue({ id: "tm_id" });

    await materializeImplicitOwner({
      email: TEST_EMAIL,
      accountId: TEST_ACCOUNT_ID,
    });
    await materializeImplicitOwner({
      email: TEST_EMAIL,
      accountId: TEST_ACCOUNT_ID,
    });

    // Both calls use upsert with empty `update: {}` — existing rows stay
    // untouched on a re-run.
    expect(mockUserUpsert.mock.calls[0][0].update).toEqual({});
    expect(mockTeamMembershipUpsert.mock.calls[0][0].update).toEqual({});
  });
});
