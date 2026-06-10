// Tests for src/app/api/cron/complete-provisioning/route.ts.
//
// Every-minute reconciler that finishes GPUaaS provisioning for provider
// nodes an admin has linked (init done but no cluster/pool yet). The flow:
// check init → scan GPUs → enable GPUaaS → create pool → attach GPUs →
// publish region to the default resource policy. Pinned contracts:
//   * Auth gating
//   * Query scoping: linked nodes in active/approved/provisioning with
//     init completed but missing pool or cluster
//   * Init in progress → in_progress, node untouched
//   * Init failed → provisioning_failed + critical alert email
//   * Happy path: pool named from the GPU model ("Tesla T4" → "tesla-t4"),
//     created with admin pool settings, GPUs attached, region published,
//     node finishes "active / Ready for customers"
//   * Cluster not yet GPUAAS_ACTIVE → wait (in_progress), no pool created
//   * GPU scan failure falls back to the node object's GPU list
//   * Pool-create failure recovers by adopting an existing pool
//   * "already in pool" GPU attach errors are tolerated
//   * Per-node error isolation; fatal error → 500

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockNodeFindMany,
  mockNodeUpdate,
  mockPoolDefaultsFindUnique,
  mockPoolOverrideFindUnique,
  mockGetNode,
  mockEnableGPUaaS,
  mockCreatePool,
  mockScanGPUs,
  mockAddGPUToPool,
  mockGetUnassignedClusterGPUs,
  mockGetClusterByRegion,
  mockGetCluster,
  mockListPools,
  mockAddRegionToDefaultPolicy,
  mockGetStripe,
  mockSubscriptionsList,
  mockAlertProvisioningFailed,
} = vi.hoisted(() => ({
  mockNodeFindMany: vi.fn(),
  mockNodeUpdate: vi.fn(),
  mockPoolDefaultsFindUnique: vi.fn(),
  mockPoolOverrideFindUnique: vi.fn(),
  mockGetNode: vi.fn(),
  mockEnableGPUaaS: vi.fn(),
  mockCreatePool: vi.fn(),
  mockScanGPUs: vi.fn(),
  mockAddGPUToPool: vi.fn(),
  mockGetUnassignedClusterGPUs: vi.fn(),
  mockGetClusterByRegion: vi.fn(),
  mockGetCluster: vi.fn(),
  mockListPools: vi.fn(),
  mockAddRegionToDefaultPolicy: vi.fn(),
  mockGetStripe: vi.fn(),
  mockSubscriptionsList: vi.fn(),
  mockAlertProvisioningFailed: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    providerNode: { findMany: mockNodeFindMany, update: mockNodeUpdate },
    poolSettingsDefaults: { findUnique: mockPoolDefaultsFindUnique },
    poolSettingsOverride: { findUnique: mockPoolOverrideFindUnique },
  },
}));
vi.mock("@/lib/gpuaas-admin", () => ({
  gpuaasAdmin: {
    getClusterByRegion: mockGetClusterByRegion,
    getCluster: mockGetCluster,
    listPools: mockListPools,
  },
  getNode: mockGetNode,
  enableGPUaaS: mockEnableGPUaaS,
  createPool: mockCreatePool,
  scanGPUs: mockScanGPUs,
  addGPUToPool: mockAddGPUToPool,
  getGpuaasIdForRegion: vi.fn(),
  getUnassignedClusterGPUs: mockGetUnassignedClusterGPUs,
}));
vi.mock("@/lib/hostedai", () => ({
  addRegionToDefaultPolicy: mockAddRegionToDefaultPolicy,
}));
vi.mock("@/lib/stripe", () => ({ getStripe: mockGetStripe }));
vi.mock("@/lib/email/templates/alerts", () => ({
  alertServerProvisioningFailed: mockAlertProvisioningFailed,
}));

import { GET } from "@/app/api/cron/complete-provisioning/route";

const SECRET = "cron-provisioning-secret";
const ORIGINAL = process.env.CRON_SECRET;

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/complete-provisioning", {
    method: "GET",
    headers,
  });
}

/** Stripe auto-pagination: subscriptions.list is consumed via `for await`. */
function asyncIterable(items: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

function node(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-1",
    hostname: "gpu-host-1",
    ipAddress: "10.3.0.1",
    providerId: "prov-1",
    status: "provisioning",
    gpuaasNodeId: 77,
    gpuaasClusterId: null,
    gpuaasPoolId: null,
    gpuaasRegionId: 9,
    gpuaasInitStatus: "completed",
    gpuModel: null,
    gpuCount: null,
    provider: { companyName: "GPU Co" },
    ...overrides,
  };
}

function gpuaasNode(overrides: Record<string, unknown> = {}) {
  return {
    initialize_state_status_code: 2, // init complete
    gpus: [],
    total_memory_in_mb: 0,
    total_disk_in_mb: 0,
    cores: 0,
    ...overrides,
  };
}

const SCANNED_GPUS = [
  { index: 0, name: "Tesla T4", memory: 16384, uuid: "uuid-0" },
  { index: 1, name: "Tesla T4", memory: 16384, uuid: "uuid-1" },
];

describe("GET /api/cron/complete-provisioning", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockNodeFindMany.mockResolvedValue([]);
    mockNodeUpdate.mockResolvedValue({});
    mockPoolDefaultsFindUnique.mockResolvedValue(null); // use built-in defaults
    mockPoolOverrideFindUnique.mockResolvedValue(null);
    mockGetNode.mockResolvedValue(gpuaasNode());
    mockScanGPUs.mockResolvedValue({ gpus: SCANNED_GPUS });
    mockGetClusterByRegion.mockResolvedValue(null);
    mockEnableGPUaaS.mockResolvedValue({ gpuaas_id: 55 });
    mockGetCluster.mockResolvedValue({ id: 55, status: "GPUAAS_ACTIVE" });
    mockGetUnassignedClusterGPUs.mockResolvedValue([
      { uuid: "uuid-0" },
      { uuid: "uuid-1" },
    ]);
    mockCreatePool.mockResolvedValue({ id: 88 });
    mockAddGPUToPool.mockResolvedValue(undefined);
    mockListPools.mockResolvedValue([]);
    mockAddRegionToDefaultPolicy.mockResolvedValue(true);
    mockGetStripe.mockResolvedValue({
      subscriptions: { list: mockSubscriptionsList },
    });
    mockSubscriptionsList
      .mockReturnValueOnce(
        asyncIterable([{ metadata: { hostedai_team_id: "team-1" } }]),
      )
      .mockReturnValue(asyncIterable([]));
    mockAlertProvisioningFailed.mockResolvedValue(undefined);
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

  it("only reconciles admin-linked nodes missing a pool or cluster", async () => {
    await GET(makeRequest(SECRET));

    expect(mockNodeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["active", "approved", "provisioning"] },
          gpuaasNodeId: { not: null },
          OR: [
            { gpuaasInitStatus: "completed", gpuaasPoolId: null },
            { gpuaasClusterId: null, gpuaasInitStatus: "completed" },
          ],
        }),
      }),
    );
  });

  it("leaves an initializing node untouched and reports in_progress", async () => {
    mockNodeFindMany.mockResolvedValue([node()]);
    mockGetNode.mockResolvedValue(gpuaasNode({ initialize_state_status_code: 1 }));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockNodeUpdate).not.toHaveBeenCalled();
    expect(body.inProgress).toBe(1);
    expect(body.results[0].message).toContain("still in progress");
  });

  it("marks a failed init as provisioning_failed and sends the critical alert", async () => {
    mockNodeFindMany.mockResolvedValue([node()]);
    mockGetNode.mockResolvedValue(gpuaasNode({ initialize_state_status_code: -1 }));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockNodeUpdate).toHaveBeenCalledWith({
      where: { id: "node-1" },
      data: expect.objectContaining({
        status: "provisioning_failed",
        gpuaasInitStatus: "error",
      }),
    });
    expect(mockAlertProvisioningFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        step: "GPUaaS Node Initialization",
      }),
    );
    expect(body.failed).toBe(1);
    expect(mockEnableGPUaaS).not.toHaveBeenCalled();
  });

  it("completes the full flow: enable → pool named from GPU → attach → publish region", async () => {
    mockNodeFindMany.mockResolvedValue([node()]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    // GPUaaS enabled and cluster recorded
    expect(mockEnableGPUaaS).toHaveBeenCalledWith(77);
    expect(mockNodeUpdate).toHaveBeenCalledWith({
      where: { id: "node-1" },
      data: { gpuaasClusterId: 55 },
    });
    // Pool named from the GPU model with built-in default settings
    expect(mockCreatePool).toHaveBeenCalledWith({
      gpuaas_id: 55,
      name: "tesla-t4",
      overcommit_ratio: 1.0,
      time_quantum_in_sec: 90,
      attach_gpu_ids: ["uuid-0", "uuid-1"],
      security_mode: "low",
    });
    // Region published with active Stripe teams
    expect(mockAddRegionToDefaultPolicy).toHaveBeenCalledWith(9, ["team-1"]);
    // Both GPUs attached
    expect(mockAddGPUToPool).toHaveBeenCalledTimes(2);
    expect(mockAddGPUToPool).toHaveBeenCalledWith({
      pool_id: 88,
      gpuaas_node_id: 77,
      gpu_index: 0,
    });
    // Node finalized
    expect(mockNodeUpdate).toHaveBeenCalledWith({
      where: { id: "node-1" },
      data: {
        status: "active",
        statusMessage: "Ready for customers",
        gpuModel: "Tesla T4",
        gpuCount: 2,
      },
    });
    expect(body.completed).toBe(1);
    expect(body.results[0]).toMatchObject({
      status: "completed",
      gpuModel: "Tesla T4",
      gpuCount: 2,
    });
  });

  it("waits (in_progress) while the cluster is still setting up", async () => {
    mockNodeFindMany.mockResolvedValue([node({ gpuaasClusterId: 55 })]);
    mockGetCluster.mockResolvedValue({ id: 55, status: "GPUAAS_INSTALLING" });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockCreatePool).not.toHaveBeenCalled();
    expect(body.inProgress).toBe(1);
    expect(body.results[0].message).toContain("GPUAAS_INSTALLING");
  });

  it("falls back to the node object's GPU list when the scan fails", async () => {
    mockNodeFindMany.mockResolvedValue([node({ gpuaasClusterId: 55 })]);
    mockScanGPUs.mockRejectedValue(new Error("scan timeout"));
    mockGetNode.mockResolvedValue(
      gpuaasNode({
        gpus: [{ gpu_id: "0", gpu_model: "RTX 4090", uuid: "uuid-n0" }],
      }),
    );

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockCreatePool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "rtx-4090" }),
    );
    expect(body.completed).toBe(1);
    expect(body.results[0].gpuModel).toBe("RTX 4090");
  });

  it("records detected node resources (RAM/disk/cores) from GPUaaS", async () => {
    mockNodeFindMany.mockResolvedValue([node({ gpuaasClusterId: 55 })]);
    mockGetNode.mockResolvedValue(
      gpuaasNode({
        total_memory_in_mb: 131072,
        total_disk_in_mb: 2097152,
        cores: 64,
      }),
    );

    await GET(makeRequest(SECRET));

    expect(mockNodeUpdate).toHaveBeenCalledWith({
      where: { id: "node-1" },
      data: { ramGb: 128, storageGb: 2048, cpuCores: 64 },
    });
  });

  it("adopts an existing pool when pool creation fails", async () => {
    mockNodeFindMany.mockResolvedValue([node({ gpuaasClusterId: 55 })]);
    mockCreatePool.mockRejectedValue(new Error("pool name taken"));
    mockListPools.mockResolvedValue([
      { id: 99, region_id: 9 },
      { id: 100, region_id: 4 },
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockNodeUpdate).toHaveBeenCalledWith({
      where: { id: "node-1" },
      data: expect.objectContaining({ gpuaasPoolId: 99 }),
    });
    // GPUs attach to the adopted pool
    expect(mockAddGPUToPool).toHaveBeenCalledWith(
      expect.objectContaining({ pool_id: 99 }),
    );
    expect(body.completed).toBe(1);
  });

  it("tolerates 'already in pool' errors while attaching GPUs", async () => {
    mockNodeFindMany.mockResolvedValue([node({ gpuaasClusterId: 55 })]);
    mockAddGPUToPool
      .mockRejectedValueOnce(new Error("GPU already assigned to pool"))
      .mockResolvedValueOnce(undefined);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.completed).toBe(1); // still finishes
  });

  it("isolates per-node failures so other nodes still reconcile", async () => {
    mockNodeFindMany.mockResolvedValue([
      node({ id: "node-bad", ipAddress: "10.3.0.1" }),
      node({ id: "node-good", ipAddress: "10.3.0.2", gpuaasClusterId: 55 }),
    ]);
    mockGetNode
      .mockRejectedValueOnce(new Error("HAI 502"))
      .mockResolvedValue(gpuaasNode());

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.failed).toBe(1);
    expect(body.completed).toBe(1);
    expect(body.results[0]).toMatchObject({ id: "node-bad", status: "failed" });
  });

  it("returns 500 when the node query fails", async () => {
    mockNodeFindMany.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
  });
});
