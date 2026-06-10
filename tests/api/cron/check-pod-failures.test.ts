// Tests for src/app/api/cron/check-pod-failures/route.ts.
//
// Every-5-minutes scanner that turns failed customer pods into URGENT Zammad
// tickets + support emails, deduped via PodFailureAlert. Pinned contracts:
//   * Auth gating
//   * Team discovery comes from the pool overview cache (only teams with
//     active pods get a hosted.ai call)
//   * New failure → ticket + email + dedup record (with the ticket id)
//   * Existing PodFailureAlert row → counted as alreadyAlerted, no re-alert
//   * Only active/subscribed subscriptions alert; cancelled ones don't page
//   * Ticket-creation failure must not block the email or the dedup record
//   * Recovered pods get their alert rows cleaned up so a re-failure
//     re-alerts; still-failed pods keep theirs
//   * Per-team error isolation; fatal error → 500
//
// The route resolves Zammad's createTicket via a dynamic import gated on
// isPro() — we mock the edition to Pro and the zammad client module so the
// import resolves to our mock.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockCustomerCacheFindMany,
  mockAlertFindUnique,
  mockAlertCreate,
  mockAlertFindMany,
  mockAlertDeleteMany,
  mockGetPoolSubscriptions,
  mockReadPoolOverviewCache,
  mockSendPodFailureAlertEmail,
  mockCreateTicket,
} = vi.hoisted(() => ({
  mockCustomerCacheFindMany: vi.fn(),
  mockAlertFindUnique: vi.fn(),
  mockAlertCreate: vi.fn(),
  mockAlertFindMany: vi.fn(),
  mockAlertDeleteMany: vi.fn(),
  mockGetPoolSubscriptions: vi.fn(),
  mockReadPoolOverviewCache: vi.fn(),
  mockSendPodFailureAlertEmail: vi.fn(),
  mockCreateTicket: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customerCache: { findMany: mockCustomerCacheFindMany },
    podFailureAlert: {
      findUnique: mockAlertFindUnique,
      create: mockAlertCreate,
      findMany: mockAlertFindMany,
      deleteMany: mockAlertDeleteMany,
    },
  },
}));
vi.mock("@/lib/hostedai", () => ({
  getPoolSubscriptions: mockGetPoolSubscriptions,
}));
vi.mock("@/lib/pool-overview", () => ({
  readPoolOverviewCache: mockReadPoolOverviewCache,
}));
vi.mock("@/lib/email/templates/pod-failure", () => ({
  sendPodFailureAlertEmail: mockSendPodFailureAlertEmail,
}));
vi.mock("@/lib/edition", () => ({ isPro: () => true }));
vi.mock("@/lib/zammad/client", () => ({ createTicket: mockCreateTicket }));

import { GET } from "@/app/api/cron/check-pod-failures/route";

const SECRET = "cron-failures-secret";
const ORIGINAL = process.env.CRON_SECRET;

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/check-pod-failures", {
    method: "GET",
    headers,
  });
}

function poolCacheWith(teamId = "team-1", customerEmail = "user@x.com") {
  return {
    pools: [
      {
        pods: [{ teamId, status: "running", customerEmail }],
      },
    ],
  };
}

function subscriptionWith(podStatus: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    status: "subscribed",
    pool_name: "rtx4090",
    region: { region_name: "eu-west" },
    pods: [{ pod_name: "pod-abc", pod_status: podStatus, gpu_count: 2 }],
    ...overrides,
  };
}

describe("GET /api/cron/check-pod-failures", () => {
  beforeEach(async () => {
    // The route assigns createTicket inside a module-level dynamic import's
    // .then() — wait for that to settle or the Pro-only ticket path is a
    // silent no-op in early tests.
    await vi.dynamicImportSettled();
    process.env.CRON_SECRET = SECRET;
    mockReadPoolOverviewCache.mockReturnValue(null);
    mockCustomerCacheFindMany.mockResolvedValue([
      { id: "cus_1", teamId: "team-1", email: "user@x.com" },
    ]);
    mockGetPoolSubscriptions.mockResolvedValue([]);
    mockAlertFindUnique.mockResolvedValue(null);
    mockAlertCreate.mockResolvedValue({});
    mockAlertFindMany.mockResolvedValue([]);
    mockAlertDeleteMany.mockResolvedValue({ count: 0 });
    mockSendPodFailureAlertEmail.mockResolvedValue(undefined);
    mockCreateTicket.mockResolvedValue({ id: 9001 });
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without reading caches", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockReadPoolOverviewCache).not.toHaveBeenCalled();
  });

  it("exits early when the pool cache has no active teams", async () => {
    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results.teamsChecked).toBe(0);
    expect(mockGetPoolSubscriptions).not.toHaveBeenCalled();
  });

  it("only calls hosted.ai for teams that have active pods in the cache", async () => {
    mockReadPoolOverviewCache.mockReturnValue({
      pools: [
        {
          pods: [
            { teamId: "team-1", status: "running" },
            { teamId: "team-stopped", status: "stopped" }, // not active
          ],
        },
      ],
    });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockGetPoolSubscriptions).toHaveBeenCalledTimes(1);
    expect(mockGetPoolSubscriptions).toHaveBeenCalledWith("team-1");
    expect(body.results.teamsChecked).toBe(1);
  });

  it("creates a ticket, sends the email, and records the dedup alert on a new failure", async () => {
    mockReadPoolOverviewCache.mockReturnValue(poolCacheWith());
    mockGetPoolSubscriptions.mockResolvedValue([
      subscriptionWith("CrashLoopBackOff"),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockCreateTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("[URGENT] Pod Failed: pod-abc"),
        priority_id: 3,
      }),
    );
    expect(mockSendPodFailureAlertEmail).toHaveBeenCalledWith({
      podName: "pod-abc",
      podStatus: "crashloopbackoff",
      subscriptionId: "42",
      teamId: "team-1",
      customerEmail: "user@x.com",
      poolName: "rtx4090",
      gpuCount: 2,
      region: "eu-west",
      zammadTicketId: 9001,
    });
    expect(mockAlertCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subscriptionId: "42",
        podName: "pod-abc",
        zammadTicketId: 9001,
      }),
    });
    expect(body.results.failuresDetected).toBe(1);
    expect(body.results.ticketsCreated).toBe(1);
    expect(body.results.emailsSent).toBe(1);
  });

  it("does not re-alert for a failure that already has an alert row", async () => {
    mockReadPoolOverviewCache.mockReturnValue(poolCacheWith());
    mockGetPoolSubscriptions.mockResolvedValue([subscriptionWith("failed")]);
    mockAlertFindUnique.mockResolvedValue({ id: "alert-1" });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.results.alreadyAlerted).toBe(1);
    expect(mockCreateTicket).not.toHaveBeenCalled();
    expect(mockSendPodFailureAlertEmail).not.toHaveBeenCalled();
    expect(mockAlertCreate).not.toHaveBeenCalled();
  });

  it("ignores failures on cancelled subscriptions (no paging for terminated pods)", async () => {
    mockReadPoolOverviewCache.mockReturnValue(poolCacheWith());
    mockGetPoolSubscriptions.mockResolvedValue([
      subscriptionWith("failed", { status: "cancelled" }),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.results.failuresDetected).toBe(0);
    expect(mockSendPodFailureAlertEmail).not.toHaveBeenCalled();
  });

  it("still sends the email and records the alert when Zammad ticket creation fails", async () => {
    mockReadPoolOverviewCache.mockReturnValue(poolCacheWith());
    mockGetPoolSubscriptions.mockResolvedValue([subscriptionWith("oom_killed")]);
    mockCreateTicket.mockRejectedValue(new Error("zammad down"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockSendPodFailureAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ zammadTicketId: null }),
    );
    expect(mockAlertCreate).toHaveBeenCalled();
    expect(body.results.ticketsCreated).toBe(0);
    expect(body.results.emailsSent).toBe(1);
    expect(body.results.errors[0]).toContain("Failed to create Zammad ticket");
  });

  it("cleans up alerts for recovered pods but keeps still-failed ones", async () => {
    mockReadPoolOverviewCache.mockReturnValue(poolCacheWith());
    mockGetPoolSubscriptions.mockResolvedValue([
      subscriptionWith("failed"), // pod-abc on sub 42 is still failed
    ]);
    mockAlertFindUnique.mockResolvedValue({ id: "alert-existing" });
    mockAlertFindMany.mockResolvedValue([
      { id: "alert-still-failed", subscriptionId: "42", podName: "pod-abc" },
      { id: "alert-recovered", subscriptionId: "7", podName: "pod-old" },
    ]);

    await GET(makeRequest(SECRET));

    expect(mockAlertDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alert-recovered"] } },
    });
  });

  it("isolates per-team hosted.ai errors and keeps checking other teams", async () => {
    mockReadPoolOverviewCache.mockReturnValue({
      pools: [
        {
          pods: [
            { teamId: "team-bad", status: "running" },
            { teamId: "team-good", status: "running" },
          ],
        },
      ],
    });
    mockCustomerCacheFindMany.mockResolvedValue([]);
    mockGetPoolSubscriptions
      .mockRejectedValueOnce(new Error("HAI 502"))
      .mockResolvedValueOnce([subscriptionWith("failed")]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results.errors).toHaveLength(1);
    expect(body.results.errors[0]).toContain("team-bad");
    expect(body.results.failuresDetected).toBe(1);
  });

  it("returns 500 when the customer cache read fails", async () => {
    mockReadPoolOverviewCache.mockReturnValue(poolCacheWith());
    mockCustomerCacheFindMany.mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Pod failure check failed");
  });
});
