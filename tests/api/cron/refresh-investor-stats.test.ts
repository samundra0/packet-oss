// Tests for src/app/api/cron/refresh-investor-stats/route.ts.
//
// Hourly cron that pre-computes investor dashboard stats into a disk cache.
// Pinned contracts:
//   * Auth gating
//   * Per-investor error isolation — one failing compute must not abort the
//     loop; it's counted in `failed` with the email in `errors`
//   * Cache writes happen only for successful computes
//   * getInvestors() blowing up entirely → 500

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetInvestors, mockComputeInvestorStats, mockWriteCachedStats } =
  vi.hoisted(() => ({
    mockGetInvestors: vi.fn(),
    mockComputeInvestorStats: vi.fn(),
    mockWriteCachedStats: vi.fn(),
  }));

vi.mock("@/lib/auth/investor", () => ({ getInvestors: mockGetInvestors }));
vi.mock("@/lib/investor-stats", () => ({
  computeInvestorStats: mockComputeInvestorStats,
  writeCachedStats: mockWriteCachedStats,
}));

import { GET } from "@/app/api/cron/refresh-investor-stats/route";

const SECRET = "cron-investor-secret";
const ORIGINAL = process.env.CRON_SECRET;

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/refresh-investor-stats", {
    method: "GET",
    headers,
  });
}

function investor(email: string, nodeIds: string[] = ["node-1"]) {
  return { email, assignedNodeIds: nodeIds };
}

describe("GET /api/cron/refresh-investor-stats", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockGetInvestors.mockResolvedValue([]);
    mockComputeInvestorStats.mockResolvedValue({ stats: "ok" });
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without computing anything", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockGetInvestors).not.toHaveBeenCalled();
  });

  it("handles zero investors cleanly", async () => {
    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.refreshed).toBe(0);
    expect(body.failed).toBe(0);
    expect(typeof body.elapsedMs).toBe("number");
  });

  it("computes and caches stats for every investor", async () => {
    mockGetInvestors.mockResolvedValue([
      investor("a@x.com"),
      investor("b@x.com"),
    ]);
    const statsA = { revenue: 1 };
    const statsB = { revenue: 2 };
    mockComputeInvestorStats
      .mockResolvedValueOnce(statsA)
      .mockResolvedValueOnce(statsB);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockComputeInvestorStats).toHaveBeenNthCalledWith(1, "a@x.com");
    expect(mockComputeInvestorStats).toHaveBeenNthCalledWith(2, "b@x.com");
    expect(mockWriteCachedStats).toHaveBeenNthCalledWith(1, "a@x.com", statsA);
    expect(mockWriteCachedStats).toHaveBeenNthCalledWith(2, "b@x.com", statsB);
    expect(body.refreshed).toBe(2);
    expect(body.failed).toBe(0);
  });

  it("isolates per-investor failures and keeps processing the rest", async () => {
    mockGetInvestors.mockResolvedValue([
      investor("good1@x.com"),
      investor("bad@x.com"),
      investor("good2@x.com"),
    ]);
    mockComputeInvestorStats
      .mockResolvedValueOnce({ ok: 1 })
      .mockRejectedValueOnce(new Error("HAI timeout"))
      .mockResolvedValueOnce({ ok: 2 });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.refreshed).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.errors).toEqual(["bad@x.com: HAI timeout"]);
    // Failed investor must not get a (stale/partial) cache write
    expect(mockWriteCachedStats).toHaveBeenCalledTimes(2);
  });

  it("returns 500 when getInvestors itself throws", async () => {
    mockGetInvestors.mockRejectedValue(new Error("data dir unreadable"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Cron failed");
    expect(body.message).toBe("data dir unreadable");
  });
});
