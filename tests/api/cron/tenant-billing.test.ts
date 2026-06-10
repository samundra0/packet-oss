// Tests for src/app/api/cron/tenant-billing/route.ts.
//
// Hourly wallet billing for white-label tenant pods. Money-moving code: a
// bug double-charges customers or never suspends pods after the wallet hits
// zero. Pinned contracts:
//   * Auth gating
//   * Pods are only charged after a full hour elapses; hoursDue is floored
//   * Dedup: syncCycleId derives from subscriptionId + billing timestamp,
//     and alreadyProcessed debits do NOT advance tenantLastBilledAt
//   * Insufficient funds: drain remaining balance (partial), suspend ALL of
//     the customer's pods once, and skip their other pods this run
//   * Successful charge advances tenantLastBilledAt to the billed boundary
//     (not "now") and triggers the low-balance check with total burn rate
//   * Pods without a wallet-enabled TenantCustomer are ignored
//   * Per-pod error isolation; fatal DB error → 500

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockPodFindMany,
  mockPodUpdate,
  mockTenantCustomerFindMany,
  mockDebitTenantWallet,
  mockSuspendCustomerPods,
  mockCheckLowBalance,
} = vi.hoisted(() => ({
  mockPodFindMany: vi.fn(),
  mockPodUpdate: vi.fn(),
  mockTenantCustomerFindMany: vi.fn(),
  mockDebitTenantWallet: vi.fn(),
  mockSuspendCustomerPods: vi.fn(),
  mockCheckLowBalance: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    podMetadata: { findMany: mockPodFindMany, update: mockPodUpdate },
    tenantCustomer: { findMany: mockTenantCustomerFindMany },
  },
}));
vi.mock("@/lib/tenant/wallet", () => ({
  debitTenantWallet: mockDebitTenantWallet,
  suspendCustomerPods: mockSuspendCustomerPods,
  checkLowBalance: mockCheckLowBalance,
}));

import { GET } from "@/app/api/cron/tenant-billing/route";

const SECRET = "cron-tenant-billing-secret";
const ORIGINAL = process.env.CRON_SECRET;
const HOUR_MS = 60 * 60 * 1000;

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/tenant-billing", {
    method: "GET",
    headers,
  });
}

function pod(overrides: Record<string, unknown> = {}) {
  return {
    id: "pod-1",
    tenantId: "tenant-a",
    stripeCustomerId: "cus_1",
    subscriptionId: "sub-1",
    poolId: "rtx4090",
    displayName: "My Pod",
    hourlyRateCents: 100,
    tenantLastBilledAt: new Date(Date.now() - 90 * 60 * 1000), // 1.5h ago
    createdAt: new Date(Date.now() - 10 * 24 * HOUR_MS),
    ...overrides,
  };
}

function tenantCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: "tc-1",
    tenantId: "tenant-a",
    stripeCustomerId: "cus_1",
    walletEnabled: true,
    balanceCents: 10000,
    ...overrides,
  };
}

describe("GET /api/cron/tenant-billing", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockPodFindMany.mockResolvedValue([]);
    mockPodUpdate.mockResolvedValue({});
    mockTenantCustomerFindMany.mockResolvedValue([tenantCustomer()]);
    mockDebitTenantWallet.mockResolvedValue({ newBalanceCents: 9900 });
    mockSuspendCustomerPods.mockResolvedValue(undefined);
    mockCheckLowBalance.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without billing anything", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockPodFindMany).not.toHaveBeenCalled();
    expect(mockDebitTenantWallet).not.toHaveBeenCalled();
  });

  it("excludes the default tenant and inactive pods at the query level", async () => {
    await GET(makeRequest(SECRET));

    expect(mockPodFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: { not: "default" },
        startupScriptStatus: {
          notIn: ["stopped", "terminated", "failed", "suspended"],
        },
      },
    });
  });

  it("returns processed: 0 with no active tenant pods", async () => {
    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body).toEqual({ success: true, processed: 0, results: [] });
  });

  it("does not charge a pod that is not yet a full hour past last billing", async () => {
    mockPodFindMany.mockResolvedValue([
      pod({ tenantLastBilledAt: new Date(Date.now() - 30 * 60 * 1000) }),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockDebitTenantWallet).not.toHaveBeenCalled();
    expect(body.charged).toBe(0);
  });

  it("charges floored whole hours and advances lastBilledAt to the billed boundary", async () => {
    const lastBilled = new Date(Date.now() - (2 * HOUR_MS + 45 * 60 * 1000)); // 2.75h ago
    mockPodFindMany.mockResolvedValue([pod({ tenantLastBilledAt: lastBilled })]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    // 2 whole hours at 100c/h — the 45min remainder waits for the next run
    expect(mockDebitTenantWallet).toHaveBeenCalledTimes(1);
    const [tenantId, customerId, amountCents, , syncCycleId] =
      mockDebitTenantWallet.mock.calls[0];
    expect(tenantId).toBe("tenant-a");
    expect(customerId).toBe("tc-1");
    expect(amountCents).toBe(200);
    const expectedBoundary = new Date(lastBilled.getTime() + 2 * HOUR_MS);
    expect(syncCycleId).toBe(`tbill_sub-1_${expectedBoundary.toISOString()}`);
    expect(mockPodUpdate).toHaveBeenCalledWith({
      where: { id: "pod-1" },
      data: { tenantLastBilledAt: expectedBoundary },
    });
    expect(body.charged).toBe(1);
  });

  it("skips dedup'd charges without advancing lastBilledAt", async () => {
    mockPodFindMany.mockResolvedValue([pod()]);
    mockDebitTenantWallet.mockResolvedValue({ alreadyProcessed: true });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockPodUpdate).not.toHaveBeenCalled();
    expect(body.results[0].action).toBe("skipped");
    expect(body.results[0].reason).toMatch(/already charged/i);
  });

  it("drains remaining balance and suspends all pods on insufficient funds", async () => {
    mockPodFindMany.mockResolvedValue([pod()]);
    mockTenantCustomerFindMany.mockResolvedValue([
      tenantCustomer({ balanceCents: 40 }),
    ]);
    mockDebitTenantWallet
      .mockResolvedValueOnce({ insufficientFunds: true })
      .mockResolvedValueOnce({ newBalanceCents: 0 }); // partial drain

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    // Partial debit for the remaining 40c with a distinct dedup suffix
    expect(mockDebitTenantWallet).toHaveBeenCalledTimes(2);
    expect(mockDebitTenantWallet.mock.calls[1][2]).toBe(40);
    expect(mockDebitTenantWallet.mock.calls[1][4]).toMatch(/_partial$/);
    expect(mockSuspendCustomerPods).toHaveBeenCalledWith("tenant-a", "tc-1");
    expect(mockPodUpdate).not.toHaveBeenCalled(); // nothing was billed
    expect(body.suspended).toBe(1);
  });

  it("skips a suspended customer's remaining pods in the same run", async () => {
    mockPodFindMany.mockResolvedValue([
      pod({ id: "pod-1", subscriptionId: "sub-1" }),
      pod({ id: "pod-2", subscriptionId: "sub-2" }),
    ]);
    mockTenantCustomerFindMany.mockResolvedValue([
      tenantCustomer({ balanceCents: 0 }),
    ]);
    mockDebitTenantWallet.mockResolvedValue({ insufficientFunds: true });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    // One suspension, second pod never attempted
    expect(mockSuspendCustomerPods).toHaveBeenCalledTimes(1);
    expect(mockDebitTenantWallet).toHaveBeenCalledTimes(1);
    expect(body.suspended).toBe(1);
  });

  it("triggers the low-balance check with the customer's total hourly burn", async () => {
    mockPodFindMany.mockResolvedValue([
      pod({ id: "pod-1", subscriptionId: "sub-1", hourlyRateCents: 100 }),
      pod({
        id: "pod-2",
        subscriptionId: "sub-2",
        hourlyRateCents: 250,
        // Not yet due — exists only to contribute to the burn rate
        tenantLastBilledAt: new Date(Date.now() - 10 * 60 * 1000),
      }),
    ]);
    mockDebitTenantWallet.mockResolvedValue({ newBalanceCents: 500 });

    await GET(makeRequest(SECRET));

    expect(mockCheckLowBalance).toHaveBeenCalledWith(
      "tenant-a",
      "tc-1",
      500,
      350, // 100 + 250
    );
  });

  it("ignores pods whose customer has no wallet enabled", async () => {
    mockPodFindMany.mockResolvedValue([pod()]);
    mockTenantCustomerFindMany.mockResolvedValue([
      tenantCustomer({ walletEnabled: false }),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockDebitTenantWallet).not.toHaveBeenCalled();
    expect(body.charged).toBe(0);
  });

  it("isolates per-pod errors so other pods still bill", async () => {
    mockPodFindMany.mockResolvedValue([
      pod({ id: "pod-bad", subscriptionId: "sub-bad" }),
      pod({ id: "pod-good", subscriptionId: "sub-good" }),
    ]);
    // Same customer key, but first debit throws
    mockDebitTenantWallet
      .mockRejectedValueOnce(new Error("wallet service down"))
      .mockResolvedValueOnce({ newBalanceCents: 9800 });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.errors).toBe(1);
    expect(body.charged).toBe(1);
    expect(body.results[0]).toMatchObject({
      podId: "pod-bad",
      action: "error",
      reason: "wallet service down",
    });
  });

  it("returns 500 when the pod query fails", async () => {
    mockPodFindMany.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to process tenant billing");
  });
});
