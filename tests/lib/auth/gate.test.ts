// Regression suite for src/lib/auth/gate.ts.
//
// PA-230 background (2026-05-23): the /api/services route hardcoded
// `customerEmail: null` when calling gatePermission(). The gate itself behaved
// correctly given its inputs — `resolveMembership` returns null when no DB row
// exists AND customerEmail is missing, so the gate returns 403. The bug was in
// the caller. ~1140 implicit-Owner customers (legacy accounts with no
// team_memberships row) got 403'd for 58 hours.
//
// This suite pins two contracts at the gate layer:
//   1. The four-quadrant matrix {userId, email-only} × {customerEmail
//      present-matching, null} — so any refactor that drops the implicit-owner
//      path or changes the deny semantics fails loudly.
//   2. The specific PA-230 scenario: customerEmail=null + no membership row
//      MUST return 403. This locks in that the gate trusts its caller; the
//      regression test that PA-230 should have failed lives one layer up at
//      the route, not here. We document the boundary so the next caller knows.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTeamMembershipFindUnique, mockUserFindUnique, mockAuditCreate } =
  vi.hoisted(() => ({
    mockTeamMembershipFindUnique: vi.fn(),
    mockUserFindUnique: vi.fn(),
    mockAuditCreate: vi.fn().mockResolvedValue({}),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMembership: { findUnique: mockTeamMembershipFindUnique },
    user: { findUnique: mockUserFindUnique },
    teamAuditLog: { create: mockAuditCreate },
  },
}));

import { gatePermission } from "@/lib/auth/gate";
import type { CustomerTokenPayload } from "@/lib/auth/customer";

const EMAIL = "alice@example.com";
const USER_ID = "user_alice";
const ACCOUNT_ID = "cus_alice123";

function payload(overrides: Partial<CustomerTokenPayload> = {}): CustomerTokenPayload {
  return {
    customerId: ACCOUNT_ID,
    email: EMAIL,
    userId: USER_ID,
    skipTwoFactor: false,
    ...overrides,
  } as CustomerTokenPayload;
}

describe("gatePermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditCreate.mockResolvedValue({});
  });

  describe("happy paths (allow)", () => {
    it("allows when the membership row grants the permission", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: USER_ID,
        role: "teamAdmin",
        isOwner: false,
        revokedAt: null,
      });

      const res = await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "billing.manage",
      });

      expect(res).toBeNull();
    });

    it("allows via is_owner short-circuit even when the role would deny", async () => {
      // financeManager normally has no gpu.provision, but is_owner=true must override.
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: USER_ID,
        role: "financeManager",
        isOwner: true,
        revokedAt: null,
      });

      const res = await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "gpu.provision",
      });

      expect(res).toBeNull();
    });
  });

  describe("deny paths (403)", () => {
    it("returns 403 with reason=no_membership when no row exists and customerEmail is null (PA-230 boundary)", async () => {
      // This is the EXACT shape PA-230 hit: caller passed null for customerEmail,
      // no membership row exists, so the implicit-owner fallback can't fire.
      // The gate behaves correctly here — the fix is at the caller.
      mockTeamMembershipFindUnique.mockResolvedValue(null);
      mockUserFindUnique.mockResolvedValue(null);

      const res = await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: null,
        permission: "billing.view",
      });

      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
      const body = await res!.json();
      expect(body.error).toContain("do not have access");
    });

    it("returns 403 when no row exists and customerEmail does NOT match (intruder)", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue(null);
      mockUserFindUnique.mockResolvedValue(null);

      const res = await gatePermission({
        payload: payload({ email: "intruder@example.com" }),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "billing.view",
      });

      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
    });

    it("returns 403 with reason=revoked when membership is revoked", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: USER_ID,
        role: "teamAdmin",
        isOwner: true,
        revokedAt: new Date("2026-05-01T00:00:00Z"),
      });

      const res = await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "billing.view",
      });

      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
      const body = await res!.json();
      expect(body.error).toContain("revoked");
    });

    it("returns 403 when role lacks the permission", async () => {
      // financeManager has no gpu.provision, no is_owner override.
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: USER_ID,
        role: "financeManager",
        isOwner: false,
        revokedAt: null,
      });

      const res = await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "gpu.provision",
      });

      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
      const body = await res!.json();
      expect(body.permission).toBe("gpu.provision");
      expect(body.role).toBe("financeManager");
      expect(body.isOwner).toBe(false);
    });

    it("returns 403 when readOnlyMember tries to provision (PA-201 matrix)", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: USER_ID,
        role: "readOnlyMember",
        isOwner: false,
        revokedAt: null,
      });

      const res = await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "gpu.provision",
      });

      expect(res!.status).toBe(403);
    });

    it("returns 403 when team Member tries to view billing (PA-201 matrix)", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: USER_ID,
        role: "member",
        isOwner: false,
        revokedAt: null,
      });

      const res = await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "billing.view",
      });

      expect(res!.status).toBe(403);
    });
  });

  describe("implicit-owner fallback (PA-230 happy case)", () => {
    it("allows when no row exists but JWT email matches customerEmail", async () => {
      // The path PA-230 broke: legacy customers with no membership row whose
      // email matches the Stripe customer.email. Must be granted teamAdmin+Owner.
      mockTeamMembershipFindUnique.mockResolvedValue(null);
      mockUserFindUnique.mockResolvedValue(null);

      const res = await gatePermission({
        payload: payload({ userId: undefined }),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "billing.view",
      });

      expect(res).toBeNull();
    });

    it("allows implicit owner across all sensitive permissions", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue(null);
      mockUserFindUnique.mockResolvedValue(null);

      const perms = [
        "gpu.provision",
        "gpu.terminate",
        "billing.manage",
        "team.invite",
        "team.manage",
        "api_keys.create",
        "ssh_keys.manage",
      ] as const;

      for (const permission of perms) {
        const res = await gatePermission({
          payload: payload({ userId: undefined }),
          accountId: ACCOUNT_ID,
          customerEmail: EMAIL,
          permission,
        });
        expect(res, `implicit owner should be allowed for ${permission}`).toBeNull();
      }
    });

    it("matches case-insensitively (JWT alice@ vs Stripe Alice@)", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue(null);
      mockUserFindUnique.mockResolvedValue(null);

      const res = await gatePermission({
        payload: payload({ userId: undefined, email: "alice@example.com" }),
        accountId: ACCOUNT_ID,
        customerEmail: "Alice@Example.COM",
        permission: "billing.view",
      });

      expect(res).toBeNull();
    });
  });

  describe("the four-quadrant matrix {userId, email-only} × {customerEmail present, null}", () => {
    // Locks in PA-230's contract surface so callers can reason about it.

    it("userId path + customerEmail present + matching → membership lookup wins", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: USER_ID,
        role: "member",
        isOwner: false,
        revokedAt: null,
      });

      const res = await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "gpu.provision",
      });

      expect(res).toBeNull();
      expect(mockUserFindUnique).not.toHaveBeenCalled(); // userId path
    });

    it("userId path + customerEmail null + row exists → still allows from row", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue({
        id: "tm_1",
        userId: USER_ID,
        role: "teamAdmin",
        isOwner: false,
        revokedAt: null,
      });

      const res = await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: null,
        permission: "team.manage",
      });

      // customerEmail=null doesn't matter when the row exists.
      expect(res).toBeNull();
    });

    it("userId path + customerEmail null + no row → 403 (PA-230 shape, gate is correct, caller is wrong)", async () => {
      mockTeamMembershipFindUnique.mockResolvedValue(null);

      const res = await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: null,
        permission: "billing.view",
      });

      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
    });

    it("email-only path + customerEmail present + matching + no row → implicit owner ALLOW", async () => {
      mockUserFindUnique.mockResolvedValue(null);

      const res = await gatePermission({
        payload: payload({ userId: undefined }),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "billing.view",
      });

      expect(res).toBeNull();
    });

    it("email-only path + customerEmail null + no row → 403 (the PA-230 incident scenario)", async () => {
      // This is the exact production incident shape: legacy JWT with email only,
      // caller hardcoded customerEmail=null, no membership row → 403 for 1140
      // implicit owners.
      mockUserFindUnique.mockResolvedValue(null);

      const res = await gatePermission({
        payload: payload({ userId: undefined }),
        accountId: ACCOUNT_ID,
        customerEmail: null,
        permission: "billing.view",
      });

      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
    });
  });

  describe("audit logging", () => {
    it("records a permission decision on every code path (allow, deny, revoked, no-membership)", async () => {
      // Allow path
      mockTeamMembershipFindUnique.mockResolvedValueOnce({
        id: "tm_1",
        userId: USER_ID,
        role: "teamAdmin",
        isOwner: true,
        revokedAt: null,
      });
      await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "billing.manage",
      });

      // Deny: revoked
      mockTeamMembershipFindUnique.mockResolvedValueOnce({
        id: "tm_2",
        userId: USER_ID,
        role: "teamAdmin",
        isOwner: false,
        revokedAt: new Date(),
      });
      await gatePermission({
        payload: payload(),
        accountId: ACCOUNT_ID,
        customerEmail: EMAIL,
        permission: "billing.manage",
      });

      // Deny: no membership
      mockTeamMembershipFindUnique.mockResolvedValueOnce(null);
      mockUserFindUnique.mockResolvedValueOnce(null);
      await gatePermission({
        payload: payload({ userId: undefined }),
        accountId: ACCOUNT_ID,
        customerEmail: null,
        permission: "billing.manage",
      });

      // Audit is fire-and-forget, so we wait a tick.
      await new Promise((r) => setImmediate(r));

      // Sensitive permission (billing.manage) → logged on every call.
      expect(mockAuditCreate.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });
});
