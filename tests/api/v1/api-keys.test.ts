// Tests for src/app/api/v1/api-keys/route.ts (list + create) and
// src/app/api/v1/api-keys/[id]/route.ts (revoke).
//
// API keys are the front door to the public API. Pinned contracts:
//   * Authentication failures pass through as proper ApiError responses
//   * Rate-limit denial → 429 with X-RateLimit headers, before any DB work
//   * GET lists only the caller's non-revoked keys, masked (no keyHash)
//   * POST validates name (required, ≤100 chars) and expiresAt (parseable,
//     future); the full key is returned exactly once at creation
//   * DELETE: cross-customer revocation 404s (no key enumeration), the
//     in-use key can't revoke itself, double-revocation rejected
//
// We mock authenticateApiKey / checkRateLimit / generateApiKey but keep the
// REAL response + ApiError helpers so status codes and envelopes stay honest.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuthenticateApiKey,
  mockCheckRateLimit,
  mockGenerateApiKey,
  mockApiKeyFindMany,
  mockApiKeyCreate,
  mockApiKeyFindUnique,
  mockApiKeyUpdate,
} = vi.hoisted(() => ({
  mockAuthenticateApiKey: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockGenerateApiKey: vi.fn(),
  mockApiKeyFindMany: vi.fn(),
  mockApiKeyCreate: vi.fn(),
  mockApiKeyFindUnique: vi.fn(),
  mockApiKeyUpdate: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  authenticateApiKey: mockAuthenticateApiKey,
  checkRateLimit: mockCheckRateLimit,
  generateApiKey: mockGenerateApiKey,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: {
      findMany: mockApiKeyFindMany,
      create: mockApiKeyCreate,
      findUnique: mockApiKeyFindUnique,
      update: mockApiKeyUpdate,
    },
  },
}));

import { GET, POST } from "@/app/api/v1/api-keys/route";
import { DELETE } from "@/app/api/v1/api-keys/[id]/route";
import { ApiError } from "@/lib/api/errors";

const RATE_INFO = { limit: 100, remaining: 99, reset: 1750000000 };

function makeRequest(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/v1/api-keys", {
    method,
    headers: { authorization: "Bearer pk_live_test", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function deleteParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function storedKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    name: "ci key",
    keyPrefix: "pk_live_abc1",
    keyHash: "hash-never-exposed",
    stripeCustomerId: "cus_1",
    teamId: "team-1",
    scopes: "read, write",
    lastUsedAt: new Date("2026-06-01T00:00:00Z"),
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

describe("/api/v1/api-keys", () => {
  beforeEach(() => {
    mockAuthenticateApiKey.mockResolvedValue({
      keyId: "key-self",
      customerId: "cus_1",
      teamId: "team-1",
      scopes: "*",
    });
    mockCheckRateLimit.mockReturnValue({ allowed: true, info: RATE_INFO });
    mockGenerateApiKey.mockReturnValue({
      key: "pk_live_FULLSECRET",
      keyHash: "hashed",
      keyPrefix: "pk_live_FULL",
    });
    mockApiKeyFindMany.mockResolvedValue([]);
    mockApiKeyCreate.mockImplementation(async ({ data }) => ({
      id: "key-new",
      createdAt: new Date("2026-06-07T00:00:00Z"),
      expiresAt: data.expiresAt ?? null,
      ...data,
    }));
    mockApiKeyFindUnique.mockResolvedValue(null);
    mockApiKeyUpdate.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("GET (list)", () => {
    it("returns 401 with the ApiError envelope when authentication fails", async () => {
      mockAuthenticateApiKey.mockRejectedValue(ApiError.invalidApiKey());

      const res = await GET(makeRequest("GET"));
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error.code).toBe("INVALID_API_KEY");
      expect(mockApiKeyFindMany).not.toHaveBeenCalled();
    });

    it("returns 429 with rate-limit headers before touching the DB", async () => {
      mockCheckRateLimit.mockReturnValue({
        allowed: false,
        info: { ...RATE_INFO, remaining: 0 },
      });

      const res = await GET(makeRequest("GET"));

      expect(res.status).toBe(429);
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(mockApiKeyFindMany).not.toHaveBeenCalled();
    });

    it("lists only the caller's non-revoked keys, masked", async () => {
      mockApiKeyFindMany.mockResolvedValue([storedKey()]);

      const res = await GET(makeRequest("GET"));
      const body = await res.json();

      expect(mockApiKeyFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { stripeCustomerId: "cus_1", revokedAt: null },
        }),
      );
      expect(res.status).toBe(200);
      expect(body.data).toEqual([
        {
          id: "key-1",
          name: "ci key",
          keyPrefix: "pk_live_abc1",
          scopes: ["read", "write"], // CSV split + trimmed
          lastUsedAt: "2026-06-01T00:00:00.000Z",
          expiresAt: null,
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]);
      // The select in the route must never include keyHash
      expect(JSON.stringify(body.data)).not.toContain("hash");
    });
  });

  describe("POST (create)", () => {
    it("rejects a missing name with MISSING_REQUIRED_FIELD", async () => {
      const res = await POST(makeRequest("POST", {}));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe("MISSING_REQUIRED_FIELD");
      expect(mockApiKeyCreate).not.toHaveBeenCalled();
    });

    it("rejects names longer than 100 characters", async () => {
      const res = await POST(makeRequest("POST", { name: "x".repeat(101) }));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe("INVALID_FIELD_VALUE");
    });

    it("rejects unparseable and past expiration dates", async () => {
      const badFormat = await POST(
        makeRequest("POST", { name: "k", expiresAt: "not-a-date" }),
      );
      expect(badFormat.status).toBe(400);

      const inPast = await POST(
        makeRequest("POST", { name: "k", expiresAt: "2020-01-01T00:00:00Z" }),
      );
      const body = await inPast.json();
      expect(inPast.status).toBe(400);
      expect(body.error.message).toContain("future");
      expect(mockApiKeyCreate).not.toHaveBeenCalled();
    });

    it("creates the key and returns the full secret exactly once (201)", async () => {
      const res = await POST(
        makeRequest("POST", { name: "deploy bot", scopes: ["read", "write"] }),
      );
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(mockApiKeyCreate).toHaveBeenCalledWith({
        data: {
          name: "deploy bot",
          keyPrefix: "pk_live_FULL",
          keyHash: "hashed",
          stripeCustomerId: "cus_1",
          teamId: "team-1",
          scopes: "read,write",
          expiresAt: undefined,
        },
      });
      expect(body.data.key).toBe("pk_live_FULLSECRET");
      expect(body.data.keyPrefix).toBe("pk_live_FULL");
    });

    it("defaults scopes to '*' when none are provided", async () => {
      await POST(makeRequest("POST", { name: "default scopes" }));

      expect(mockApiKeyCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ scopes: "*" }),
      });
    });
  });

  describe("DELETE /api/v1/api-keys/[id] (revoke)", () => {
    it("404s for a nonexistent key", async () => {
      const res = await DELETE(makeRequest("DELETE"), deleteParams("key-ghost"));
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("404s (not 403) for another customer's key — no key enumeration", async () => {
      mockApiKeyFindUnique.mockResolvedValue(
        storedKey({ stripeCustomerId: "cus_other" }),
      );

      const res = await DELETE(makeRequest("DELETE"), deleteParams("key-1"));

      expect(res.status).toBe(404);
      expect(mockApiKeyUpdate).not.toHaveBeenCalled();
    });

    it("refuses to revoke the key authenticating the current request", async () => {
      mockApiKeyFindUnique.mockResolvedValue(storedKey({ id: "key-self" }));

      const res = await DELETE(makeRequest("DELETE"), deleteParams("key-self"));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.message).toContain("currently being used");
      expect(mockApiKeyUpdate).not.toHaveBeenCalled();
    });

    it("rejects revoking an already-revoked key", async () => {
      mockApiKeyFindUnique.mockResolvedValue(
        storedKey({ revokedAt: new Date("2026-06-01T00:00:00Z") }),
      );

      const res = await DELETE(makeRequest("DELETE"), deleteParams("key-1"));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.message).toContain("already revoked");
    });

    it("revokes an owned key and reports the revocation", async () => {
      mockApiKeyFindUnique.mockResolvedValue(storedKey());

      const res = await DELETE(makeRequest("DELETE"), deleteParams("key-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(mockApiKeyUpdate).toHaveBeenCalledWith({
        where: { id: "key-1" },
        data: { revokedAt: expect.any(Date) },
      });
      expect(body.data).toMatchObject({ id: "key-1", revoked: true });
    });
  });
});
