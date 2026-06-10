// Tests for src/app/api/cron/check-pending-deploys/route.ts.
//
// PA-158 safety net: reconciles "provisioning" PodMetadata rows orphaned by a
// server restart killing the in-memory deploy monitor. Money is at stake — a
// missed reconcile means a customer was precharged for a pod that never
// started. Pinned contracts:
//   * Auth gating
//   * Query scoping: provisioning status, lookback window, oldest-first,
//     capped at 25 per run
//   * Rows missing instanceId/deployTime are skipped, not crashed on
//   * Monthly deploys reconcile with prechargedCents=0 (nothing to refund);
//     hourly deploys pass through their prepaid amount
//   * Per-row error isolation — one HAI failure doesn't abort the batch
//   * DB query failure → 500

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockPodMetadataFindMany, mockReconcilePendingDeploy } = vi.hoisted(
  () => ({
    mockPodMetadataFindMany: vi.fn(),
    mockReconcilePendingDeploy: vi.fn(),
  }),
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    podMetadata: { findMany: mockPodMetadataFindMany },
  },
}));
vi.mock("@/lib/deploy-monitor", () => ({
  reconcilePendingDeploy: mockReconcilePendingDeploy,
}));

import { GET, POST } from "@/app/api/cron/check-pending-deploys/route";

const SECRET = "cron-deploys-secret";
const ORIGINAL = process.env.CRON_SECRET;

function makeRequest(method: "GET" | "POST", secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/check-pending-deploys", {
    method,
    headers,
  });
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    instanceId: "inst-1",
    stripeCustomerId: "cus_1",
    billingType: "hourly",
    prepaidAmountCents: 500,
    deployTime: new Date("2026-06-05T09:50:00Z"),
    ...overrides,
  };
}

describe("POST /api/cron/check-pending-deploys", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockPodMetadataFindMany.mockResolvedValue([]);
    mockReconcilePendingDeploy.mockResolvedValue({ status: "running" });
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without querying", async () => {
    const res = await POST(makeRequest("POST"));

    expect(res.status).toBe(401);
    expect(mockPodMetadataFindMany).not.toHaveBeenCalled();
  });

  it("returns checked: 0 when nothing is provisioning", async () => {
    const res = await POST(makeRequest("POST", SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, checked: 0 });
    expect(mockReconcilePendingDeploy).not.toHaveBeenCalled();
  });

  it("queries only recent provisioning rows, oldest first, capped at 25", async () => {
    await POST(makeRequest("POST", SECRET));

    expect(mockPodMetadataFindMany).toHaveBeenCalledTimes(1);
    const query = mockPodMetadataFindMany.mock.calls[0][0];
    expect(query.where.deployStatus).toBe("provisioning");
    expect(query.where.deployTime.gte).toBeInstanceOf(Date);
    expect(query.orderBy).toEqual({ deployTime: "asc" });
    expect(query.take).toBe(25);
  });

  it("reconciles hourly deploys with their prepaid amount", async () => {
    const deployTime = new Date("2026-06-05T09:45:00Z");
    mockPodMetadataFindMany.mockResolvedValue([
      pendingRow({ instanceId: "inst-h", prepaidAmountCents: 1200, deployTime }),
    ]);
    mockReconcilePendingDeploy.mockResolvedValue({ status: "refunded", reason: "timeout" });

    const res = await POST(makeRequest("POST", SECRET));
    const body = await res.json();

    expect(mockReconcilePendingDeploy).toHaveBeenCalledWith({
      instanceId: "inst-h",
      customerId: "cus_1",
      prechargedCents: 1200,
      isMonthlyDeploy: false,
      deployTime,
      timeoutMs: 15 * 60 * 1000,
    });
    expect(body.checked).toBe(1);
    expect(body.results).toEqual([
      { instanceId: "inst-h", status: "refunded", reason: "timeout" },
    ]);
  });

  it("reconciles monthly deploys with prechargedCents=0 regardless of prepaid", async () => {
    mockPodMetadataFindMany.mockResolvedValue([
      pendingRow({ instanceId: "inst-m", billingType: "monthly", prepaidAmountCents: 9999 }),
    ]);

    await POST(makeRequest("POST", SECRET));

    expect(mockReconcilePendingDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "inst-m",
        prechargedCents: 0,
        isMonthlyDeploy: true,
      }),
    );
  });

  it("skips rows missing instanceId or deployTime without reconciling them", async () => {
    mockPodMetadataFindMany.mockResolvedValue([
      pendingRow({ id: 1, instanceId: null }),
      pendingRow({ id: 2, instanceId: "inst-ok" }),
      pendingRow({ id: 3, deployTime: null }),
    ]);

    const res = await POST(makeRequest("POST", SECRET));
    const body = await res.json();

    expect(mockReconcilePendingDeploy).toHaveBeenCalledTimes(1);
    expect(mockReconcilePendingDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "inst-ok" }),
    );
    // checked reflects rows fetched, not rows reconciled
    expect(body.checked).toBe(3);
    expect(body.results).toHaveLength(1);
  });

  it("isolates per-row reconcile failures and truncates long error reasons", async () => {
    mockPodMetadataFindMany.mockResolvedValue([
      pendingRow({ instanceId: "inst-bad" }),
      pendingRow({ instanceId: "inst-good" }),
    ]);
    mockReconcilePendingDeploy
      .mockRejectedValueOnce(new Error("x".repeat(300)))
      .mockResolvedValueOnce({ status: "running" });

    const res = await POST(makeRequest("POST", SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].status).toBe("error");
    expect(body.results[0].reason).toHaveLength(200);
    expect(body.results[1]).toEqual({
      instanceId: "inst-good",
      status: "running",
      reason: undefined,
    });
  });

  it("returns 500 when the DB query fails", async () => {
    mockPodMetadataFindMany.mockRejectedValue(new Error("db down"));

    const res = await POST(makeRequest("POST", SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Query failed");
  });

  it("GET delegates to the same reconcile path (manual-trigger parity)", async () => {
    const res = await GET(makeRequest("GET", SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
