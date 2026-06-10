import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma — provide updateMany on podMetadata.
const mockUpdateMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    podMetadata: {
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    },
  },
}));

// Mock the HAI client at the module boundary, then control the high-level
// HAI functions via the exported helpers from instances.ts.
const mockHostedaiRequest = vi.fn();
vi.mock("@/lib/hostedai/client", () => ({
  hostedaiRequest: (...args: unknown[]) => mockHostedaiRequest(...args),
  getCached: vi.fn(() => null),
  setCache: vi.fn(),
  clearCache: vi.fn(),
  getApiUrl: vi.fn(async () => "https://hai.test"),
  getApiKey: vi.fn(async () => "test-key"),
}));

// Mock wallet refund.
const mockRefundDeployment = vi.fn();
vi.mock("@/lib/wallet", () => ({
  refundDeployment: (...args: unknown[]) => mockRefundDeployment(...args),
  // Re-export the other things the deploy-monitor module's import may pull in.
  getWalletBalance: vi.fn(),
  deductUsage: vi.fn(),
}));

import { waitForInstanceRunning } from "@/lib/hostedai/instances";
import { monitorDeployStatus, reconcilePendingDeploy } from "@/lib/deploy-monitor";

const noSleep = () => Promise.resolve();

describe("waitForInstanceRunning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ready=true when HAI status is running", async () => {
    const getDetail = vi.fn().mockResolvedValue({ status: "Running" });
    const result = await waitForInstanceRunning("i-1", {
      maxMs: 5_000,
      intervalMs: 10,
      getDetail,
      sleep: noSleep,
    });
    expect(result).toEqual({ ready: true, finalStatus: "running" });
    expect(getDetail).toHaveBeenCalledOnce();
  });

  it("treats 'active' as ready (HAI sometimes returns Active instead of Running)", async () => {
    const getDetail = vi.fn().mockResolvedValue({ status: "active" });
    const result = await waitForInstanceRunning("i-1", {
      maxMs: 5_000,
      intervalMs: 10,
      getDetail,
      sleep: noSleep,
    });
    expect(result.ready).toBe(true);
  });

  it("returns ready=false with terminal reason when HAI reports error", async () => {
    const getDetail = vi.fn().mockResolvedValue({ status: "Error" });
    const result = await waitForInstanceRunning("i-1", {
      maxMs: 5_000,
      intervalMs: 10,
      getDetail,
      sleep: noSleep,
    });
    expect(result).toEqual({
      ready: false,
      reason: "terminal status: error",
      finalStatus: "error",
    });
  });

  it.each([
    "failed",
    "terminated",
    "succeeded",
    "crashloopbackoff",
    "stopped",
  ])("treats '%s' as terminal failure", async (status) => {
    const getDetail = vi.fn().mockResolvedValue({ status });
    const result = await waitForInstanceRunning("i-1", {
      maxMs: 5_000,
      intervalMs: 10,
      getDetail,
      sleep: noSleep,
    });
    expect(result.ready).toBe(false);
    expect(result.finalStatus).toBe(status);
  });

  it("treats two consecutive 404s as deletion and refunds (HAI deletes failed pods after ~10min)", async () => {
    const getDetail = vi.fn().mockRejectedValue(
      new Error("Hosted.ai API error (404): not found")
    );
    const result = await waitForInstanceRunning("i-1", {
      maxMs: 5_000,
      intervalMs: 10,
      getDetail,
      sleep: noSleep,
    });
    expect(result).toEqual({
      ready: false,
      reason: "instance deleted by HAI",
      finalStatus: "deleted",
    });
    // Must have made at least 2 calls to confirm.
    expect(getDetail).toHaveBeenCalledTimes(2);
  });

  it("does NOT declare deletion on a single 404 followed by a successful response", async () => {
    const getDetail = vi.fn()
      .mockRejectedValueOnce(new Error("Hosted.ai API error (404): transient blip"))
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "running" });
    const result = await waitForInstanceRunning("i-blippy", {
      maxMs: 5_000,
      intervalMs: 10,
      getDetail,
      sleep: noSleep,
    });
    expect(result.ready).toBe(true);
    expect(result.finalStatus).toBe("running");
    expect(getDetail).toHaveBeenCalledTimes(3);
  });

  it("resets 404 streak when a non-404 response comes between two 404s", async () => {
    const getDetail = vi.fn()
      .mockRejectedValueOnce(new Error("Hosted.ai API error (404): blip"))
      .mockResolvedValueOnce({ status: "pending" })          // resets streak
      .mockRejectedValueOnce(new Error("Hosted.ai API error (404): another blip"))
      .mockResolvedValueOnce({ status: "running" });
    const result = await waitForInstanceRunning("i-flap", {
      maxMs: 5_000,
      intervalMs: 10,
      getDetail,
      sleep: noSleep,
    });
    expect(result.ready).toBe(true);
  });

  it("keeps polling on transient 5xx errors", async () => {
    const getDetail = vi.fn()
      .mockRejectedValueOnce(new Error("Hosted.ai API error (502): bad gateway"))
      .mockRejectedValueOnce(new Error("Hosted.ai API error (503): retry"))
      .mockResolvedValueOnce({ status: "running" });
    const result = await waitForInstanceRunning("i-1", {
      maxMs: 5_000,
      intervalMs: 10,
      getDetail,
      sleep: noSleep,
    });
    expect(result.ready).toBe(true);
    expect(getDetail).toHaveBeenCalledTimes(3);
  });

  it("polls multiple times when status is still pending, then resolves running", async () => {
    const getDetail = vi.fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "starting" })
      .mockResolvedValueOnce({ status: "running" });
    const result = await waitForInstanceRunning("i-1", {
      maxMs: 5_000,
      intervalMs: 10,
      getDetail,
      sleep: noSleep,
    });
    expect(result.ready).toBe(true);
    expect(getDetail).toHaveBeenCalledTimes(3);
  });

  it("returns ready=false with timeout reason when status never resolves", async () => {
    const getDetail = vi.fn().mockResolvedValue({ status: "pending" });
    const result = await waitForInstanceRunning("i-1", {
      maxMs: 50,
      intervalMs: 10,
      getDetail,
      sleep: noSleep,
    });
    expect(result.ready).toBe(false);
    expect(result.finalStatus).toBe("timeout");
    expect(result.reason).toMatch(/timeout/);
  });
});

describe("monitorDeployStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockRefundDeployment.mockResolvedValue({ success: true });
    mockHostedaiRequest.mockReset();
  });

  it("on running: marks PodMetadata as 'running' and does not refund", async () => {
    mockHostedaiRequest.mockResolvedValue({ status: "running" });
    const result = await monitorDeployStatus({
      instanceId: "i-ok",
      customerId: "cus_1",
      prechargedCents: 500,
      isMonthlyDeploy: false,
      maxMs: 100,
      intervalMs: 10,
      waitOpts: { sleep: noSleep },
    });
    expect(result.ready).toBe(true);
    expect(mockRefundDeployment).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { instanceId: "i-ok", deployStatus: "provisioning" },
      data: { deployStatus: "running" },
    });
  });

  it("on terminal failure: claims the failure transition, refunds, marks failed", async () => {
    mockHostedaiRequest.mockResolvedValue({ status: "error" });
    const result = await monitorDeployStatus({
      instanceId: "i-bad",
      customerId: "cus_1",
      prechargedCents: 500,
      isMonthlyDeploy: false,
      maxMs: 100,
      intervalMs: 10,
      waitOpts: { sleep: noSleep },
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("terminal status: error");

    // Claim runs first (idempotency guard), refund second.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { instanceId: "i-bad", deployStatus: "provisioning" },
      data: { deployStatus: "failed_refunded", deployStatusReason: "terminal status: error" },
    });
    expect(mockRefundDeployment).toHaveBeenCalledWith(
      "cus_1",
      500,
      expect.stringContaining("i-bad")
    );
  });

  it("does not refund a second time when the failure claim affects 0 rows", async () => {
    // Simulate: another caller (cron) already finalized this deploy.
    mockUpdateMany.mockResolvedValue({ count: 0 });
    mockHostedaiRequest.mockResolvedValue({ status: "failed" });

    await monitorDeployStatus({
      instanceId: "i-race",
      customerId: "cus_1",
      prechargedCents: 500,
      isMonthlyDeploy: false,
      maxMs: 100,
      intervalMs: 10,
      waitOpts: { sleep: noSleep },
    });

    expect(mockRefundDeployment).not.toHaveBeenCalled();
  });

  it("does not refund when isMonthlyDeploy=true (no wallet pre-charge to refund)", async () => {
    mockHostedaiRequest.mockResolvedValue({ status: "error" });
    await monitorDeployStatus({
      instanceId: "i-monthly",
      customerId: "cus_1",
      prechargedCents: 0,
      isMonthlyDeploy: true,
      maxMs: 100,
      intervalMs: 10,
      waitOpts: { sleep: noSleep },
    });
    expect(mockRefundDeployment).not.toHaveBeenCalled();
  });
});

describe("reconcilePendingDeploy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockRefundDeployment.mockResolvedValue({ success: true });
    mockHostedaiRequest.mockReset();
  });

  it("returns still_provisioning when HAI says pending and we're within the timeout window", async () => {
    mockHostedaiRequest.mockResolvedValue({ status: "pending" });
    const result = await reconcilePendingDeploy({
      instanceId: "i-young",
      customerId: "cus_1",
      prechargedCents: 500,
      isMonthlyDeploy: false,
      deployTime: new Date(Date.now() - 60_000), // 1 minute ago
      timeoutMs: 15 * 60 * 1000,
    });
    expect(result.status).toBe("still_provisioning");
    expect(mockRefundDeployment).not.toHaveBeenCalled();
  });

  it("times out a stuck provisioning row past the deadline", async () => {
    mockHostedaiRequest.mockResolvedValue({ status: "pending" });
    const result = await reconcilePendingDeploy({
      instanceId: "i-stale",
      customerId: "cus_1",
      prechargedCents: 500,
      isMonthlyDeploy: false,
      deployTime: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago
      timeoutMs: 15 * 60 * 1000,
    });
    expect(result.status).toBe("failed_refunded");
    expect(result.reason).toMatch(/cron timeout/);
    expect(mockRefundDeployment).toHaveBeenCalled();
  });

  it("refunds on two consecutive 404s (HAI deleted the failed instance)", async () => {
    mockHostedaiRequest.mockRejectedValue(new Error("Hosted.ai API error (404): not found"));
    const result = await reconcilePendingDeploy({
      instanceId: "i-gone",
      customerId: "cus_1",
      prechargedCents: 500,
      isMonthlyDeploy: false,
      deployTime: new Date(Date.now() - 2 * 60 * 1000),
      sleep: noSleep,
    });
    expect(result.status).toBe("failed_refunded");
    expect(result.reason).toBe("instance deleted by HAI");
    expect(mockRefundDeployment).toHaveBeenCalled();
    // At minimum: initial 404 + recheck 404 = 2 status calls (best-effort
    // deleteInstance after refund adds a third call that we don't care about).
    expect(mockHostedaiRequest.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT refund when a single 404 is followed by a successful recheck", async () => {
    mockHostedaiRequest
      .mockRejectedValueOnce(new Error("Hosted.ai API error (404): blip"))
      .mockResolvedValueOnce({ status: "pending" });
    const result = await reconcilePendingDeploy({
      instanceId: "i-recovered",
      customerId: "cus_1",
      prechargedCents: 500,
      isMonthlyDeploy: false,
      deployTime: new Date(Date.now() - 60_000), // young enough — within timeout
      sleep: noSleep,
    });
    expect(result.status).toBe("still_provisioning");
    expect(mockRefundDeployment).not.toHaveBeenCalled();
  });

  it("returns still_provisioning on transient (non-404) HAI errors, leaves DB untouched", async () => {
    mockHostedaiRequest.mockRejectedValue(new Error("Hosted.ai API error (502): bad gateway"));
    const result = await reconcilePendingDeploy({
      instanceId: "i-flaky",
      customerId: "cus_1",
      prechargedCents: 500,
      isMonthlyDeploy: false,
      deployTime: new Date(Date.now() - 30_000),
    });
    expect(result.status).toBe("still_provisioning");
    expect(mockRefundDeployment).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("marks running when HAI confirms running", async () => {
    mockHostedaiRequest.mockResolvedValue({ status: "running" });
    const result = await reconcilePendingDeploy({
      instanceId: "i-late-runner",
      customerId: "cus_1",
      prechargedCents: 500,
      isMonthlyDeploy: false,
      deployTime: new Date(Date.now() - 5 * 60 * 1000),
    });
    expect(result.status).toBe("running");
    expect(mockRefundDeployment).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { instanceId: "i-late-runner", deployStatus: "provisioning" },
      data: { deployStatus: "running" },
    });
  });
});
