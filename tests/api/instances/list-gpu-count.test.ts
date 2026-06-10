// PA-183: GPU count in the dashboard card came out as "1 GPU" for a
// multi-GPU instance.
//
// Root cause: GET /api/instances builds each card's gpu_count from the LIST
// endpoint (getUnifiedInstances), whose pod_info often omits vgpu_count (or
// reports 1 while the instance is Pending). The route then fetches the DETAIL
// endpoint — which carries the real vgpu_count — but the backfill loop only
// copied storage + CPU/RAM, never the GPU count, so the stale 1 survived.
//
// What we pin: when the list pod_info lacks vgpu_count but detail reports N,
// both per_pod_info.vgpu_count and pods[0].gpu_count reflect N.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyCustomerToken,
  mockResolveOperatingContext,
  mockGetUnifiedInstances,
  mockGetUnifiedInstanceDetail,
  mockFindManyPodMeta,
  mockFindManyHfDeploy,
} = vi.hoisted(() => ({
  mockVerifyCustomerToken: vi.fn(),
  mockResolveOperatingContext: vi.fn(),
  mockGetUnifiedInstances: vi.fn(),
  mockGetUnifiedInstanceDetail: vi.fn(),
  mockFindManyPodMeta: vi.fn(),
  mockFindManyHfDeploy: vi.fn(),
}));

vi.mock("@/lib/customer-auth", () => ({
  verifyCustomerToken: mockVerifyCustomerToken,
  generateCustomerToken: vi.fn(() => "tok"),
}));
vi.mock("@/lib/auth/account-resolver", () => ({
  resolveOperatingContext: mockResolveOperatingContext,
}));
vi.mock("@/lib/hostedai", () => ({
  getUnifiedInstances: mockGetUnifiedInstances,
  getUnifiedInstanceDetail: mockGetUnifiedInstanceDetail,
  createInstance: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/customer-resolver", () => ({ resolveAllTeamsForEmail: vi.fn() }));
vi.mock("@/lib/customer-cache", () => ({ cacheCustomer: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/activity", () => ({ logGPULaunched: vi.fn(), getFirstGpuLaunch: vi.fn() }));
vi.mock("@/lib/email/onboarding-events", () => ({ sendOnboardingEvent: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendGpuLaunchedEmail: vi.fn() }));
vi.mock("@/lib/wallet", () => ({ getWalletBalance: vi.fn(), deductUsage: vi.fn(), refundDeployment: vi.fn() }));
vi.mock("@/lib/deploy-monitor", () => ({ monitorDeployStatus: vi.fn() }));
vi.mock("@/lib/metrics-collector", () => ({ installMetricsCollector: vi.fn() }));
vi.mock("@/lib/startup-script-runner", () => ({ runStartupScript: vi.fn() }));
vi.mock("@/lib/startup-scripts", () => ({ WORKSPACE_SETUP_SCRIPT: "" }));
vi.mock("@/lib/auth/gate", () => ({ gatePermission: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    podMetadata: { findMany: mockFindManyPodMeta },
    huggingFaceDeployment: { findMany: mockFindManyHfDeploy },
  },
}));

import { GET } from "@/app/api/instances/route";

const TOKEN = "Bearer valid.jwt.token";

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyCustomerToken.mockReturnValue({ customerId: "cus_jwt", email: "alice@example.com" });
  mockResolveOperatingContext.mockResolvedValue({
    customer: { id: "cus_op", email: "alice@example.com", metadata: {} },
    accountId: "cus_op",
    allTeamIds: ["team_1"],
  });
  mockFindManyPodMeta.mockResolvedValue([]);
  mockFindManyHfDeploy.mockResolvedValue([]);
});

function req() {
  const headers = new Headers();
  headers.set("authorization", TOKEN);
  return new NextRequest("http://localhost/api/instances", { method: "GET", headers });
}

describe("GET /api/instances — PA-183 GPU count backfill", () => {
  it("uses the DETAIL vgpu_count when the LIST omits it (2-GPU instance no longer shows 1)", async () => {
    // LIST response: pod_info WITHOUT vgpu_count (the real-world Pending case)
    mockGetUnifiedInstances.mockResolvedValue({
      items: [{
        id: "i-e6f77650",
        name: "2x test",
        status: "Pending",
        pod_info: { model: "Tesla T4", vendor: "NVIDIA" }, // no vgpu_count
        instance_type: { cpu_cores: 4, ram_mb: 8192 },
      }],
      total_items: 1,
    });
    // DETAIL response: the authoritative pod_info with vgpu_count: 2
    mockGetUnifiedInstanceDetail.mockResolvedValue({
      id: "i-e6f77650",
      pod_info: { model: "Tesla T4", vendor: "NVIDIA", vgpu_count: 2 },
      instance_type: { cpu_cores: 4, ram_mb: 8192 },
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();

    const sub = body.poolSubscriptions[0];
    expect(sub.per_pod_info.vgpu_count).toBe(2);
    expect(sub.pods[0].gpu_count).toBe(2);
  });

  it("falls back to 1 when neither list nor detail reports a count", async () => {
    mockGetUnifiedInstances.mockResolvedValue({
      items: [{ id: "i-1", name: "single", status: "running", pod_info: {}, instance_type: { cpu_cores: 2, ram_mb: 4096 } }],
      total_items: 1,
    });
    mockGetUnifiedInstanceDetail.mockResolvedValue({ id: "i-1", pod_info: {} });

    const res = await GET(req());
    const body = await res.json();
    expect(body.poolSubscriptions[0].pods[0].gpu_count).toBe(1);
  });
});
