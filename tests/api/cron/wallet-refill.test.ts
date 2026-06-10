// Tests for src/app/api/cron/wallet-refill/route.ts.
//
// This cron iterates all hourly-billing Stripe customers and calls
// checkAndRefillWallet on each. A bug here either drains wallets twice or
// refills never fire — both are silent incidents. We pin:
//   * Auth gating (delegates to verifyCronAuth — bad secret → 401)
//   * Pagination handles Stripe's has_more / next_page
//   * Per-customer iteration calls checkAndRefillWallet exactly once each
//   * Return shape reports refilled vs checked counts correctly

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockStripeSearch, mockGetStripe, mockCheckAndRefillWallet } = vi.hoisted(
  () => ({
    mockStripeSearch: vi.fn(),
    mockGetStripe: vi.fn(),
    mockCheckAndRefillWallet: vi.fn(),
  }),
);

vi.mock("@/lib/stripe", () => ({ getStripe: mockGetStripe }));
vi.mock("@/lib/wallet", () => ({
  checkAndRefillWallet: mockCheckAndRefillWallet,
}));

import { GET } from "@/app/api/cron/wallet-refill/route";

const SECRET = "cron-wallet-secret";
const ORIGINAL = process.env.CRON_SECRET;

function makeAuthorized() {
  const headers = new Headers();
  headers.set("x-cron-secret", SECRET);
  return new NextRequest("http://localhost/api/cron/wallet-refill", {
    method: "GET",
    headers,
  });
}

function makeUnauthorized() {
  return new NextRequest("http://localhost/api/cron/wallet-refill", {
    method: "GET",
  });
}

describe("GET /api/cron/wallet-refill", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockGetStripe.mockResolvedValue({
      customers: { search: mockStripeSearch },
    });
    mockCheckAndRefillWallet.mockResolvedValue({ refilled: false });
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
  });

  it("returns 401 on unauthorized request", async () => {
    mockStripeSearch.mockResolvedValue({ data: [], has_more: false });

    const res = await GET(makeUnauthorized());

    expect(res.status).toBe(401);
    expect(mockStripeSearch).not.toHaveBeenCalled();
    expect(mockCheckAndRefillWallet).not.toHaveBeenCalled();
  });

  it("processes zero customers cleanly when Stripe returns empty", async () => {
    mockStripeSearch.mockResolvedValue({ data: [], has_more: false });

    const res = await GET(makeAuthorized());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checked).toBe(0);
    expect(body.refilled).toBe(0);
    expect(mockCheckAndRefillWallet).not.toHaveBeenCalled();
  });

  it("calls checkAndRefillWallet once per customer in a single page", async () => {
    mockStripeSearch.mockResolvedValue({
      data: [
        { id: "cus_1", email: "a@x.com", balance: -1000 },
        { id: "cus_2", email: "b@x.com", balance: 0 },
        { id: "cus_3", email: "c@x.com", balance: 50 },
      ],
      has_more: false,
    });
    mockCheckAndRefillWallet
      .mockResolvedValueOnce({ refilled: true, amount: 2000 })
      .mockResolvedValueOnce({ refilled: false })
      .mockResolvedValueOnce({ refilled: true, amount: 1000 });

    const res = await GET(makeAuthorized());
    const body = await res.json();

    expect(mockCheckAndRefillWallet).toHaveBeenCalledTimes(3);
    expect(mockCheckAndRefillWallet).toHaveBeenNthCalledWith(1, "cus_1");
    expect(mockCheckAndRefillWallet).toHaveBeenNthCalledWith(2, "cus_2");
    expect(mockCheckAndRefillWallet).toHaveBeenNthCalledWith(3, "cus_3");
    expect(body.checked).toBe(3);
    expect(body.refilled).toBe(2);
  });

  it("paginates through Stripe results when has_more=true", async () => {
    mockStripeSearch
      .mockResolvedValueOnce({
        data: [{ id: "cus_p1", email: "p1@x.com", balance: 0 }],
        has_more: true,
        next_page: "page_token_2",
      })
      .mockResolvedValueOnce({
        data: [{ id: "cus_p2", email: "p2@x.com", balance: 0 }],
        has_more: false,
      });

    const res = await GET(makeAuthorized());
    const body = await res.json();

    expect(mockStripeSearch).toHaveBeenCalledTimes(2);
    expect(mockStripeSearch).toHaveBeenNthCalledWith(1, {
      query: 'metadata["billing_type"]:"hourly"',
      limit: 100,
      page: undefined,
    });
    expect(mockStripeSearch).toHaveBeenNthCalledWith(2, {
      query: 'metadata["billing_type"]:"hourly"',
      limit: 100,
      page: "page_token_2",
    });
    expect(body.checked).toBe(2);
  });

  it("inverts Stripe balance sign (negative = credit) when reporting", async () => {
    // Stripe convention: customer.balance is NEGATIVE when there's credit.
    // The route flips this so the returned value is positive credit.
    mockStripeSearch.mockResolvedValue({
      data: [{ id: "cus_1", email: "a@x.com", balance: -5000 }],
      has_more: false,
    });

    const res = await GET(makeAuthorized());
    const body = await res.json();

    expect(body.results[0].balance).toBe(5000);
  });

  it("returns 500 when a Stripe call throws unexpectedly", async () => {
    mockStripeSearch.mockRejectedValue(new Error("stripe outage"));

    const res = await GET(makeAuthorized());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Failed to process wallet refills");
  });
});
