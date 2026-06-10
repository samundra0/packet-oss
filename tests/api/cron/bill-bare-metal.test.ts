// Tests for src/app/api/cron/bill-bare-metal/route.ts.
//
// Hourly billing for Spheron bare-metal deployments + storage volumes.
// Money-moving with a kill switch: low balance triggers auto-refill, and if
// that fails the DEPLOYMENT IS TERMINATED at the provider. Pinned contracts:
//   * Auth gating
//   * Not-due deployments are untouched
//   * Charge math: rate × gpuCount × floored hours; syncCycleId derives from
//     deployment id + billing boundary
//   * Dedup'd (skipped) charges do NOT advance lastBilledAt
//   * Low balance → refill attempt → re-check → charge if covered
//   * Refill insufficient → terminate at provider + mark terminated in DB,
//     and provider termination failure must not block the DB update
//   * Successful charge logs a WalletTransaction and advances lastBilledAt
//     to the boundary
//   * Volumes: same hourly model but low balance only skips (never
//     terminates storage)
//   * Per-item error isolation; fatal error → 500

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockDeploymentFindMany,
  mockDeploymentUpdate,
  mockVolumeFindMany,
  mockVolumeUpdate,
  mockWalletTxnCreate,
  mockDeductUsage,
  mockGetWalletBalance,
  mockCheckAndRefillWallet,
  mockGetSpheronClient,
  mockTerminateDeployment,
  mockAddGpuHours,
} = vi.hoisted(() => ({
  mockDeploymentFindMany: vi.fn(),
  mockDeploymentUpdate: vi.fn(),
  mockVolumeFindMany: vi.fn(),
  mockVolumeUpdate: vi.fn(),
  mockWalletTxnCreate: vi.fn(),
  mockDeductUsage: vi.fn(),
  mockGetWalletBalance: vi.fn(),
  mockCheckAndRefillWallet: vi.fn(),
  mockGetSpheronClient: vi.fn(),
  mockTerminateDeployment: vi.fn(),
  mockAddGpuHours: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    spheronDeployment: {
      findMany: mockDeploymentFindMany,
      update: mockDeploymentUpdate,
    },
    spheronVolume: { findMany: mockVolumeFindMany, update: mockVolumeUpdate },
    walletTransaction: { create: mockWalletTxnCreate },
  },
}));
vi.mock("@/lib/wallet", () => ({
  deductUsage: mockDeductUsage,
  getWalletBalance: mockGetWalletBalance,
  checkAndRefillWallet: mockCheckAndRefillWallet,
}));
vi.mock("@/lib/spheron", () => ({ getSpheronClient: mockGetSpheronClient }));
vi.mock("@/lib/lifecycle", () => ({ addGpuHours: mockAddGpuHours }));

import { GET } from "@/app/api/cron/bill-bare-metal/route";

const SECRET = "cron-bm-secret";
const ORIGINAL = process.env.CRON_SECRET;
const HOUR_MS = 60 * 60 * 1000;

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/bill-bare-metal", {
    method: "GET",
    headers,
  });
}

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: "dep-1",
    spheronDeploymentId: "sph-1",
    stripeCustomerId: "cus_1",
    teamId: "team-1",
    gpuType: "H100",
    gpuCount: 2,
    totalHourlyRateCents: 300,
    status: "running",
    lastBilledAt: new Date(Date.now() - 90 * 60 * 1000), // 1.5h ago
    createdAt: new Date(Date.now() - 24 * HOUR_MS),
    ...overrides,
  };
}

function volume(overrides: Record<string, unknown> = {}) {
  return {
    id: "vol-1",
    spheronVolumeId: "sphvol-1",
    stripeCustomerId: "cus_1",
    teamId: "team-1",
    name: "data-disk",
    sizeInGb: 100,
    totalHourlyRateCents: 5,
    status: "attached",
    lastBilledAt: new Date(Date.now() - 90 * 60 * 1000),
    createdAt: new Date(Date.now() - 24 * HOUR_MS),
    ...overrides,
  };
}

describe("GET /api/cron/bill-bare-metal", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockDeploymentFindMany.mockResolvedValue([]);
    mockVolumeFindMany.mockResolvedValue([]);
    mockDeploymentUpdate.mockResolvedValue({});
    mockVolumeUpdate.mockResolvedValue({});
    mockWalletTxnCreate.mockResolvedValue({});
    mockDeductUsage.mockResolvedValue({ success: true });
    mockGetWalletBalance.mockResolvedValue({ availableBalance: 100000 });
    mockCheckAndRefillWallet.mockResolvedValue({ refilled: false });
    mockGetSpheronClient.mockReturnValue({
      terminateDeployment: mockTerminateDeployment,
    });
    mockTerminateDeployment.mockResolvedValue(undefined);
    mockAddGpuHours.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without billing", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockDeploymentFindMany).not.toHaveBeenCalled();
    expect(mockDeductUsage).not.toHaveBeenCalled();
  });

  it("skips deployments not yet a full hour past last billing", async () => {
    mockDeploymentFindMany.mockResolvedValue([
      deployment({ lastBilledAt: new Date(Date.now() - 30 * 60 * 1000) }),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockDeductUsage).not.toHaveBeenCalled();
    expect(body.charged).toBe(0);
  });

  it("charges rate × gpuCount × floored hours and advances lastBilledAt to the boundary", async () => {
    const lastBilled = new Date(Date.now() - (2 * HOUR_MS + 20 * 60 * 1000)); // 2.33h
    mockDeploymentFindMany.mockResolvedValue([deployment({ lastBilledAt: lastBilled })]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    const expectedBoundary = new Date(lastBilled.getTime() + 2 * HOUR_MS);
    expect(mockDeductUsage).toHaveBeenCalledWith(
      "cus_1",
      4, // gpuCount 2 × 2 hours
      expect.stringContaining("H100 x2"),
      300,
      `bm_hour_sph-1_${expectedBoundary.toISOString()}`,
    );
    expect(mockDeploymentUpdate).toHaveBeenCalledWith({
      where: { id: "dep-1" },
      data: { lastBilledAt: expectedBoundary },
    });
    // WalletTransaction mirror: 2 GPUs × 2h × 300c
    expect(mockWalletTxnCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "bare_metal",
        amountCents: 1200,
        billingMinutes: 120,
      }),
    });
    expect(mockAddGpuHours).toHaveBeenCalledWith("cus_1", 4);
    expect(body.charged).toBe(1);
    expect(body.results[0].amountCents).toBe(1200); // rate × count × hours
  });

  it("does not advance lastBilledAt on a dedup'd (skipped) charge", async () => {
    mockDeploymentFindMany.mockResolvedValue([deployment()]);
    mockDeductUsage.mockResolvedValue({ skipped: true });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockDeploymentUpdate).not.toHaveBeenCalled();
    expect(mockWalletTxnCreate).not.toHaveBeenCalled();
    expect(body.results[0].action).toBe("skipped");
  });

  it("refills then charges when the wallet was low but refill covers it", async () => {
    mockDeploymentFindMany.mockResolvedValue([deployment()]);
    mockGetWalletBalance
      .mockResolvedValueOnce({ availableBalance: 100 }) // before: too low for 600c
      .mockResolvedValueOnce({ availableBalance: 5000 }); // after refill
    mockCheckAndRefillWallet.mockResolvedValue({ refilled: true, amount: 5000 });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockDeductUsage).toHaveBeenCalledTimes(1);
    expect(mockTerminateDeployment).not.toHaveBeenCalled();
    expect(body.results[0].action).toBe("refilled_and_charged");
    expect(body.charged).toBe(1);
  });

  it("terminates the deployment when refill fails to cover the charge", async () => {
    mockDeploymentFindMany.mockResolvedValue([deployment()]);
    mockGetWalletBalance.mockResolvedValue({ availableBalance: 100 }); // low before AND after
    mockCheckAndRefillWallet.mockResolvedValue({ refilled: false });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockTerminateDeployment).toHaveBeenCalledWith("sph-1");
    expect(mockDeploymentUpdate).toHaveBeenCalledWith({
      where: { id: "dep-1" },
      data: { status: "terminated", terminatedAt: expect.any(Date) },
    });
    expect(mockDeductUsage).not.toHaveBeenCalled(); // never charge what they can't pay
    expect(body.terminated).toBe(1);
    expect(body.results[0].reason).toContain("Insufficient balance");
  });

  it("still marks the deployment terminated when the provider call fails", async () => {
    mockDeploymentFindMany.mockResolvedValue([deployment()]);
    mockGetWalletBalance.mockResolvedValue({ availableBalance: 0 });
    mockTerminateDeployment.mockRejectedValue(new Error("spheron 500"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockDeploymentUpdate).toHaveBeenCalledWith({
      where: { id: "dep-1" },
      data: expect.objectContaining({ status: "terminated" }),
    });
    expect(body.terminated).toBe(1);
  });

  it("bills volumes hourly but only skips (never terminates) on low balance", async () => {
    mockVolumeFindMany.mockResolvedValue([volume()]);
    mockGetWalletBalance.mockResolvedValue({ availableBalance: 0 });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockTerminateDeployment).not.toHaveBeenCalled();
    expect(mockVolumeUpdate).not.toHaveBeenCalled();
    expect(body.volumeErrors).toBe(1);
    expect(body.volumeResults[0].reason).toContain("Insufficient balance");
  });

  it("charges a due volume and logs a storage WalletTransaction", async () => {
    const lastBilled = new Date(Date.now() - 3 * HOUR_MS - 5 * 60 * 1000); // 3h due
    mockVolumeFindMany.mockResolvedValue([volume({ lastBilledAt: lastBilled })]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    const expectedBoundary = new Date(lastBilled.getTime() + 3 * HOUR_MS);
    expect(mockDeductUsage).toHaveBeenCalledWith(
      "cus_1",
      3,
      expect.stringContaining("data-disk"),
      5,
      `vol_hour_sphvol-1_${expectedBoundary.toISOString()}`,
    );
    expect(mockWalletTxnCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "storage", amountCents: 15 }),
    });
    expect(mockVolumeUpdate).toHaveBeenCalledWith({
      where: { id: "vol-1" },
      data: { lastBilledAt: expectedBoundary },
    });
    expect(body.volumesCharged).toBe(1);
  });

  it("isolates per-deployment errors so the rest still bill", async () => {
    mockDeploymentFindMany.mockResolvedValue([
      deployment({ id: "dep-bad", spheronDeploymentId: "sph-bad" }),
      deployment({ id: "dep-good", spheronDeploymentId: "sph-good" }),
    ]);
    mockGetWalletBalance
      .mockRejectedValueOnce(new Error("wallet svc down"))
      .mockResolvedValue({ availableBalance: 100000 });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.errors).toBe(1);
    expect(body.charged).toBe(1);
    expect(body.results[0]).toMatchObject({ deploymentId: "dep-bad", action: "error" });
  });

  it("returns 500 when the deployment query fails", async () => {
    mockDeploymentFindMany.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to process bare metal billing");
  });
});
