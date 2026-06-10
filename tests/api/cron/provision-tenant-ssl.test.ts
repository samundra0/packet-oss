// Tests for src/app/api/cron/provision-tenant-ssl/route.ts.
//
// This cron scans DNS-verified tenant domains and provisions SSL certs for
// each. Two contracts matter:
//   * Auth gating — verifyCronAuth returns null when AUTHORIZED and a
//     NextResponse when not. The route must only proceed on null. (This file
//     was originally written with the check inverted — `if (!verifyCronAuth)`
//     — which 401'd authorized callers and let unauthorized ones through.
//     These tests pin the correct polarity.)
//   * Result aggregation — provisioned / already_provisioned / failed counts
//     are summarized correctly, and the 2s politeness delay after a fresh
//     provision doesn't break the loop.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockTenantDomainFindMany, mockProvisionTenantSSL } = vi.hoisted(() => ({
  mockTenantDomainFindMany: vi.fn(),
  mockProvisionTenantSSL: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantDomain: { findMany: mockTenantDomainFindMany },
  },
}));
vi.mock("@/lib/tenant/provision-ssl", () => ({
  provisionTenantSSL: mockProvisionTenantSSL,
}));

import { GET, POST } from "@/app/api/cron/provision-tenant-ssl/route";

const SECRET = "cron-ssl-secret";
const ORIGINAL = process.env.CRON_SECRET;

function makeRequest(method: "GET" | "POST", secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/provision-tenant-ssl", {
    method,
    headers,
  });
}

describe("GET/POST /api/cron/provision-tenant-ssl", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockTenantDomainFindMany.mockResolvedValue([]);
    mockProvisionTenantSSL.mockResolvedValue({ status: "skipped" });
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("rejects unauthorized GET with 401 and never touches the DB", async () => {
    const res = await GET(makeRequest("GET"));

    expect(res.status).toBe(401);
    expect(mockTenantDomainFindMany).not.toHaveBeenCalled();
    expect(mockProvisionTenantSSL).not.toHaveBeenCalled();
  });

  it("rejects unauthorized POST with 401 and never touches the DB", async () => {
    const res = await POST(makeRequest("POST"));

    expect(res.status).toBe(401);
    expect(mockTenantDomainFindMany).not.toHaveBeenCalled();
    expect(mockProvisionTenantSSL).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret with 401", async () => {
    const res = await GET(makeRequest("GET", "wrong-secret"));

    expect(res.status).toBe(401);
    expect(mockTenantDomainFindMany).not.toHaveBeenCalled();
  });

  it("allows an authorized request through to the handler", async () => {
    const res = await GET(makeRequest("GET", SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockTenantDomainFindMany).toHaveBeenCalledTimes(1);
  });

  it("returns early with empty results when no verified domains exist", async () => {
    mockTenantDomainFindMany.mockResolvedValue([]);

    const res = await GET(makeRequest("GET", SECRET));
    const body = await res.json();

    expect(body.message).toMatch(/no verified domains/i);
    expect(body.results).toEqual([]);
    expect(mockProvisionTenantSSL).not.toHaveBeenCalled();
  });

  it("only queries domains that are DNS-verified", async () => {
    await GET(makeRequest("GET", SECRET));

    expect(mockTenantDomainFindMany).toHaveBeenCalledWith({
      where: { verifiedAt: { not: null } },
      select: { domain: true },
    });
  });

  it("provisions each domain and aggregates status counts in the summary", async () => {
    vi.useFakeTimers();
    mockTenantDomainFindMany.mockResolvedValue([
      { domain: "a.example.com" },
      { domain: "b.example.com" },
      { domain: "c.example.com" },
      { domain: "d.example.com" },
    ]);
    mockProvisionTenantSSL
      .mockResolvedValueOnce({ status: "provisioned" })
      .mockResolvedValueOnce({ status: "already_provisioned" })
      .mockResolvedValueOnce({ status: "error", error: "acme failure" })
      .mockResolvedValueOnce({ status: "skipped" });

    const promise = GET(makeRequest("GET", SECRET));
    await vi.runAllTimersAsync(); // flush the 2s post-provision delay
    const res = await promise;
    const body = await res.json();

    expect(mockProvisionTenantSSL).toHaveBeenCalledTimes(4);
    expect(mockProvisionTenantSSL).toHaveBeenNthCalledWith(1, "a.example.com");
    expect(mockProvisionTenantSSL).toHaveBeenNthCalledWith(4, "d.example.com");
    // 1 provisioned, 1 already done, 1 failed (skipped doesn't count as failed)
    expect(body.message).toContain("Checked 4 domains");
    expect(body.message).toContain("1 provisioned");
    expect(body.message).toContain("1 already done");
    expect(body.message).toContain("1 failed");
    expect(body.results).toHaveLength(4);
  });
});
