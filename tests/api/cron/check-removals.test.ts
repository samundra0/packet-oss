// Tests for src/app/api/cron/check-removals/route.ts.
//
// Daily cron for provider server off-boarding. Once customers vacate a
// removal-scheduled node, it runs the 6-step GPUaaS teardown (unassign GPUs
// → delete pools → deinit → delete node → delete region) and notifies the
// provider. Pinned contracts:
//   * Auth gating
//   * Query scoping: removal_scheduled with a scheduled date
//   * Occupied nodes are never torn down; reminder logging only at 5/3/1
//     days out
//   * Vacated node happy path: teardown order, node marked removed with
//     GPUaaS ids nulled, provider vacated email + notification row
//   * Region survives when other active nodes still reference it
//   * Cleanup errors trigger the critical alert email but the node is
//     STILL marked removed (the provider must not stay blocked)
//   * Deinit failure aborts before node deletion
//   * Per-node error isolation; fatal error → 500

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockNodeFindMany,
  mockNodeUpdate,
  mockNodeCount,
  mockNotificationCreate,
  mockSendVacatedEmail,
  mockAlertRemovalFailed,
  mockGetAllPoolGPUs,
  mockRemoveGPUsFromPool,
  mockListPoolsForCluster,
  mockDeletePoolById,
  mockGetPoolGPUs,
  mockDeinitNode,
  mockGetNode,
  mockDeleteNode,
  mockDeleteRegion,
} = vi.hoisted(() => ({
  mockNodeFindMany: vi.fn(),
  mockNodeUpdate: vi.fn(),
  mockNodeCount: vi.fn(),
  mockNotificationCreate: vi.fn(),
  mockSendVacatedEmail: vi.fn(),
  mockAlertRemovalFailed: vi.fn(),
  mockGetAllPoolGPUs: vi.fn(),
  mockRemoveGPUsFromPool: vi.fn(),
  mockListPoolsForCluster: vi.fn(),
  mockDeletePoolById: vi.fn(),
  mockGetPoolGPUs: vi.fn(),
  mockDeinitNode: vi.fn(),
  mockGetNode: vi.fn(),
  mockDeleteNode: vi.fn(),
  mockDeleteRegion: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    providerNode: {
      findMany: mockNodeFindMany,
      update: mockNodeUpdate,
      count: mockNodeCount,
    },
    providerNotification: { create: mockNotificationCreate },
  },
}));
vi.mock("@/lib/email/templates/provider", () => ({
  sendProviderServerVacatedEmail: mockSendVacatedEmail,
}));
vi.mock("@/lib/email/templates/alerts", () => ({
  alertServerRemovalFailed: mockAlertRemovalFailed,
}));
vi.mock("@/lib/gpuaas-admin", () => ({
  getAllPoolGPUs: mockGetAllPoolGPUs,
  removeGPUsFromPool: mockRemoveGPUsFromPool,
  listPoolsForCluster: mockListPoolsForCluster,
  deletePoolById: mockDeletePoolById,
  getPoolGPUs: mockGetPoolGPUs,
  deinitNode: mockDeinitNode,
  getNode: mockGetNode,
  deleteNode: mockDeleteNode,
  deleteRegion: mockDeleteRegion,
}));

import { GET } from "@/app/api/cron/check-removals/route";

const SECRET = "cron-removals-secret";
const ORIGINAL = process.env.CRON_SECRET;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/check-removals", {
    method: "GET",
    headers,
  });
}

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-1",
    hostname: "gpu-host-1",
    ipAddress: "10.2.0.1",
    providerId: "prov-1",
    status: "removal_scheduled",
    removalScheduledFor: new Date(Date.now() + 10 * DAY_MS),
    hostedaiPoolId: null, // vacated by default
    gpuaasClusterId: 5,
    gpuaasPoolId: null,
    gpuaasNodeId: 77,
    gpuaasRegionId: 9,
    provider: { email: "provider@x.com", companyName: "GPU Co" },
    ...overrides,
  };
}

describe("GET /api/cron/check-removals", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockNodeFindMany.mockResolvedValue([]);
    mockNodeUpdate.mockResolvedValue({});
    mockNodeCount.mockResolvedValue(0); // no other nodes in region
    mockNotificationCreate.mockResolvedValue({});
    mockSendVacatedEmail.mockResolvedValue(undefined);
    mockAlertRemovalFailed.mockResolvedValue(undefined);
    mockGetAllPoolGPUs.mockResolvedValue([]);
    mockRemoveGPUsFromPool.mockResolvedValue(undefined);
    mockListPoolsForCluster.mockResolvedValue([]);
    mockDeletePoolById.mockResolvedValue(undefined);
    mockGetPoolGPUs.mockResolvedValue([]);
    mockDeinitNode.mockResolvedValue(undefined);
    // Deinit completes immediately (status 0) so tests avoid the poll loop
    mockGetNode.mockResolvedValue({ initialize_state_status_code: 0 });
    mockDeleteNode.mockResolvedValue(undefined);
    mockDeleteRegion.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without querying", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockNodeFindMany).not.toHaveBeenCalled();
  });

  it("queries only removal-scheduled nodes with a date set", async () => {
    await GET(makeRequest(SECRET));

    expect(mockNodeFindMany).toHaveBeenCalledWith({
      where: {
        status: "removal_scheduled",
        removalScheduledFor: { not: null },
      },
      include: { provider: true },
    });
  });

  it("never tears down an occupied node; counts a reminder at 3 days out", async () => {
    mockNodeFindMany.mockResolvedValue([
      node({
        hostedaiPoolId: "pool-active",
        removalScheduledFor: new Date(Date.now() + 3 * DAY_MS),
      }),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockDeinitNode).not.toHaveBeenCalled();
    expect(mockNodeUpdate).not.toHaveBeenCalled();
    expect(body.data.reminders).toBe(1);
    expect(body.data.vacated).toBe(0);
  });

  it("does not count a reminder outside the 5/3/1-day marks", async () => {
    mockNodeFindMany.mockResolvedValue([
      node({
        hostedaiPoolId: "pool-active",
        removalScheduledFor: new Date(Date.now() + 8 * DAY_MS),
      }),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.data.reminders).toBe(0);
  });

  it("runs the full teardown for a vacated node and notifies the provider", async () => {
    mockNodeFindMany.mockResolvedValue([node()]);
    mockGetAllPoolGPUs.mockResolvedValue([
      { uuid: "gpu-a", pool_id: 11, assignment_status: "assigned" },
      { uuid: "gpu-b", pool_id: 11, assignment_status: "assigned" },
      { uuid: "gpu-c", pool_id: null, assignment_status: "unassigned" },
    ]);
    mockListPoolsForCluster
      .mockResolvedValueOnce([{ id: 11, name: "pool-11" }]) // step 3
      .mockResolvedValueOnce([]); // step 4 prep: all gone

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    // GPU unassignment (only assigned GPUs) then pool deletion
    expect(mockRemoveGPUsFromPool).toHaveBeenCalledWith(11, ["gpu-a", "gpu-b"]);
    expect(mockDeletePoolById).toHaveBeenCalledWith(11);
    // Deinit → delete node → delete region (no other nodes)
    expect(mockDeinitNode).toHaveBeenCalledWith(77);
    expect(mockDeleteNode).toHaveBeenCalledWith(77);
    expect(mockDeleteRegion).toHaveBeenCalledWith(9);
    // Node finalized with GPUaaS ids nulled
    expect(mockNodeUpdate).toHaveBeenCalledWith({
      where: { id: "node-1" },
      data: expect.objectContaining({
        status: "removed",
        removedAt: expect.any(Date),
        gpuaasNodeId: null,
        gpuaasRegionId: null,
        gpuaasClusterId: null,
        gpuaasPoolId: null,
      }),
    });
    expect(mockSendVacatedEmail).toHaveBeenCalledWith({
      to: "provider@x.com",
      nodeName: "gpu-host-1",
      companyName: "GPU Co",
    });
    expect(mockNotificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "server_vacated", nodeId: "node-1" }),
    });
    expect(body.data.vacated).toBe(1);
    expect(mockAlertRemovalFailed).not.toHaveBeenCalled();
  });

  it("keeps the region when other active nodes still use it", async () => {
    mockNodeFindMany.mockResolvedValue([node()]);
    mockNodeCount.mockResolvedValue(2); // siblings in region

    await GET(makeRequest(SECRET));

    expect(mockDeleteRegion).not.toHaveBeenCalled();
    expect(mockNodeCount).toHaveBeenCalledWith({
      where: {
        gpuaasRegionId: 9,
        id: { not: "node-1" },
        status: { notIn: ["removed"] },
      },
    });
  });

  it("sends the critical alert when cleanup fails, but still marks the node removed", async () => {
    mockNodeFindMany.mockResolvedValue([node()]);
    // Deinit fails outright → cleanup aborts with success: false
    mockDeinitNode.mockRejectedValue(new Error("deinit refused"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockAlertRemovalFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        hostname: "gpu-host-1",
        error: expect.stringContaining("deinit refused"),
      }),
    );
    // Deinit failed → node deletion must not be attempted
    expect(mockDeleteNode).not.toHaveBeenCalled();
    // But the provider-facing removal still completes
    expect(mockNodeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "removed" }) }),
    );
    expect(mockSendVacatedEmail).toHaveBeenCalled();
    expect(body.data.vacated).toBe(1);
  });

  it("isolates per-node failures so other nodes still process", async () => {
    mockNodeFindMany.mockResolvedValue([
      node({ id: "node-bad", hostname: "bad-host", gpuaasClusterId: null, gpuaasNodeId: null, gpuaasRegionId: null }),
      node({ id: "node-good", hostname: "good-host", gpuaasClusterId: null, gpuaasNodeId: null, gpuaasRegionId: null }),
    ]);
    mockNodeUpdate
      .mockRejectedValueOnce(new Error("db conflict"))
      .mockResolvedValueOnce({});

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.errors).toHaveLength(1);
    expect(body.data.errors[0]).toContain("bad-host");
    expect(body.data.vacated).toBe(1);
  });

  it("returns 500 when the node query fails", async () => {
    mockNodeFindMany.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
  });
});
