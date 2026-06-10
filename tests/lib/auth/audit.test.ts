import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuditCreate } = vi.hoisted(() => ({
  mockAuditCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamAuditLog: { create: mockAuditCreate },
  },
}));

import {
  recordPermissionDecision,
  forbidden,
  requirePermission,
} from "@/lib/auth/audit";
import type { AuthenticatedCustomer } from "@/lib/auth/helpers";

function makeAuth(role: string, isOwner: boolean): AuthenticatedCustomer {
  const can = (perm: string) => {
    if (isOwner) return true;
    // tiny shim mirroring the real ROLE_PERMISSIONS for the tests
    if (role === "teamAdmin") return true;
    if (role === "member") {
      return (
        perm === "gpu.provision" ||
        perm === "gpu.terminate" ||
        perm === "gpu.access" ||
        perm === "ssh_keys.manage" ||
        perm === "api_keys.create" ||
        perm === "api_keys.revoke"
      );
    }
    if (role === "financeManager") return perm === "billing.view" || perm === "billing.manage";
    return false;
  };
  return {
    payload: {} as never,
    customer: {} as never,
    teamId: undefined,
    allTeamIds: [],
    stripe: {} as never,
    accountId: "cus_test",
    membership: {
      membershipId: "tm_1",
      userId: "user_alice",
      accountId: "cus_test",
      role: role as never,
      isOwner,
      revokedAt: null,
      isImplicit: false,
    },
    can: can as never,
  };
}

describe("recordPermissionDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditCreate.mockResolvedValue({});
  });

  it("logs both allow and deny for sensitive permissions", () => {
    recordPermissionDecision({
      accountId: "cus_test",
      actorUserId: "user_alice",
      permission: "gpu.provision",
      allowed: true,
    });
    recordPermissionDecision({
      accountId: "cus_test",
      actorUserId: "user_alice",
      permission: "gpu.provision",
      allowed: false,
    });

    expect(mockAuditCreate).toHaveBeenCalledTimes(2);
    expect(mockAuditCreate.mock.calls[0][0].data.action).toBe(
      "permission.allowed.gpu.provision",
    );
    expect(mockAuditCreate.mock.calls[1][0].data.action).toBe(
      "permission.denied.gpu.provision",
    );
  });

  it("logs deny but skips allow for billing.view", () => {
    recordPermissionDecision({
      accountId: "cus_test",
      actorUserId: "user_alice",
      permission: "billing.view",
      allowed: true,
    });
    expect(mockAuditCreate).not.toHaveBeenCalled();

    recordPermissionDecision({
      accountId: "cus_test",
      actorUserId: "user_alice",
      permission: "billing.view",
      allowed: false,
    });
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate.mock.calls[0][0].data.action).toBe(
      "permission.denied.billing.view",
    );
  });

  it("logs deny but skips allow for gpu.access", () => {
    recordPermissionDecision({
      accountId: "cus_test",
      actorUserId: "user_alice",
      permission: "gpu.access",
      allowed: true,
    });
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it("swallows audit write errors so the request path is never broken", async () => {
    mockAuditCreate.mockRejectedValueOnce(new Error("db down"));

    expect(() =>
      recordPermissionDecision({
        accountId: "cus_test",
        actorUserId: null,
        permission: "billing.manage",
        allowed: false,
      }),
    ).not.toThrow();

    // Give the unhandled promise a tick to settle without unhandled rejection.
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("forbidden()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditCreate.mockResolvedValue({});
  });

  it("returns a 403 NextResponse and records the denial", async () => {
    const auth = makeAuth("member", false);
    const response = forbidden(auth, "gpu.provision");

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.permission).toBe("gpu.provision");
    expect(body.role).toBe("member");
    expect(body.isOwner).toBe(false);
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
  });
});

describe("requirePermission()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditCreate.mockResolvedValue({});
  });

  it("returns null when the permission is allowed (Owner case)", () => {
    const auth = makeAuth("teamAdmin", true);
    const result = requirePermission(auth, "gpu.provision");
    expect(result).toBeNull();
    // allowed sensitive → still audited
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditCreate.mock.calls[0][0].data.action).toBe(
      "permission.allowed.gpu.provision",
    );
  });

  it("returns a 403 NextResponse when denied", async () => {
    const auth = makeAuth("member", false);
    const result = requirePermission(auth, "billing.manage");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body.permission).toBe("billing.manage");
  });
});
