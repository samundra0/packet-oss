// Tests for src/app/api/v1/account/route.ts and src/app/api/v1/billing/route.ts.
//
// Pinned contracts:
//   * account: returns the Stripe identity + team id; deleted customers 404
//   * billing: date validation (start/end), defaults to the current UTC
//     month, pool_label preferred over pool_name, hours aggregation with
//     cost-based fallback, and HAI billing failure degrades to a zeroed
//     summary (200) rather than an error — the API stays readable even
//     when HAI is down

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateApiKey,
  mockCheckRateLimit,
  mockGetStripe,
  mockCustomersRetrieve,
  mockGetTeamBillingSummaryV2,
  mockFormatBillingDatetime,
} = vi.hoisted(() => ({
  mockAuthenticateApiKey: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockGetStripe: vi.fn(),
  mockCustomersRetrieve: vi.fn(),
  mockGetTeamBillingSummaryV2: vi.fn(),
  mockFormatBillingDatetime: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  authenticateApiKey: mockAuthenticateApiKey,
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock("@/lib/stripe", () => ({ getStripe: mockGetStripe }));
vi.mock("@/lib/hostedai", () => ({
  getTeamBillingSummaryV2: mockGetTeamBillingSummaryV2,
  formatBillingDatetime: mockFormatBillingDatetime,
}));

import { GET as accountGET } from "@/app/api/v1/account/route";
import { GET as billingGET } from "@/app/api/v1/billing/route";

const RATE_INFO = { limit: 100, remaining: 99, reset: 1750000000 };

function makeRequest(url: string) {
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: "Bearer pk_live_test" },
  });
}

describe("/api/v1/account", () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockResolvedValue({
      keyId: "key-1",
      customerId: "cus_1",
      teamId: "team-1",
      scopes: "*",
    });
    mockCheckRateLimit.mockReturnValue({ allowed: true, info: RATE_INFO });
    mockGetStripe.mockResolvedValue({
      customers: { retrieve: mockCustomersRetrieve },
    });
    mockCustomersRetrieve.mockResolvedValue({
      id: "cus_1",
      email: "user@x.com",
      name: "Ada",
      created: 1700000000,
      metadata: { hostedai_team_id: "team-1", status: "active" },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the Stripe identity with team id and creation date", async () => {
    const res = await accountGET(makeRequest("http://localhost/api/v1/account"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      id: "cus_1",
      email: "user@x.com",
      name: "Ada",
      teamId: "team-1",
      createdAt: new Date(1700000000 * 1000).toISOString(),
      metadata: { status: "active" },
    });
  });

  it("404s for a deleted Stripe customer", async () => {
    mockCustomersRetrieve.mockResolvedValue({ id: "cus_1", deleted: true });

    const res = await accountGET(makeRequest("http://localhost/api/v1/account"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

describe("/api/v1/billing", () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockResolvedValue({
      keyId: "key-1",
      customerId: "cus_1",
      teamId: "team-1",
      scopes: "*",
    });
    mockCheckRateLimit.mockReturnValue({ allowed: true, info: RATE_INFO });
    mockFormatBillingDatetime.mockImplementation((d: Date) => d.toISOString());
    mockGetTeamBillingSummaryV2.mockResolvedValue({ total_cost: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects malformed start/end dates with 400", async () => {
    const badStart = await billingGET(
      makeRequest("http://localhost/api/v1/billing?start=not-a-date"),
    );
    expect(badStart.status).toBe(400);

    const badEnd = await billingGET(
      makeRequest("http://localhost/api/v1/billing?end=garbage"),
    );
    expect(badEnd.status).toBe(400);

    expect(mockGetTeamBillingSummaryV2).not.toHaveBeenCalled();
  });

  it("defaults the period to the current UTC month", async () => {
    const res = await billingGET(makeRequest("http://localhost/api/v1/billing"));
    const body = await res.json();

    const now = new Date();
    const expectedStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    expect(body.data.periodStart).toBe(expectedStart);
    expect(mockGetTeamBillingSummaryV2).toHaveBeenCalledWith(
      "team-1",
      expectedStart,
      expect.any(String),
    );
  });

  it("aggregates pool + instance hours and prefers pool_label for display", async () => {
    mockGetTeamBillingSummaryV2.mockResolvedValue({
      total_cost: "12.5",
      gpuaas_summary: [
        { pool_name: "internal-name", pool_label: "RTX 4090", pool_hours: 3, cost: 6 },
        { pool_name: "no-label-pool", pool_hours: 2, cost: 4 },
      ],
      instance_billing_summary: [{ hours: 5 }],
    });

    const res = await billingGET(makeRequest("http://localhost/api/v1/billing"));
    const body = await res.json();

    expect(body.data.totalCost).toBe(12.5);
    expect(body.data.gpuHours).toBe(10); // 3 + 2 pool + 5 instance
    expect(body.data.gpuaasSummary[0].pool_name).toBe("RTX 4090"); // label wins
    expect(body.data.gpuaasSummary[1].pool_name).toBe("no-label-pool");
  });

  it("estimates hours from cost when HAI reports zero hours", async () => {
    mockGetTeamBillingSummaryV2.mockResolvedValue({ total_cost: 10 });

    const res = await billingGET(makeRequest("http://localhost/api/v1/billing"));
    const body = await res.json();

    expect(body.data.gpuHours).toBe(5); // cost / 2 approximation
  });

  it("degrades to a zeroed summary (200) when HAI billing is down", async () => {
    mockGetTeamBillingSummaryV2.mockRejectedValue(new Error("HAI 502"));

    const res = await billingGET(makeRequest("http://localhost/api/v1/billing"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.totalCost).toBe(0);
    expect(body.data.gpuHours).toBe(0);
    expect(body.data.gpuaasSummary).toEqual([]);
  });
});
