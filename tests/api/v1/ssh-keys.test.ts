// Tests for src/app/api/v1/ssh-keys/route.ts and ssh-keys/[id]/route.ts.
//
// Pinned contracts:
//   * Listing masks key material (50-char preview); the single-key GET is
//     the only place the full publicKey is returned
//   * POST requires name + publicKey and enforces the 10-key cap
//   * GET/[id] scopes lookups to the caller's customer (foreign id → 404)
//   * DELETE passes the customer id so the lib can enforce ownership

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateApiKey,
  mockCheckRateLimit,
  mockGetSSHKeys,
  mockAddSSHKey,
  mockDeleteSSHKey,
} = vi.hoisted(() => ({
  mockAuthenticateApiKey: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockGetSSHKeys: vi.fn(),
  mockAddSSHKey: vi.fn(),
  mockDeleteSSHKey: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  authenticateApiKey: mockAuthenticateApiKey,
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock("@/lib/ssh-keys", () => ({
  getSSHKeys: mockGetSSHKeys,
  addSSHKey: mockAddSSHKey,
  deleteSSHKey: mockDeleteSSHKey,
}));

import { GET as listGET, POST } from "@/app/api/v1/ssh-keys/route";
import { GET as itemGET, DELETE } from "@/app/api/v1/ssh-keys/[id]/route";

const RATE_INFO = { limit: 100, remaining: 99, reset: 1750000000 };
const PUBLIC_KEY = `ssh-ed25519 ${"A".repeat(60)} user@laptop`;

function makeRequest(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/v1/ssh-keys", {
    method,
    headers: { authorization: "Bearer pk_live_test", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function routeParams(id = "sk-1") {
  return { params: Promise.resolve({ id }) };
}

function sshKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "sk-1",
    name: "laptop",
    fingerprint: "SHA256:abc123",
    publicKey: PUBLIC_KEY,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("/api/v1/ssh-keys", () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockResolvedValue({
      keyId: "key-1",
      customerId: "cus_1",
      teamId: "team-1",
      scopes: "*",
    });
    mockCheckRateLimit.mockReturnValue({ allowed: true, info: RATE_INFO });
    mockGetSSHKeys.mockResolvedValue([]);
    mockAddSSHKey.mockResolvedValue(sshKey());
    mockDeleteSSHKey.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists keys with a masked 50-char preview, never the full key", async () => {
    mockGetSSHKeys.mockResolvedValue([sshKey()]);

    const res = await listGET(makeRequest("GET"));
    const body = await res.json();

    expect(mockGetSSHKeys).toHaveBeenCalledWith("cus_1");
    expect(body.data[0].keyPreview).toBe(PUBLIC_KEY.substring(0, 50) + "...");
    expect(body.data[0]).not.toHaveProperty("publicKey");
  });

  it("requires name and publicKey on create", async () => {
    const noName = await POST(makeRequest("POST", { publicKey: PUBLIC_KEY }));
    expect(noName.status).toBe(400);

    const noKey = await POST(makeRequest("POST", { name: "laptop" }));
    expect(noKey.status).toBe(400);

    expect(mockAddSSHKey).not.toHaveBeenCalled();
  });

  it("enforces the 10-key maximum", async () => {
    mockGetSSHKeys.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => sshKey({ id: `sk-${i}` })),
    );

    const res = await POST(
      makeRequest("POST", { name: "one too many", publicKey: PUBLIC_KEY }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toContain("Maximum of 10");
    expect(mockAddSSHKey).not.toHaveBeenCalled();
  });

  it("adds a key for the authenticated customer (201)", async () => {
    const res = await POST(
      makeRequest("POST", { name: "laptop", publicKey: PUBLIC_KEY }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockAddSSHKey).toHaveBeenCalledWith({
      stripeCustomerId: "cus_1",
      name: "laptop",
      publicKey: PUBLIC_KEY,
    });
    expect(body.data.fingerprint).toBe("SHA256:abc123");
  });

  it("GET /[id] returns the full public key for an owned key only", async () => {
    mockGetSSHKeys.mockResolvedValue([sshKey()]);

    const owned = await itemGET(makeRequest("GET"), routeParams("sk-1"));
    const ownedBody = await owned.json();
    expect(owned.status).toBe(200);
    expect(ownedBody.data.publicKey).toBe(PUBLIC_KEY);

    const foreign = await itemGET(makeRequest("GET"), routeParams("sk-foreign"));
    expect(foreign.status).toBe(404);
  });

  it("DELETE scopes the deletion to the authenticated customer", async () => {
    const res = await DELETE(makeRequest("DELETE"), routeParams("sk-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockDeleteSSHKey).toHaveBeenCalledWith("sk-1", "cus_1");
    expect(body.data).toEqual({ id: "sk-1", deleted: true });
  });

  it("propagates ownership failures from the lib as errors", async () => {
    const { ApiError } = await import("@/lib/api/errors");
    mockDeleteSSHKey.mockRejectedValue(ApiError.notFound("SSH key", "sk-1"));

    const res = await DELETE(makeRequest("DELETE"), routeParams("sk-1"));

    expect(res.status).toBe(404);
  });
});
