import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const {
  mockStripeList,
  mockStripeRetrieve,
  mockFindSuspension,
  mockTeamMembershipFindUnique,
  mockUserFindUnique,
} = vi.hoisted(() => ({
  mockStripeList: vi.fn(),
  mockStripeRetrieve: vi.fn(),
  mockFindSuspension: vi.fn(),
  mockTeamMembershipFindUnique: vi.fn(),
  mockUserFindUnique: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    customers: { list: mockStripeList, retrieve: mockStripeRetrieve },
  }),
}));

vi.mock("@/lib/customer-suspension", () => ({
  findSuspension: mockFindSuspension,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teamMembership: { findUnique: mockTeamMembershipFindUnique },
    user: { findUnique: mockUserFindUnique },
    teamAuditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { generateCustomerToken } from "@/lib/auth/customer";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";

const TEST_EMAIL = "alice@example.com";
const TEST_USER_ID = "user_alice";
const TEST_CUSTOMER_ID = "cus_alice123";

const baseCustomer = {
  id: TEST_CUSTOMER_ID,
  email: TEST_EMAIL,
  metadata: { hostedai_team_id: "team_abc" },
};

function setStripeReturning(customers: object[]) {
  mockStripeList.mockResolvedValue({ data: customers });
}

function makeRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost:3000/api/test", { headers });
}

describe("getAuthenticatedCustomer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSuspension.mockResolvedValue(null);
    setStripeReturning([baseCustomer]);
  });

  it("returns 401 when no authorization header is provided", async () => {
    const result = await getAuthenticatedCustomer(makeRequest());
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    const result = await getAuthenticatedCustomer(makeRequest("invalid-token"));
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it("returns 404 when no Stripe customer exists for the email", async () => {
    setStripeReturning([]);
    const token = generateCustomerToken(TEST_EMAIL, TEST_CUSTOMER_ID);
    const result = await getAuthenticatedCustomer(makeRequest(token));
    expect((result as NextResponse).status).toBe(404);
  });

  it("returns 403 when the customer is suspended", async () => {
    mockFindSuspension.mockResolvedValue({ reason: "fraud" });
    mockTeamMembershipFindUnique.mockResolvedValue({
      id: "tm_1",
      userId: TEST_USER_ID,
      role: "teamAdmin",
      isOwner: true,
      revokedAt: null,
    });
    const token = generateCustomerToken(TEST_EMAIL, TEST_CUSTOMER_ID);
    const result = await getAuthenticatedCustomer(makeRequest(token));
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns 403 when the user has no membership and email does not match customer.email", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    const token = generateCustomerToken("intruder@example.com", TEST_CUSTOMER_ID);
    // Stripe is keyed on the JWT email; simulate no customer with that email.
    setStripeReturning([{ ...baseCustomer, email: "owner@example.com" }]);
    const result = await getAuthenticatedCustomer(makeRequest(token));
    // After Stripe finds the owner record, the implicit-owner fallback won't
    // match (intruder@ != owner@), and no membership row exists → 403.
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns 403 when membership is revoked", async () => {
    mockUserFindUnique.mockResolvedValue({ id: TEST_USER_ID });
    mockTeamMembershipFindUnique.mockResolvedValue({
      id: "tm_1",
      userId: TEST_USER_ID,
      role: "teamAdmin",
      isOwner: false,
      revokedAt: new Date("2026-05-01T00:00:00Z"),
    });
    const token = generateCustomerToken(TEST_EMAIL, TEST_CUSTOMER_ID);
    const result = await getAuthenticatedCustomer(makeRequest(token));
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns authenticated context with can() bound to the membership", async () => {
    mockUserFindUnique.mockResolvedValue({ id: TEST_USER_ID });
    mockTeamMembershipFindUnique.mockResolvedValue({
      id: "tm_1",
      userId: TEST_USER_ID,
      role: "member",
      isOwner: false,
      revokedAt: null,
    });

    const token = generateCustomerToken(TEST_EMAIL, TEST_CUSTOMER_ID);
    const result = await getAuthenticatedCustomer(makeRequest(token));

    expect(result).not.toBeInstanceOf(NextResponse);
    const auth = result as Exclude<typeof result, NextResponse>;
    expect(auth.payload.email).toBe(TEST_EMAIL);
    expect(auth.customer.id).toBe(TEST_CUSTOMER_ID);
    expect(auth.accountId).toBe(TEST_CUSTOMER_ID);
    expect(auth.teamId).toBe("team_abc");
    expect(auth.membership.role).toBe("member");
    expect(auth.membership.isOwner).toBe(false);

    // PA-201: Team Member can provision/terminate/access — but no billing/team-manage.
    expect(auth.can("gpu.access")).toBe(true);
    expect(auth.can("gpu.provision")).toBe(true);
    expect(auth.can("gpu.terminate")).toBe(true);
    expect(auth.can("billing.manage")).toBe(false);
    expect(auth.can("billing.view")).toBe(false);
    expect(auth.can("team.invite")).toBe(false);
  });

  it("grants Owner everything via short-circuit", async () => {
    mockUserFindUnique.mockResolvedValue({ id: TEST_USER_ID });
    mockTeamMembershipFindUnique.mockResolvedValue({
      id: "tm_1",
      userId: TEST_USER_ID,
      role: "teamAdmin",
      isOwner: true,
      revokedAt: null,
    });

    const token = generateCustomerToken(TEST_EMAIL, TEST_CUSTOMER_ID);
    const result = await getAuthenticatedCustomer(makeRequest(token));
    const auth = result as Exclude<typeof result, NextResponse>;

    expect(auth.can("billing.manage")).toBe(true);
    expect(auth.can("team.invite")).toBe(true);
    expect(auth.can("gpu.provision")).toBe(true);
  });

  it("falls back to implicit Owner when the JWT email matches customer.email but no membership row exists", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    mockTeamMembershipFindUnique.mockResolvedValue(null);

    const token = generateCustomerToken(TEST_EMAIL, TEST_CUSTOMER_ID);
    const result = await getAuthenticatedCustomer(makeRequest(token));
    const auth = result as Exclude<typeof result, NextResponse>;

    expect(auth.membership.isImplicit).toBe(true);
    expect(auth.membership.isOwner).toBe(true);
    expect(auth.can("billing.manage")).toBe(true);
  });

  it("uses activeAccountId from new-format JWT when present", async () => {
    const SECONDARY_ACCOUNT = "cus_secondary";
    mockUserFindUnique.mockResolvedValue({ id: TEST_USER_ID });
    // resolveOperatingContext loads the active account via customers.retrieve.
    mockStripeRetrieve.mockResolvedValue({
      id: SECONDARY_ACCOUNT,
      email: "owner@example.com", // different email → exercise membership path
      metadata: { hostedai_team_id: "team_secondary" },
    });
    mockTeamMembershipFindUnique.mockImplementation(({ where }) => {
      // Return an active member-role row only for the secondary account lookup.
      if (where.userId_stripeCustomerId.stripeCustomerId === SECONDARY_ACCOUNT) {
        return Promise.resolve({
          id: "tm_secondary",
          userId: TEST_USER_ID,
          stripeCustomerId: SECONDARY_ACCOUNT,
          role: "member",
          isOwner: false,
          status: "active", // resolver requires an active membership
          revokedAt: null,
        });
      }
      return Promise.resolve(null);
    });

    const token = generateCustomerToken(TEST_EMAIL, TEST_CUSTOMER_ID, {
      userId: TEST_USER_ID,
      activeAccountId: SECONDARY_ACCOUNT,
    });
    const result = await getAuthenticatedCustomer(makeRequest(token));
    const auth = result as Exclude<typeof result, NextResponse>;

    expect(auth.accountId).toBe(SECONDARY_ACCOUNT);
    expect(auth.membership.role).toBe("member");
  });
});
