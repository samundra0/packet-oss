// Tests for src/app/api/cron/process-batches/route.ts.
//
// Token Factory batch-inference worker. Each run pulls up to 5 jobs
// (priority desc, oldest first), processes up to 10 pending requests per job
// against a vLLM server, and bills per token. Pinned contracts:
//   * Auth gating
//   * Job query ordering and cap (SLA priority before age)
//   * No healthy server → job skipped without failing requests
//   * Requests use the server's actual loadedModel name (vLLM rejects the
//     DB alias) and are prefix-sorted for KV-cache affinity
//   * Successful request: tokens + cost recorded on request, job counters,
//     and usage billing
//   * Failed request: marked failed (error truncated), job failedRequests
//     incremented, loop continues
//   * Job with zero pending requests → completed + completion email
//   * Email failure must not fail the job
//   * Fatal error → 500

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockJobFindMany,
  mockJobUpdate,
  mockJobFindUnique,
  mockRequestFindMany,
  mockRequestUpdate,
  mockRouteToServer,
  mockCalculateCost,
  mockRecordUsage,
  mockSendBatchCompletionEmail,
} = vi.hoisted(() => ({
  mockJobFindMany: vi.fn(),
  mockJobUpdate: vi.fn(),
  mockJobFindUnique: vi.fn(),
  mockRequestFindMany: vi.fn(),
  mockRequestUpdate: vi.fn(),
  mockRouteToServer: vi.fn(),
  mockCalculateCost: vi.fn(),
  mockRecordUsage: vi.fn(),
  mockSendBatchCompletionEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    inferenceBatchJob: {
      findMany: mockJobFindMany,
      update: mockJobUpdate,
      findUnique: mockJobFindUnique,
    },
    inferenceRequest: {
      findMany: mockRequestFindMany,
      update: mockRequestUpdate,
    },
  },
}));
vi.mock("@/lib/token-factory", () => ({
  routeToServer: mockRouteToServer,
  calculateCost: mockCalculateCost,
  recordUsage: mockRecordUsage,
}));
vi.mock("@/lib/email", () => ({
  sendBatchCompletionEmail: mockSendBatchCompletionEmail,
}));

import { POST } from "@/app/api/cron/process-batches/route";

const SECRET = "cron-batches-secret";
const ORIGINAL = process.env.CRON_SECRET;
const mockFetch = vi.fn();

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/process-batches", {
    method: "POST",
    headers,
  });
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    stripeCustomerId: "cus_1",
    teamId: "team-1",
    modelId: "model-1",
    slaType: "24h",
    status: "queued",
    totalRequests: 2,
    completedRequests: 0,
    failedRequests: 0,
    inputTokens: BigInt(0),
    outputTokens: BigInt(0),
    actualCostCents: 0,
    startedAt: null,
    createdAt: new Date("2026-06-06T00:00:00Z"),
    model: { name: "llama-3-8b" },
    ...overrides,
  };
}

function inferenceRequest(id: string, content: string) {
  return {
    id,
    batchJobId: "job-1",
    status: "pending",
    inputData: JSON.stringify({ messages: [{ role: "user", content }] }),
  };
}

function vllmResponse(promptTokens = 100, completionTokens = 50) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "answer" } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    }),
  };
}

describe("POST /api/cron/process-batches", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    vi.stubGlobal("fetch", mockFetch);
    mockJobFindMany.mockResolvedValue([]);
    mockJobUpdate.mockResolvedValue({});
    mockJobFindUnique.mockResolvedValue(null);
    mockRequestFindMany.mockResolvedValue([]);
    mockRequestUpdate.mockResolvedValue({});
    mockRouteToServer.mockResolvedValue({
      host: "10.0.0.1",
      port: 8000,
      loadedModels: ["llama-3-8b-instruct-awq"],
    });
    mockCalculateCost.mockResolvedValue(7);
    mockRecordUsage.mockResolvedValue(undefined);
    mockSendBatchCompletionEmail.mockResolvedValue(undefined);
    mockFetch.mockResolvedValue(vllmResponse());
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without touching jobs", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(mockJobFindMany).not.toHaveBeenCalled();
  });

  it("pulls jobs by SLA priority then age, capped at 5 per run", async () => {
    await POST(makeRequest(SECRET));

    expect(mockJobFindMany).toHaveBeenCalledWith({
      where: { status: { in: ["queued", "processing"] } },
      include: { model: true },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 5,
    });
  });

  it("returns processed: 0 with no pending jobs", async () => {
    const res = await POST(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, processed: 0 });
  });

  it("skips the job (without failing requests) when no healthy server exists", async () => {
    mockJobFindMany.mockResolvedValue([job()]);
    mockRouteToServer.mockResolvedValue(null);

    const res = await POST(makeRequest(SECRET));
    const body = await res.json();

    expect(mockRequestFindMany).not.toHaveBeenCalled();
    expect(body.results[0].errors[0]).toContain("No healthy server");
    expect(body.requestsFailed).toBe(0);
  });

  it("sends requests with the server's loadedModel name, not the DB alias", async () => {
    mockJobFindMany.mockResolvedValue([job()]);
    mockRequestFindMany.mockResolvedValue([inferenceRequest("req-1", "hello")]);
    mockJobFindUnique.mockResolvedValue(job({ completedRequests: 1, totalRequests: 2 }));

    await POST(makeRequest(SECRET));

    expect(mockFetch).toHaveBeenCalledWith(
      "http://10.0.0.1:8000/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.model).toBe("llama-3-8b-instruct-awq");
  });

  it("processes requests in prefix-sorted order for KV-cache affinity", async () => {
    mockJobFindMany.mockResolvedValue([job()]);
    mockRequestFindMany.mockResolvedValue([
      inferenceRequest("req-z", "zebra question about stripes"),
      inferenceRequest("req-a", "alpha question about wolves"),
    ]);
    mockJobFindUnique.mockResolvedValue(null);

    await POST(makeRequest(SECRET));

    // "alpha..." sorts before "zebra..." — req-a should hit vLLM first
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(firstBody.messages[0].content).toContain("alpha");
  });

  it("records tokens, cost, and usage billing on a successful request", async () => {
    mockJobFindMany.mockResolvedValue([job({ slaType: "1h" })]);
    mockRequestFindMany.mockResolvedValue([inferenceRequest("req-1", "hello")]);
    mockFetch.mockResolvedValue(vllmResponse(120, 80));
    mockJobFindUnique.mockResolvedValue(null);

    const res = await POST(makeRequest(SECRET));
    const body = await res.json();

    expect(mockCalculateCost).toHaveBeenCalledWith(120, 80, "batch-1h");
    expect(mockRequestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: expect.objectContaining({
        status: "completed",
        inputTokens: 120,
        outputTokens: 80,
      }),
    });
    expect(mockJobUpdate).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: {
        completedRequests: { increment: 1 },
        inputTokens: { increment: 120 },
        outputTokens: { increment: 80 },
        actualCostCents: { increment: 7 },
      },
    });
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_1",
        requestType: "batch",
        inputTokens: BigInt(120),
        outputTokens: BigInt(80),
        costCents: 7,
      }),
    );
    expect(body.requestsCompleted).toBe(1);
  });

  it("marks a request failed on vLLM error and keeps processing the rest", async () => {
    mockJobFindMany.mockResolvedValue([job()]);
    mockRequestFindMany.mockResolvedValue([
      inferenceRequest("req-bad", "aaa"),
      inferenceRequest("req-good", "bbb"),
    ]);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "CUDA OOM" })
      .mockResolvedValueOnce(vllmResponse());
    mockJobFindUnique.mockResolvedValue(null);

    const res = await POST(makeRequest(SECRET));
    const body = await res.json();

    expect(mockRequestUpdate).toHaveBeenCalledWith({
      where: { id: "req-bad" },
      data: expect.objectContaining({
        status: "failed",
        errorMessage: expect.stringContaining("CUDA OOM"),
      }),
    });
    expect(mockJobUpdate).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { failedRequests: { increment: 1 } },
    });
    expect(body.requestsCompleted).toBe(1);
    expect(body.requestsFailed).toBe(1);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1); // only the success billed
  });

  it("completes the job and emails when no pending requests remain", async () => {
    const finishedJob = job({
      completedRequests: 2,
      totalRequests: 2,
      startedAt: new Date("2026-06-06T01:00:00Z"),
      inputTokens: BigInt(200),
      outputTokens: BigInt(100),
      actualCostCents: 14,
    });
    mockJobFindMany.mockResolvedValue([finishedJob]);
    mockRequestFindMany.mockResolvedValue([]);
    mockJobUpdate.mockResolvedValue(finishedJob);

    const res = await POST(makeRequest(SECRET));
    const body = await res.json();

    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-1" },
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
    expect(mockSendBatchCompletionEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: "job-1",
        totalRequests: 2,
        completedRequests: 2,
        totalCostCents: 14,
      }),
    );
    expect(body.success).toBe(true);
  });

  it("does not fail the run when the completion email fails", async () => {
    const finishedJob = job({ completedRequests: 2 });
    mockJobFindMany.mockResolvedValue([finishedJob]);
    mockRequestFindMany.mockResolvedValue([]);
    mockJobUpdate.mockResolvedValue(finishedJob);
    mockSendBatchCompletionEmail.mockRejectedValue(new Error("SMTP down"));

    const res = await POST(makeRequest(SECRET));

    expect(res.status).toBe(200);
  });

  it("marks the job failed on a critical processing error", async () => {
    mockJobFindMany.mockResolvedValue([job()]);
    // First update (mark processing) blows up → caught by job-level catch
    mockJobUpdate.mockRejectedValueOnce(new Error("db deadlock"));

    const res = await POST(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].errors[0]).toContain("db deadlock");
    expect(mockJobUpdate).toHaveBeenLastCalledWith({
      where: { id: "job-1" },
      data: { status: "failed" },
    });
  });

  it("returns 500 when the job query fails", async () => {
    mockJobFindMany.mockRejectedValue(new Error("db down"));

    const res = await POST(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Batch processing failed");
  });
});
