import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// OSS edition: no Stripe. getStripeOrNull() returns null and the authenticated
// context is built from customer_cache. Regression guard for the bug where
// allTeamIds was set to the synthetic oss_* customer id instead of the hosted.ai
// team id, which made every HAI lookup (terminal, connection-info, pool ops) 404.

const {
  mockGetStripeOrNull,
  mockCustomerCacheFindUnique,
  mockTeamMembershipFindUnique,
  mockUserFindUnique,
} = vi.hoisted(() => ({
  mockGetStripeOrNull: vi.fn(),
  mockCustomerCacheFindUnique: vi.fn(),
  mockTeamMembershipFindUnique: vi.fn(),
  mockUserFindUnique: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  getStripeOrNull: mockGetStripeOrNull,
  getStripe: () => { throw new Error("getStripe must not be called in OSS"); },
}));

vi.mock("@/lib/customer-suspension", () => ({
  findSuspension: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customerCache: { findUnique: mockCustomerCacheFindUnique },
    teamMembership: { findUnique: mockTeamMembershipFindUnique },
    user: { findUnique: mockUserFindUnique },
    teamAuditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { generateCustomerToken } from "@/lib/auth/customer";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";

const EMAIL = "oss-user@example.com";
const OSS_ID = "oss_eb560bc2a7794dfd5312ffbb203ef221";
const TEAM_ID = "ac618a8c-3e6e-4957-9d31-4e4e3df7904e";

function makeRequest(token: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/test", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("getAuthenticatedCustomer — OSS (no Stripe)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStripeOrNull.mockResolvedValue(null);
    // implicit-owner: JWT email matches cached customer email, no membership row
    mockUserFindUnique.mockResolvedValue(null);
    mockTeamMembershipFindUnique.mockResolvedValue(null);
    mockCustomerCacheFindUnique.mockResolvedValue({
      id: OSS_ID,
      email: EMAIL,
      name: null,
      teamId: TEAM_ID,
      stripeCreatedAt: new Date("2026-06-01T00:00:00Z"),
    });
  });

  it("resolves allTeamIds to the hosted.ai team id, NOT the oss_* customer id", async () => {
    const token = generateCustomerToken(EMAIL, OSS_ID);
    const result = await getAuthenticatedCustomer(makeRequest(token));

    expect(result).not.toBeInstanceOf(NextResponse);
    const auth = result as Exclude<typeof result, NextResponse>;

    expect(auth.accountId).toBe(OSS_ID);          // account identity = synthetic id
    expect(auth.teamId).toBe(TEAM_ID);            // primary team = HAI team
    expect(auth.allTeamIds).toEqual([TEAM_ID]);   // <-- the bug: was [OSS_ID]
    expect(auth.allTeamIds).not.toContain(OSS_ID);
  });

  it("yields empty allTeamIds (not [oss_id]) when the cached customer has no team yet", async () => {
    mockCustomerCacheFindUnique.mockResolvedValue({
      id: OSS_ID, email: EMAIL, name: null, teamId: null,
      stripeCreatedAt: new Date("2026-06-01T00:00:00Z"),
    });
    const token = generateCustomerToken(EMAIL, OSS_ID);
    const result = await getAuthenticatedCustomer(makeRequest(token));
    const auth = result as Exclude<typeof result, NextResponse>;

    expect(auth.allTeamIds).toEqual([]);
    expect(auth.teamId).toBeUndefined();
  });

  it("returns 404 when no cached customer exists", async () => {
    mockCustomerCacheFindUnique.mockResolvedValue(null);
    const token = generateCustomerToken(EMAIL, OSS_ID);
    const result = await getAuthenticatedCustomer(makeRequest(token));
    expect((result as NextResponse).status).toBe(404);
  });
});
