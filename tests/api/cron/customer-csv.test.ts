// Tests for src/app/api/cron/customer-csv/route.ts.
//
// Twice-daily report that flattens CustomerCache + PodMetadata + activity +
// lifecycle into a CSV emailed to onboarding. Pinned contracts:
//   * Auth gating
//   * Wallet balance uses the Stripe sign convention (negative = credit;
//     positive balances render as $0.00)
//   * Pod counts aggregate per customer; activity capped at 5 latest events
//   * CSV escaping survives commas/quotes in names
//   * Rows sort newest account first
//   * Email goes to onboarding@hosted.ai with the CSV inline in the text body
//   * SMTP failure → 500 (the report must not silently vanish)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockCustomerCacheFindMany,
  mockPodMetadataFindMany,
  mockActivityEventFindMany,
  mockLifecycleFindMany,
  mockSendEmailDirect,
} = vi.hoisted(() => ({
  mockCustomerCacheFindMany: vi.fn(),
  mockPodMetadataFindMany: vi.fn(),
  mockActivityEventFindMany: vi.fn(),
  mockLifecycleFindMany: vi.fn(),
  mockSendEmailDirect: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customerCache: { findMany: mockCustomerCacheFindMany },
    podMetadata: { findMany: mockPodMetadataFindMany },
    activityEvent: { findMany: mockActivityEventFindMany },
    customerLifecycle: { findMany: mockLifecycleFindMany },
  },
}));
vi.mock("@/lib/email/client", () => ({ sendEmailDirect: mockSendEmailDirect }));

import { POST } from "@/app/api/cron/customer-csv/route";

const SECRET = "cron-csv-secret";
const ORIGINAL = process.env.CRON_SECRET;

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/customer-csv", {
    method: "POST",
    headers,
  });
}

function cachedCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: "cus_1",
    email: "a@x.com",
    name: "Ada",
    billingType: "hourly",
    balanceCents: -5000, // $50 credit
    teamId: "team-1",
    stripeCreatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("POST /api/cron/customer-csv", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockCustomerCacheFindMany.mockResolvedValue([]);
    mockPodMetadataFindMany.mockResolvedValue([]);
    mockActivityEventFindMany.mockResolvedValue([]);
    mockLifecycleFindMany.mockResolvedValue([]);
    mockSendEmailDirect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without reading or emailing", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(mockCustomerCacheFindMany).not.toHaveBeenCalled();
    expect(mockSendEmailDirect).not.toHaveBeenCalled();
  });

  it("emails onboarding with the customer count in the subject", async () => {
    mockCustomerCacheFindMany.mockResolvedValue([cachedCustomer()]);

    const res = await POST(makeRequest(SECRET));
    const body = await res.json();

    expect(mockSendEmailDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "onboarding@hosted.ai",
        subject: expect.stringContaining("1 customers"),
      }),
    );
    expect(body.success).toBe(true);
    expect(body.customers).toBe(1);
    expect(body.sentTo).toBe("onboarding@hosted.ai");
  });

  it("renders wallet credit as positive dollars and ignores positive (debt) balances", async () => {
    mockCustomerCacheFindMany.mockResolvedValue([
      cachedCustomer({ id: "cus_credit", email: "credit@x.com", balanceCents: -5000 }),
      cachedCustomer({ id: "cus_debt", email: "debt@x.com", balanceCents: 300 }),
    ]);

    await POST(makeRequest(SECRET));

    const { text } = mockSendEmailDirect.mock.calls[0][0];
    const creditRow = text.split("\n").find((l: string) => l.startsWith("credit@x.com"));
    const debtRow = text.split("\n").find((l: string) => l.startsWith("debt@x.com"));
    expect(creditRow).toContain("50.00");
    expect(debtRow).toContain("0.00");
  });

  it("counts pods per customer and caps recent activity at 5 events", async () => {
    mockCustomerCacheFindMany.mockResolvedValue([cachedCustomer()]);
    mockPodMetadataFindMany.mockResolvedValue([
      { stripeCustomerId: "cus_1" },
      { stripeCustomerId: "cus_1" },
      { stripeCustomerId: "cus_other" },
    ]);
    // 7 events, newest first (matches the orderBy in the route)
    mockActivityEventFindMany.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({
        customerId: "cus_1",
        type: "login",
        description: `event-${i}`,
        createdAt: new Date(Date.UTC(2026, 5, 6 - i)),
      })),
    );

    const res = await POST(makeRequest(SECRET));
    await res.json();

    const { text } = mockSendEmailDirect.mock.calls[0][0];
    const row = text.split("\n").find((l: string) => l.startsWith("a@x.com"));
    expect(row).toContain(",2,"); // 2 pods (cus_other's not counted)
    expect(row).toContain("event-0");
    expect(row).toContain("event-4");
    expect(row).not.toContain("event-5"); // capped at 5
  });

  it("escapes commas and quotes in CSV fields", async () => {
    mockCustomerCacheFindMany.mockResolvedValue([
      cachedCustomer({ name: 'Lovelace, Ada "The Countess"' }),
    ]);

    await POST(makeRequest(SECRET));

    const { text } = mockSendEmailDirect.mock.calls[0][0];
    expect(text).toContain('"Lovelace, Ada ""The Countess"""');
  });

  it("sorts rows newest account first", async () => {
    mockCustomerCacheFindMany.mockResolvedValue([
      cachedCustomer({
        id: "cus_old",
        email: "old@x.com",
        stripeCreatedAt: new Date("2025-01-01T00:00:00Z"),
      }),
      cachedCustomer({
        id: "cus_new",
        email: "new@x.com",
        stripeCreatedAt: new Date("2026-06-01T00:00:00Z"),
      }),
    ]);

    await POST(makeRequest(SECRET));

    const { text } = mockSendEmailDirect.mock.calls[0][0];
    expect(text.indexOf("new@x.com")).toBeLessThan(text.indexOf("old@x.com"));
  });

  it("includes lifecycle spend when present", async () => {
    mockCustomerCacheFindMany.mockResolvedValue([cachedCustomer()]);
    mockLifecycleFindMany.mockResolvedValue([
      { stripeCustomerId: "cus_1", totalSpendCents: 123456 },
    ]);

    await POST(makeRequest(SECRET));

    const { text } = mockSendEmailDirect.mock.calls[0][0];
    const row = text.split("\n").find((l: string) => l.startsWith("a@x.com"));
    expect(row).toContain("1234.56");
  });

  it("returns 500 when the email send fails", async () => {
    mockCustomerCacheFindMany.mockResolvedValue([cachedCustomer()]);
    mockSendEmailDirect.mockRejectedValue(new Error("SMTP refused"));

    const res = await POST(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to generate customer CSV");
    expect(body.details).toBe("SMTP refused");
  });
});
