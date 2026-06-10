// Tests for src/app/api/cron/health-check-servers/route.ts.
//
// Every-5-minutes cron that probes each inference server's /v1/models and
// flips its status between ready/offline. Token Factory routing reads that
// status, so wrong transitions either blackhole traffic (healthy marked
// offline) or route requests at dead servers. Pinned contracts:
//   * Auth gating
//   * Healthy probe (HTTP 200 + non-empty models) → status "ready" + model
//     recorded
//   * Unhealthy probes — network error, non-OK response, empty model list —
//     → status "offline", and loadedModel is NOT overwritten with null
//   * Summary counts and per-server `changed` flags
//   * DB failure → 500

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockServerFindMany, mockServerUpdate } = vi.hoisted(() => ({
  mockServerFindMany: vi.fn(),
  mockServerUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    inferenceServer: {
      findMany: mockServerFindMany,
      update: mockServerUpdate,
    },
  },
}));

import { GET } from "@/app/api/cron/health-check-servers/route";

const SECRET = "cron-health-secret";
const ORIGINAL = process.env.CRON_SECRET;

const mockFetch = vi.fn();

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/health-check-servers", {
    method: "GET",
    headers,
  });
}

function server(overrides: Record<string, unknown> = {}) {
  return {
    id: "srv-1",
    ipAddress: "10.0.0.1",
    port: 8000,
    status: "ready",
    loadedModel: "llama-3-70b",
    ...overrides,
  };
}

function modelsResponse(ids: string[]) {
  return {
    ok: true,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  };
}

describe("GET /api/cron/health-check-servers", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    vi.stubGlobal("fetch", mockFetch);
    mockServerFindMany.mockResolvedValue([]);
    mockServerUpdate.mockResolvedValue({});
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without probing anything", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockServerFindMany).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles zero servers cleanly", async () => {
    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.summary).toEqual({ total: 0, online: 0, offline: 0 });
  });

  it("marks a healthy server ready and records its loaded model", async () => {
    mockServerFindMany.mockResolvedValue([server({ status: "offline" })]);
    mockFetch.mockResolvedValue(modelsResponse(["mistral-7b"]));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://10.0.0.1:8000/v1/models",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockServerUpdate).toHaveBeenCalledWith({
      where: { id: "srv-1" },
      data: expect.objectContaining({
        status: "ready",
        loadedModel: "mistral-7b",
        healthCheckAt: expect.any(Date),
      }),
    });
    expect(body.summary).toEqual({ total: 1, online: 1, offline: 0 });
    expect(body.servers[0]).toEqual({
      ip: "10.0.0.1:8000",
      status: "ready",
      model: "mistral-7b",
      changed: true, // offline → ready
    });
  });

  it("marks a server offline on network error without clobbering loadedModel", async () => {
    mockServerFindMany.mockResolvedValue([server()]);
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    const updateData = mockServerUpdate.mock.calls[0][0].data;
    expect(updateData.status).toBe("offline");
    // No model came back — the stale-but-useful loadedModel must survive
    expect(updateData).not.toHaveProperty("loadedModel");
    expect(body.summary.offline).toBe(1);
    expect(body.servers[0].changed).toBe(true); // ready → offline
  });

  it("treats a non-OK response as offline", async () => {
    mockServerFindMany.mockResolvedValue([server()]);
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.summary.offline).toBe(1);
  });

  it("treats an empty model list as offline (vLLM up but nothing loaded)", async () => {
    mockServerFindMany.mockResolvedValue([server()]);
    mockFetch.mockResolvedValue(modelsResponse([]));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.summary.offline).toBe(1);
    expect(body.servers[0].model).toBeNull();
  });

  it("checks all servers and reports unchanged statuses with changed: false", async () => {
    mockServerFindMany.mockResolvedValue([
      server({ id: "srv-1", ipAddress: "10.0.0.1", status: "ready" }),
      server({ id: "srv-2", ipAddress: "10.0.0.2", status: "offline" }),
    ]);
    mockFetch
      .mockResolvedValueOnce(modelsResponse(["llama-3-70b"]))
      .mockRejectedValueOnce(new Error("timeout"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.summary).toEqual({ total: 2, online: 1, offline: 1 });
    expect(mockServerUpdate).toHaveBeenCalledTimes(2);
    const changedFlags = Object.fromEntries(
      body.servers.map((s: { ip: string; changed: boolean }) => [s.ip, s.changed]),
    );
    expect(changedFlags["10.0.0.1:8000"]).toBe(false); // ready → ready
    expect(changedFlags["10.0.0.2:8000"]).toBe(false); // offline → offline
  });

  it("returns 500 when the server query fails", async () => {
    mockServerFindMany.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to check servers");
  });
});
