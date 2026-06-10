// Tests for src/app/api/cron/check-deletions/route.ts.
//
// Every-minute cron that confirms GPUaaS node/region deletions so a removed
// node's IP can be re-deployed early. Getting this wrong re-uses an IP while
// GPUaaS still holds the old node — provisioning then fails in confusing
// ways. Pinned contracts:
//   * Auth gating
//   * Query scoping: removed + unconfirmed + has removedAt
//   * 20-minute timeout force-confirms regardless of GPUaaS state
//   * 404/not-found from GPUaaS counts as deleted; other errors do NOT
//     (fail-safe: keep waiting)
//   * Both node AND region must be gone before confirming
//   * Nodes with no GPUaaS ids confirm immediately (nothing to wait for)
//   * DB failure → 500

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockProviderNodeFindMany,
  mockProviderNodeUpdate,
  mockGetNode,
  mockGetRegion,
} = vi.hoisted(() => ({
  mockProviderNodeFindMany: vi.fn(),
  mockProviderNodeUpdate: vi.fn(),
  mockGetNode: vi.fn(),
  mockGetRegion: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    providerNode: {
      findMany: mockProviderNodeFindMany,
      update: mockProviderNodeUpdate,
    },
  },
}));
vi.mock("@/lib/gpuaas-admin/nodes", () => ({ getNode: mockGetNode }));
vi.mock("@/lib/gpuaas-admin/regions", () => ({ getRegion: mockGetRegion }));

import { GET } from "@/app/api/cron/check-deletions/route";

const SECRET = "cron-deletions-secret";
const ORIGINAL = process.env.CRON_SECRET;

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/check-deletions", {
    method: "GET",
    headers,
  });
}

function removedNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-1",
    ipAddress: "10.1.0.1",
    gpuaasNodeId: "hai-node-1",
    gpuaasRegionId: "hai-region-1",
    removedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
    ...overrides,
  };
}

describe("GET /api/cron/check-deletions", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockProviderNodeFindMany.mockResolvedValue([]);
    mockProviderNodeUpdate.mockResolvedValue({});
    // Default: GPUaaS reports both deleted
    mockGetNode.mockRejectedValue(new Error("404 not found"));
    mockGetRegion.mockRejectedValue(new Error("404 not found"));
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without querying", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockProviderNodeFindMany).not.toHaveBeenCalled();
  });

  it("queries only removed, unconfirmed nodes with a removedAt timestamp", async () => {
    await GET(makeRequest(SECRET));

    expect(mockProviderNodeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "removed",
          deletionConfirmedAt: null,
          removedAt: { not: null },
        },
      }),
    );
  });

  it("handles zero removed nodes cleanly", async () => {
    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      checked: 0,
      confirmed: 0,
      pending: 0,
      results: [],
    });
  });

  it("force-confirms after the 20-minute cooldown without consulting GPUaaS", async () => {
    mockProviderNodeFindMany.mockResolvedValue([
      removedNode({ removedAt: new Date(Date.now() - 21 * 60 * 1000) }),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockGetNode).not.toHaveBeenCalled();
    expect(mockGetRegion).not.toHaveBeenCalled();
    expect(mockProviderNodeUpdate).toHaveBeenCalledWith({
      where: { id: "node-1" },
      data: { deletionConfirmedAt: expect.any(Date) },
    });
    expect(body.results[0].status).toBe("timeout");
    expect(body.confirmed).toBe(1);
  });

  it("confirms early when GPUaaS 404s for both node and region", async () => {
    mockProviderNodeFindMany.mockResolvedValue([removedNode()]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockGetNode).toHaveBeenCalledWith("hai-node-1");
    expect(mockGetRegion).toHaveBeenCalledWith("hai-region-1");
    expect(mockProviderNodeUpdate).toHaveBeenCalledTimes(1);
    expect(body.results[0].status).toBe("confirmed");
    expect(body.confirmed).toBe(1);
  });

  it("stays pending while the GPUaaS node still exists", async () => {
    mockProviderNodeFindMany.mockResolvedValue([removedNode()]);
    mockGetNode.mockResolvedValue({ id: "hai-node-1" }); // still there

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockProviderNodeUpdate).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe("pending");
    expect(body.pending).toBe(1);
  });

  it("stays pending while only the region still exists", async () => {
    mockProviderNodeFindMany.mockResolvedValue([removedNode()]);
    mockGetRegion.mockResolvedValue({ id: "hai-region-1" }); // still there

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockProviderNodeUpdate).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe("pending");
  });

  it("treats non-404 GPUaaS errors as still-existing (fail-safe), not deleted", async () => {
    mockProviderNodeFindMany.mockResolvedValue([removedNode()]);
    mockGetNode.mockRejectedValue(new Error("503 service unavailable"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockProviderNodeUpdate).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe("pending");
  });

  it("confirms immediately when the node has no GPUaaS ids to check", async () => {
    mockProviderNodeFindMany.mockResolvedValue([
      removedNode({ gpuaasNodeId: null, gpuaasRegionId: null }),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockGetNode).not.toHaveBeenCalled();
    expect(mockGetRegion).not.toHaveBeenCalled();
    expect(body.results[0].status).toBe("confirmed");
  });

  it("processes multiple nodes and tallies confirmed vs pending", async () => {
    mockProviderNodeFindMany.mockResolvedValue([
      removedNode({ id: "n-confirmed", ipAddress: "10.1.0.1" }),
      removedNode({ id: "n-pending", ipAddress: "10.1.0.2" }),
      removedNode({
        id: "n-timeout",
        ipAddress: "10.1.0.3",
        removedAt: new Date(Date.now() - 30 * 60 * 1000),
      }),
    ]);
    // First node: both 404 (confirmed). Second node: node still exists.
    mockGetNode
      .mockRejectedValueOnce(new Error("404 not found"))
      .mockResolvedValueOnce({ id: "still-here" });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.checked).toBe(3);
    expect(body.confirmed).toBe(2); // confirmed + timeout
    expect(body.pending).toBe(1);
  });

  it("returns 500 when the DB query fails", async () => {
    mockProviderNodeFindMany.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("db down");
  });
});
