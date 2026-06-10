// Tests for the instance action sub-routes:
//   - src/app/api/v1/instances/[id]/restart/route.ts
//   - src/app/api/v1/instances/[id]/connection/route.ts
//   - src/app/api/v1/instances/[id]/scale/route.ts
//
// Pinned contracts:
//   * restart/connection enforce team ownership BEFORE calling HAI — a
//     foreign instance 404s and never restarts / never leaks credentials
//   * connection returns the full SSH credential set (password included —
//     this endpoint is the documented way to fetch it) plus a ready-made
//     ssh command, omitting the command when fields are missing
//   * scale is a tombstone: always 400 with guidance to create instances

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateApiKey,
  mockCheckRateLimit,
  mockGetUnifiedInstances,
  mockRestartInstance,
  mockGetInstanceCredentials,
} = vi.hoisted(() => ({
  mockAuthenticateApiKey: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockGetUnifiedInstances: vi.fn(),
  mockRestartInstance: vi.fn(),
  mockGetInstanceCredentials: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  authenticateApiKey: mockAuthenticateApiKey,
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock("@/lib/hostedai", () => ({
  getUnifiedInstances: mockGetUnifiedInstances,
  restartInstance: mockRestartInstance,
  getInstanceCredentials: mockGetInstanceCredentials,
}));

import { POST as restartPOST } from "@/app/api/v1/instances/[id]/restart/route";
import { GET as connectionGET } from "@/app/api/v1/instances/[id]/connection/route";
import { POST as scalePOST } from "@/app/api/v1/instances/[id]/scale/route";

const RATE_INFO = { limit: 100, remaining: 99, reset: 1750000000 };

function makeRequest(method: string, path = "restart") {
  return new NextRequest(`http://localhost/api/v1/instances/inst-1/${path}`, {
    method,
    headers: { authorization: "Bearer pk_live_test" },
  });
}

function routeParams(id = "inst-1") {
  return { params: Promise.resolve({ id }) };
}

describe("instance action sub-routes", () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockResolvedValue({
      keyId: "key-1",
      customerId: "cus_1",
      teamId: "team-1",
      scopes: "*",
    });
    mockCheckRateLimit.mockReturnValue({ allowed: true, info: RATE_INFO });
    mockGetUnifiedInstances.mockResolvedValue({
      items: [{ id: "inst-1", status: "Running" }],
    });
    mockRestartInstance.mockResolvedValue(undefined);
    mockGetInstanceCredentials.mockResolvedValue({
      ip: "10.9.0.1",
      port: 2222,
      username: "root",
      password: "s3cret",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /instances/[id]/restart", () => {
    it("404s for a foreign instance without restarting anything", async () => {
      mockGetUnifiedInstances.mockResolvedValue({ items: [] });

      const res = await restartPOST(makeRequest("POST"), routeParams("inst-foreign"));

      expect(res.status).toBe(404);
      expect(mockRestartInstance).not.toHaveBeenCalled();
    });

    it("restarts an owned instance and reports initiation", async () => {
      const res = await restartPOST(makeRequest("POST"), routeParams());
      const body = await res.json();

      expect(mockRestartInstance).toHaveBeenCalledWith("inst-1");
      expect(res.status).toBe(200);
      expect(body.data).toEqual({
        instance_id: "inst-1",
        action: "restart",
        status: "initiated",
      });
    });

    it("surfaces HAI restart failures", async () => {
      mockRestartInstance.mockRejectedValue(new Error("HAI 500"));

      const res = await restartPOST(makeRequest("POST"), routeParams());

      expect(res.status).toBe(500);
    });
  });

  describe("GET /instances/[id]/connection", () => {
    it("404s for a foreign instance — credentials never leave the team", async () => {
      mockGetUnifiedInstances.mockResolvedValue({ items: [] });

      const res = await connectionGET(
        makeRequest("GET", "connection"),
        routeParams("inst-foreign"),
      );

      expect(res.status).toBe(404);
      expect(mockGetInstanceCredentials).not.toHaveBeenCalled();
    });

    it("returns the full credential set with a ready-made ssh command", async () => {
      const res = await connectionGET(makeRequest("GET", "connection"), routeParams());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.connection).toEqual({
        ip: "10.9.0.1",
        port: 2222,
        username: "root",
        password: "s3cret",
        ssh_command: "ssh -p 2222 root@10.9.0.1",
      });
      expect(body.data.status).toBe("running");
    });

    it("omits the ssh command when credentials are incomplete", async () => {
      mockGetInstanceCredentials.mockResolvedValue({
        ip: null,
        port: null,
        username: null,
        password: null,
      });

      const res = await connectionGET(makeRequest("GET", "connection"), routeParams());
      const body = await res.json();

      expect(body.data.connection.ssh_command).toBeNull();
    });
  });

  describe("POST /instances/[id]/scale (deprecated)", () => {
    it("always 400s with create-more-instances guidance", async () => {
      const res = await scalePOST(makeRequest("POST", "scale"), routeParams());
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.message).toContain("Scaling is not supported");
      expect(body.error.message).toContain("POST /api/v1/instances");
    });

    it("still requires authentication", async () => {
      const { ApiError } = await import("@/lib/api/errors");
      mockAuthenticateApiKey.mockRejectedValue(ApiError.missingApiKey());

      const res = await scalePOST(makeRequest("POST", "scale"), routeParams());

      expect(res.status).toBe(401);
    });
  });
});
