// Tests for src/app/api/v1/instances/[id]/route.ts (detail / metadata / terminate).
//
// Pinned contracts:
//   * Team scoping: every verb verifies the instance is visible to the API
//     key's team before acting — another team's instance 404s (GET/DELETE)
//   * GET only fetches SSH credentials for RUNNING instances, and a
//     credentials failure degrades to connectionInfo: null (not a 500)
//   * PATCH validates types, upserts metadata (update-in-place when a row
//     exists, create with the instance placeholder otherwise), and clears
//     fields when empty strings are sent
//   * DELETE terminates via HAI only after the ownership check
//
// Real response/ApiError helpers are kept so envelopes and status codes
// stay honest; auth + rate limit are mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateApiKey,
  mockCheckRateLimit,
  mockGetUnifiedInstances,
  mockGetUnifiedInstanceDetail,
  mockGetInstanceCredentials,
  mockDeleteInstance,
  mockPodMetadataFindFirst,
  mockPodMetadataUpdate,
  mockPodMetadataCreate,
} = vi.hoisted(() => ({
  mockAuthenticateApiKey: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockGetUnifiedInstances: vi.fn(),
  mockGetUnifiedInstanceDetail: vi.fn(),
  mockGetInstanceCredentials: vi.fn(),
  mockDeleteInstance: vi.fn(),
  mockPodMetadataFindFirst: vi.fn(),
  mockPodMetadataUpdate: vi.fn(),
  mockPodMetadataCreate: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  authenticateApiKey: mockAuthenticateApiKey,
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock("@/lib/hostedai", () => ({
  getUnifiedInstances: mockGetUnifiedInstances,
  getUnifiedInstanceDetail: mockGetUnifiedInstanceDetail,
  getInstanceCredentials: mockGetInstanceCredentials,
  deleteInstance: mockDeleteInstance,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    podMetadata: {
      findFirst: mockPodMetadataFindFirst,
      update: mockPodMetadataUpdate,
      create: mockPodMetadataCreate,
    },
  },
}));

import { GET, PATCH, DELETE } from "@/app/api/v1/instances/[id]/route";

const RATE_INFO = { limit: 100, remaining: 99, reset: 1750000000 };

function makeRequest(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/v1/instances/inst-1", {
    method,
    headers: { authorization: "Bearer pk_live_test", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function routeParams(id = "inst-1") {
  return { params: Promise.resolve({ id }) };
}

function haiInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst-1",
    name: "training-box",
    status: "Running",
    created_at: "2026-06-01T00:00:00Z",
    region: null,
    pod_info: null,
    instance_type: null,
    ip: "10.9.0.1",
    ...overrides,
  };
}

describe("/api/v1/instances/[id]", () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockResolvedValue({
      keyId: "key-1",
      customerId: "cus_1",
      teamId: "team-1",
      scopes: "*",
    });
    mockCheckRateLimit.mockReturnValue({ allowed: true, info: RATE_INFO });
    mockGetUnifiedInstances.mockResolvedValue({ items: [haiInstance()] });
    mockGetUnifiedInstanceDetail.mockResolvedValue(null);
    mockGetInstanceCredentials.mockResolvedValue({
      ip: "10.9.0.1",
      port: 2222,
      username: "root",
    });
    mockDeleteInstance.mockResolvedValue(undefined);
    mockPodMetadataFindFirst.mockResolvedValue(null);
    mockPodMetadataUpdate.mockImplementation(async ({ data }) => ({
      displayName: data.displayName ?? "old name",
      notes: data.notes ?? "old notes",
    }));
    mockPodMetadataCreate.mockImplementation(async ({ data }) => data);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("GET (detail)", () => {
    it("404s for an instance not visible to the key's team", async () => {
      mockGetUnifiedInstances.mockResolvedValue({ items: [] }); // other team's box invisible

      const res = await GET(makeRequest("GET"), routeParams("inst-foreign"));
      const body = await res.json();

      expect(mockGetUnifiedInstances).toHaveBeenCalledWith("team-1");
      expect(res.status).toBe(404);
      expect(body.error.code).toBe("NOT_FOUND");
      expect(mockGetInstanceCredentials).not.toHaveBeenCalled();
    });

    it("returns detail with SSH connection info for a running instance", async () => {
      const res = await GET(makeRequest("GET"), routeParams());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.instance.status).toBe("running");
      expect(body.data.connectionInfo).toEqual({
        ip: "10.9.0.1",
        port: 2222,
        username: "root",
        ssh_command: "ssh -p 2222 root@10.9.0.1",
      });
    });

    it("does not fetch credentials for a stopped instance", async () => {
      mockGetUnifiedInstances.mockResolvedValue({
        items: [haiInstance({ status: "Stopped" })],
      });

      const res = await GET(makeRequest("GET"), routeParams());
      const body = await res.json();

      expect(mockGetInstanceCredentials).not.toHaveBeenCalled();
      expect(body.data.connectionInfo).toBeNull();
    });

    it("degrades to connectionInfo: null when the credentials call fails", async () => {
      mockGetInstanceCredentials.mockRejectedValue(new Error("creds not ready"));

      const res = await GET(makeRequest("GET"), routeParams());
      const body = await res.json();

      expect(res.status).toBe(200); // never a 500 for missing creds
      expect(body.data.connectionInfo).toBeNull();
    });

    it("includes storage detail and metadata when available", async () => {
      mockGetUnifiedInstanceDetail.mockResolvedValue({
        root_disk: { id: "d-1", name: "root", size_gb: 100 },
        shared_volumes: [
          { id: 5, name: "data", size_in_gb: 500, mount_point: "/data" },
        ],
      });
      mockPodMetadataFindFirst.mockResolvedValue({
        displayName: "My Box",
        notes: "prod",
      });

      const res = await GET(makeRequest("GET"), routeParams());
      const body = await res.json();

      expect(body.data.instance.storage.shared_volumes).toEqual([
        { id: "5", name: "data", size_in_gb: 500, mount_point: "/data" },
      ]);
      expect(body.data.metadata).toEqual({ displayName: "My Box", notes: "prod" });
    });
  });

  describe("PATCH (metadata)", () => {
    it("rejects non-string displayName and notes", async () => {
      const badName = await PATCH(
        makeRequest("PATCH", { displayName: 42 }),
        routeParams(),
      );
      expect(badName.status).toBe(400);

      const badNotes = await PATCH(
        makeRequest("PATCH", { notes: { a: 1 } }),
        routeParams(),
      );
      expect(badNotes.status).toBe(400);

      expect(mockPodMetadataUpdate).not.toHaveBeenCalled();
      expect(mockPodMetadataCreate).not.toHaveBeenCalled();
    });

    it("updates an existing metadata row in place", async () => {
      mockPodMetadataFindFirst.mockResolvedValue({ id: "meta-1" });

      const res = await PATCH(
        makeRequest("PATCH", { displayName: "Renamed" }),
        routeParams(),
      );
      const body = await res.json();

      expect(mockPodMetadataUpdate).toHaveBeenCalledWith({
        where: { id: "meta-1" },
        data: { displayName: "Renamed" },
      });
      expect(mockPodMetadataCreate).not.toHaveBeenCalled();
      expect(body.data.displayName).toBe("Renamed");
    });

    it("clears a field when an empty string is sent", async () => {
      mockPodMetadataFindFirst.mockResolvedValue({ id: "meta-1" });

      await PATCH(makeRequest("PATCH", { notes: "" }), routeParams());

      expect(mockPodMetadataUpdate).toHaveBeenCalledWith({
        where: { id: "meta-1" },
        data: { notes: null },
      });
    });

    it("creates a metadata row with the instance placeholder when none exists", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { displayName: "Fresh", notes: "new" }),
        routeParams(),
      );

      expect(res.status).toBe(200);
      expect(mockPodMetadataCreate).toHaveBeenCalledWith({
        data: {
          subscriptionId: "instance-inst-1",
          instanceId: "inst-1",
          stripeCustomerId: "cus_1",
          displayName: "Fresh",
          notes: "new",
        },
      });
    });
  });

  describe("DELETE (terminate)", () => {
    it("404s before terminating an instance outside the key's team", async () => {
      mockGetUnifiedInstances.mockResolvedValue({ items: [] });

      const res = await DELETE(makeRequest("DELETE"), routeParams("inst-foreign"));

      expect(res.status).toBe(404);
      expect(mockDeleteInstance).not.toHaveBeenCalled();
    });

    it("terminates an owned instance via HAI", async () => {
      const res = await DELETE(makeRequest("DELETE"), routeParams());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(mockDeleteInstance).toHaveBeenCalledWith("inst-1");
      expect(body.data).toMatchObject({ id: "inst-1", terminated: true });
    });

    it("surfaces HAI termination failures as errors, not fake success", async () => {
      mockDeleteInstance.mockRejectedValue(new Error("HAI 500"));

      const res = await DELETE(makeRequest("DELETE"), routeParams());

      expect(res.status).toBe(500);
    });

    it("rate-limits writes before the ownership lookup", async () => {
      mockCheckRateLimit.mockReturnValue({
        allowed: false,
        info: { ...RATE_INFO, remaining: 0 },
      });

      const res = await DELETE(makeRequest("DELETE"), routeParams());

      expect(res.status).toBe(429);
      expect(mockGetUnifiedInstances).not.toHaveBeenCalled();
      expect(mockDeleteInstance).not.toHaveBeenCalled();
    });
  });
});
