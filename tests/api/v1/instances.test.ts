// Tests for src/app/api/v1/instances/route.ts (list + launch).
//
// POST is the public API's money path (PA-158 hardened): wallet is
// pre-charged 30 minutes BEFORE the HAI deploy, refunded if the deploy
// throws, and ownership of the refund is handed to the background monitor
// once metadata is saved. Pinned contracts:
//   * GET aggregates instances across ALL the customer's teams (hourly +
//     monthly Stripe accounts), tolerating per-team fetch failures
//   * POST validation ladder: name, pool_id, product, serviceId, pricing
//   * Balance gate: 402 before any charge when the wallet can't cover the
//     30-minute minimum (rate × gpuCount / 2)
//   * Pre-charge → deploy → metadata(provisioning) → monitor handoff
//   * Deploy failure → refund fires, capacity errors map to 503
//   * Service-locked GPU count overrides the requested vgpus (and scales
//     the pre-charge)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateApiKey,
  mockCheckRateLimit,
  mockCreateInstance,
  mockGetUnifiedInstances,
  mockGetUnifiedInstanceDetail,
  mockGetServiceProvisioningInfo,
  mockGetServiceCompatibleGPUPools,
  mockGetTeamWorkspaces,
  mockCreateSharedVolume,
  mockGetSharedVolumes,
  mockGetHAIService,
  mockGetServiceCompatibleRegions,
  mockResolveAllTeamsForEmail,
  mockGetStripe,
  mockCustomersRetrieve,
  mockGetWalletBalance,
  mockDeductUsage,
  mockRefundDeployment,
  mockMonitorDeployStatus,
  mockGetProductByPoolId,
  mockRecordFirstGpuDeploy,
  mockAddSpend,
  mockGpuProductFindUnique,
  mockPodMetadataCreate,
  mockPodMetadataFindMany,
  mockInstallMetricsCollector,
  mockRunStartupScript,
} = vi.hoisted(() => ({
  mockAuthenticateApiKey: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockCreateInstance: vi.fn(),
  mockGetUnifiedInstances: vi.fn(),
  mockGetUnifiedInstanceDetail: vi.fn(),
  mockGetServiceProvisioningInfo: vi.fn(),
  mockGetServiceCompatibleGPUPools: vi.fn(),
  mockGetTeamWorkspaces: vi.fn(),
  mockCreateSharedVolume: vi.fn(),
  mockGetSharedVolumes: vi.fn(),
  mockGetHAIService: vi.fn(),
  mockGetServiceCompatibleRegions: vi.fn(),
  mockResolveAllTeamsForEmail: vi.fn(),
  mockGetStripe: vi.fn(),
  mockCustomersRetrieve: vi.fn(),
  mockGetWalletBalance: vi.fn(),
  mockDeductUsage: vi.fn(),
  mockRefundDeployment: vi.fn(),
  mockMonitorDeployStatus: vi.fn(),
  mockGetProductByPoolId: vi.fn(),
  mockRecordFirstGpuDeploy: vi.fn(),
  mockAddSpend: vi.fn(),
  mockGpuProductFindUnique: vi.fn(),
  mockPodMetadataCreate: vi.fn(),
  mockPodMetadataFindMany: vi.fn(),
  mockInstallMetricsCollector: vi.fn(),
  mockRunStartupScript: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  authenticateApiKey: mockAuthenticateApiKey,
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock("@/lib/hostedai", () => ({
  createInstance: mockCreateInstance,
  getUnifiedInstances: mockGetUnifiedInstances,
  getUnifiedInstanceDetail: mockGetUnifiedInstanceDetail,
  getInstanceCredentials: vi.fn(),
  getServiceProvisioningInfo: mockGetServiceProvisioningInfo,
  getServiceCompatibleGPUPools: mockGetServiceCompatibleGPUPools,
  getTeamWorkspaces: mockGetTeamWorkspaces,
  createSharedVolume: mockCreateSharedVolume,
  getSharedVolumes: mockGetSharedVolumes,
  getHAIService: mockGetHAIService,
  getServiceCompatibleRegions: mockGetServiceCompatibleRegions,
}));
vi.mock("@/lib/customer-resolver", () => ({
  resolveAllTeamsForEmail: mockResolveAllTeamsForEmail,
}));
vi.mock("@/lib/stripe", () => ({ getStripe: mockGetStripe }));
vi.mock("@/lib/wallet", () => ({
  getWalletBalance: mockGetWalletBalance,
  deductUsage: mockDeductUsage,
  refundDeployment: mockRefundDeployment,
}));
vi.mock("@/lib/deploy-monitor", () => ({
  monitorDeployStatus: mockMonitorDeployStatus,
}));
vi.mock("@/lib/products", () => ({ getProductByPoolId: mockGetProductByPoolId }));
vi.mock("@/lib/lifecycle", () => ({
  recordFirstGpuDeploy: mockRecordFirstGpuDeploy,
  addSpend: mockAddSpend,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    gpuProduct: { findUnique: mockGpuProductFindUnique },
    podMetadata: {
      create: mockPodMetadataCreate,
      findMany: mockPodMetadataFindMany,
    },
  },
}));
vi.mock("@/lib/metrics-collector", () => ({
  installMetricsCollector: mockInstallMetricsCollector,
}));
vi.mock("@/lib/startup-script-runner", () => ({
  runStartupScript: mockRunStartupScript,
}));

import { GET, POST } from "@/app/api/v1/instances/route";

const RATE_INFO = { limit: 100, remaining: 99, reset: 1750000000 };

function makeGet() {
  return new NextRequest("http://localhost/api/v1/instances", {
    method: "GET",
    headers: { authorization: "Bearer pk_live_test" },
  });
}

function makePost(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/v1/instances", {
    method: "POST",
    headers: { authorization: "Bearer pk_live_test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Fully-specified launch body so provisioning-info auto-resolution is skipped
const LAUNCH_BODY = {
  name: "training-box",
  pool_id: "pool-7",
  region_id: 3,
  instance_type_id: "it-1",
  image_uuid: "img-1",
  ephemeral_storage_block_id: "sb-1",
};

describe("/api/v1/instances", () => {
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
      deleted: false,
      email: "user@x.com",
    });
    mockResolveAllTeamsForEmail.mockResolvedValue(null); // fall back to key team
    mockGetUnifiedInstances.mockResolvedValue({ items: [] });
    mockGetUnifiedInstanceDetail.mockResolvedValue(null);
    mockPodMetadataFindMany.mockResolvedValue([]);
    mockGetProductByPoolId.mockResolvedValue({ id: "prod-1", name: "RTX 4090" });
    mockGpuProductFindUnique.mockResolvedValue({
      id: "prod-1",
      name: "RTX 4090",
      serviceId: "svc-1",
      pricePerHourCents: 200,
    });
    mockGetHAIService.mockResolvedValue({ gpu_config: {} });
    mockGetServiceCompatibleRegions.mockResolvedValue([]);
    mockGetTeamWorkspaces.mockResolvedValue([{ id: "ws-1", name: "default" }]);
    mockGetServiceProvisioningInfo.mockResolvedValue({});
    mockGetServiceCompatibleGPUPools.mockResolvedValue([
      { id: 7, name: "rtx4090", available_vgpus: 4 },
    ]);
    mockGetSharedVolumes.mockResolvedValue([]);
    mockGetWalletBalance.mockResolvedValue({ availableBalance: 100000 });
    mockDeductUsage.mockResolvedValue({ success: true });
    mockRefundDeployment.mockResolvedValue(undefined);
    mockCreateInstance.mockResolvedValue("inst-123");
    mockPodMetadataCreate.mockResolvedValue({});
    mockMonitorDeployStatus.mockResolvedValue(undefined);
    mockRecordFirstGpuDeploy.mockResolvedValue(undefined);
    mockAddSpend.mockResolvedValue(undefined);
    mockInstallMetricsCollector.mockResolvedValue(undefined);
    mockRunStartupScript.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("GET (list)", () => {
    it("returns 401 when authentication fails", async () => {
      const { ApiError } = await import("@/lib/api/errors");
      mockAuthenticateApiKey.mockRejectedValue(ApiError.missingApiKey());

      const res = await GET(makeGet());

      expect(res.status).toBe(401);
      expect(mockGetUnifiedInstances).not.toHaveBeenCalled();
    });

    it("aggregates instances across all of the customer's teams", async () => {
      mockResolveAllTeamsForEmail.mockResolvedValue({
        allTeamIds: ["team-1", "team-monthly"],
      });
      mockGetUnifiedInstances
        .mockResolvedValueOnce({
          items: [{ id: "i-1", name: "a", status: "Running", created_at: "x", ip: null }],
        })
        .mockResolvedValueOnce({
          items: [{ id: "i-2", name: "b", status: "Stopped", created_at: "y", ip: null }],
        });

      const res = await GET(makeGet());
      const body = await res.json();

      expect(mockGetUnifiedInstances).toHaveBeenCalledWith("team-1");
      expect(mockGetUnifiedInstances).toHaveBeenCalledWith("team-monthly");
      expect(body.data.instances).toHaveLength(2);
      expect(body.data.instances[0].status).toBe("running"); // lowercased
    });

    it("tolerates a single team's fetch failing", async () => {
      mockResolveAllTeamsForEmail.mockResolvedValue({
        allTeamIds: ["team-bad", "team-good"],
      });
      mockGetUnifiedInstances
        .mockRejectedValueOnce(new Error("HAI 502"))
        .mockResolvedValueOnce({
          items: [{ id: "i-2", name: "b", status: "running", created_at: "y", ip: null }],
        });

      const res = await GET(makeGet());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.instances).toHaveLength(1);
    });

    it("falls back to the API key's team when Stripe is unreachable", async () => {
      mockGetStripe.mockRejectedValue(new Error("stripe down"));

      const res = await GET(makeGet());

      expect(res.status).toBe(200);
      expect(mockGetUnifiedInstances).toHaveBeenCalledTimes(1);
      expect(mockGetUnifiedInstances).toHaveBeenCalledWith("team-1");
    });

    it("attaches display-name metadata from PodMetadata", async () => {
      mockGetUnifiedInstances.mockResolvedValue({
        items: [{ id: "i-1", name: "a", status: "running", created_at: "x", ip: null }],
      });
      mockPodMetadataFindMany.mockResolvedValue([
        { instanceId: "i-1", subscriptionId: "s-1", displayName: "My Box", notes: "prod" },
      ]);

      const res = await GET(makeGet());
      const body = await res.json();

      expect(body.data.instances[0].metadata).toEqual({
        displayName: "My Box",
        notes: "prod",
      });
    });
  });

  describe("POST (launch)", () => {
    it("rejects missing name and pool_id before touching the wallet", async () => {
      const noName = await POST(makePost({ pool_id: "pool-7" }));
      expect(noName.status).toBe(400);

      const noPool = await POST(makePost({ name: "x" }));
      expect(noPool.status).toBe(400);

      expect(mockDeductUsage).not.toHaveBeenCalled();
      expect(mockCreateInstance).not.toHaveBeenCalled();
    });

    it("rejects pools without a product or without instance-creation config", async () => {
      mockGetProductByPoolId.mockResolvedValue(null);
      const noProduct = await POST(makePost(LAUNCH_BODY));
      expect(noProduct.status).toBe(400);

      mockGetProductByPoolId.mockResolvedValue({ id: "prod-1", name: "X" });
      mockGpuProductFindUnique.mockResolvedValue({ id: "prod-1", serviceId: null });
      const noService = await POST(makePost(LAUNCH_BODY));
      expect(noService.status).toBe(400);

      expect(mockDeductUsage).not.toHaveBeenCalled();
    });

    it("returns 402 without charging when the wallet can't cover the 30-min minimum", async () => {
      // 200c/hr × 1 GPU × 0.5h = 100c needed
      mockGetWalletBalance.mockResolvedValue({ availableBalance: 99 });

      const res = await POST(makePost(LAUNCH_BODY));
      const body = await res.json();

      expect(res.status).toBe(402);
      expect(body.error.code).toBe("PAYMENT_REQUIRED");
      expect(body.error.message).toContain("$1.00");
      expect(mockDeductUsage).not.toHaveBeenCalled();
      expect(mockCreateInstance).not.toHaveBeenCalled();
    });

    it("pre-charges, deploys, saves provisioning metadata, and hands off to the monitor", async () => {
      const res = await POST(makePost(LAUNCH_BODY));
      const body = await res.json();

      expect(res.status).toBe(201);
      // Pre-charge: 30 minutes of 1 GPU at 200c/hr
      expect(mockDeductUsage).toHaveBeenCalledWith(
        "cus_1",
        0.5,
        expect.stringContaining("RTX 4090"),
        200,
        expect.stringMatching(/^predeploy_cus_1_/),
      );
      // Deploy ordered AFTER the charge succeeded
      expect(mockCreateInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "training-box",
          service_id: "svc-1",
          region_id: 3,
          team_id: "team-1",
          workspace_id: "ws-1",
          pod_opts: expect.objectContaining({ pool_id: 7, vgpus: 1 }),
        }),
      );
      expect(mockPodMetadataCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          instanceId: "inst-123",
          stripeCustomerId: "cus_1",
          prepaidAmountCents: 100,
          deployStatus: "provisioning",
        }),
      });
      expect(mockMonitorDeployStatus).toHaveBeenCalledWith({
        instanceId: "inst-123",
        customerId: "cus_1",
        prechargedCents: 100,
        isMonthlyDeploy: false,
      });
      expect(mockRefundDeployment).not.toHaveBeenCalled();
      expect(body.data).toMatchObject({
        instance_id: "inst-123",
        deploy_status: "provisioning",
        vgpus: 1,
      });
    });

    it("refunds the pre-charge when the HAI deploy fails", async () => {
      mockCreateInstance.mockRejectedValue(new Error("HAI internal error"));

      const res = await POST(makePost(LAUNCH_BODY));

      expect(res.status).toBe(500);
      expect(mockRefundDeployment).toHaveBeenCalledTimes(1); // exactly once — no double refund
      expect(mockRefundDeployment).toHaveBeenCalledWith(
        "cus_1",
        100,
        expect.stringContaining("deployment failed"),
      );
      expect(mockMonitorDeployStatus).not.toHaveBeenCalled();
    });

    it("maps capacity errors to 503 after refunding", async () => {
      mockCreateInstance.mockRejectedValue(new Error("Insufficient resources (10189007)"));

      const res = await POST(makePost(LAUNCH_BODY));
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.error.message).toContain("No GPUs currently available");
      expect(mockRefundDeployment).toHaveBeenCalledTimes(1);
    });

    it("honors a service-locked GPU count and scales the pre-charge", async () => {
      mockGetHAIService.mockResolvedValue({
        gpu_config: { gpu_model_quantity: 4, gpu_model_quantity_lock: true },
      });

      const res = await POST(makePost({ ...LAUNCH_BODY, vgpus: 1 }));
      const body = await res.json();

      // 200c/hr × 4 GPUs × 0.5h = 400c, billed as 2 GPU-hours
      expect(mockDeductUsage).toHaveBeenCalledWith(
        "cus_1",
        2,
        expect.any(String),
        200,
        expect.any(String),
      );
      expect(body.data.vgpus).toBe(4);
    });

    it("fails 402 when the wallet charge itself is declined", async () => {
      mockDeductUsage.mockResolvedValue({ success: false, error: "card declined" });

      const res = await POST(makePost(LAUNCH_BODY));
      const body = await res.json();

      expect(res.status).toBe(402);
      expect(body.error.message).toContain("Failed to process payment");
      expect(mockCreateInstance).not.toHaveBeenCalled();
    });

    it("auto-resolves instance config from provisioning info when omitted", async () => {
      mockGetServiceProvisioningInfo.mockResolvedValue({
        instance_type_details: { default: { id: "it-auto" } },
        image_details: { default: { hash: "img-auto" } },
        storage_block_details: { default: { id: "sb-auto" } },
      });

      const res = await POST(
        makePost({ name: "auto-box", pool_id: "pool-7", region_id: 3 }),
      );

      expect(res.status).toBe(201);
      expect(mockCreateInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          instance_type_id: "it-auto",
          image_hash: "img-auto",
          root_storage_type_id: "sb-auto",
        }),
      );
    });

    it("503s when instance config cannot be resolved", async () => {
      mockGetServiceProvisioningInfo.mockResolvedValue({}); // no defaults

      const res = await POST(
        makePost({ name: "auto-box", pool_id: "pool-7", region_id: 3 }),
      );
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.error.message).toContain("Could not resolve instance configuration");
      expect(mockDeductUsage).not.toHaveBeenCalled();
    });
  });
});
