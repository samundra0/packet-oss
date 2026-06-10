// Tests for src/app/api/cron/support-notifications/route.ts.
//
// Polls Zammad for open tickets where an agent replied last and emails the
// customer a deep-link. The dedup design is the load-bearing part: the
// SupportNotification row is created BEFORE sending (unique on ticketId +
// lastArticleId), so concurrent cron runs can't double-email; if the send
// then fails, the row is deleted so the next run retries. Pinned contracts:
//   * Auth gating
//   * Skip rules: closed tickets, customer-sent last article, internal
//     notes, missing email, no Stripe customer
//   * Claim-before-send, unique-violation → silent skip (no email)
//   * Send failure → claim row deleted, error captured per-ticket
//   * Deep-link token uses the resolved primary customer id
//   * Outer failure → 500

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockNotificationCreate,
  mockNotificationDelete,
  mockGetAllTickets,
  mockGetTicketArticles,
  mockGetUser,
  mockIsTicketClosed,
  mockSendNotification,
  mockDelay,
  mockGetStripe,
  mockStripeCustomersSearch,
  mockGenerateCustomerToken,
  mockResolvePrimaryCustomer,
} = vi.hoisted(() => ({
  mockNotificationCreate: vi.fn(),
  mockNotificationDelete: vi.fn(),
  mockGetAllTickets: vi.fn(),
  mockGetTicketArticles: vi.fn(),
  mockGetUser: vi.fn(),
  mockIsTicketClosed: vi.fn(),
  mockSendNotification: vi.fn(),
  mockDelay: vi.fn(),
  mockGetStripe: vi.fn(),
  mockStripeCustomersSearch: vi.fn(),
  mockGenerateCustomerToken: vi.fn(),
  mockResolvePrimaryCustomer: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    supportNotification: {
      create: mockNotificationCreate,
      delete: mockNotificationDelete,
    },
  },
}));
vi.mock("@/lib/zammad", () => ({
  getAllTickets: mockGetAllTickets,
  getTicketArticles: mockGetTicketArticles,
  getUser: mockGetUser,
  isTicketClosed: mockIsTicketClosed,
}));
vi.mock("@/lib/email", () => ({
  sendSupportReplyNotification: mockSendNotification,
  delay: mockDelay,
}));
vi.mock("@/lib/stripe", () => ({ getStripe: mockGetStripe }));
vi.mock("@/lib/customer-auth", () => ({
  generateCustomerToken: mockGenerateCustomerToken,
}));
vi.mock("@/lib/customer-resolver", () => ({
  resolvePrimaryCustomer: mockResolvePrimaryCustomer,
}));

import { GET } from "@/app/api/cron/support-notifications/route";

const SECRET = "cron-support-secret";
const ORIGINAL = process.env.CRON_SECRET;

function makeRequest(secret?: string) {
  const headers = new Headers();
  if (secret) headers.set("x-cron-secret", secret);
  return new NextRequest("http://localhost/api/cron/support-notifications", {
    method: "GET",
    headers,
  });
}

function ticket(overrides: Record<string, unknown> = {}) {
  return { id: 101, title: "GPU stuck", customer_id: 7, ...overrides };
}

function agentArticle(overrides: Record<string, unknown> = {}) {
  return {
    id: 555,
    sender: "Agent",
    internal: false,
    body: "We restarted your pod.",
    created_at: "2026-06-05T08:00:00Z",
    ...overrides,
  };
}

describe("GET /api/cron/support-notifications", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    mockGetStripe.mockResolvedValue({
      customers: { search: mockStripeCustomersSearch },
    });
    mockGetAllTickets.mockResolvedValue([]);
    mockIsTicketClosed.mockResolvedValue(false);
    mockGetTicketArticles.mockResolvedValue([agentArticle()]);
    mockGetUser.mockResolvedValue({
      email: "user@x.com",
      firstname: "Ada",
      lastname: "Lovelace",
    });
    mockStripeCustomersSearch.mockResolvedValue({ data: [{ id: "cus_1" }] });
    mockNotificationCreate.mockResolvedValue({ id: "notif-1" });
    mockNotificationDelete.mockResolvedValue({});
    mockSendNotification.mockResolvedValue(undefined);
    mockDelay.mockResolvedValue(undefined);
    mockResolvePrimaryCustomer.mockResolvedValue(null);
    mockGenerateCustomerToken.mockReturnValue("tok_abc");
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it("returns 401 on unauthorized request without hitting Zammad", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockGetAllTickets).not.toHaveBeenCalled();
  });

  it("skips closed tickets entirely", async () => {
    mockGetAllTickets.mockResolvedValue([ticket()]);
    mockIsTicketClosed.mockResolvedValue(true);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.checked).toBe(0);
    expect(mockGetTicketArticles).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("skips when the customer sent the last article (nothing new to notify)", async () => {
    mockGetAllTickets.mockResolvedValue([ticket()]);
    mockGetTicketArticles.mockResolvedValue([
      agentArticle({ id: 1 }),
      agentArticle({ id: 2, sender: "Customer" }),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.sent).toBe(0);
    expect(mockNotificationCreate).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("skips internal notes — they must never leak to customers", async () => {
    mockGetAllTickets.mockResolvedValue([ticket()]);
    mockGetTicketArticles.mockResolvedValue([
      agentArticle({ internal: true, body: "customer is wrong about this" }),
    ]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.sent).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("skips when the Zammad user has no email or no Stripe customer matches", async () => {
    mockGetAllTickets.mockResolvedValue([
      ticket({ id: 1 }),
      ticket({ id: 2 }),
    ]);
    mockGetUser
      .mockResolvedValueOnce({ email: null })
      .mockResolvedValueOnce({ email: "ghost@x.com", firstname: "G", lastname: "" });
    mockStripeCustomersSearch.mockResolvedValue({ data: [] });

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(body.sent).toBe(0);
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  it("claims the article in the DB before sending, then emails with a deep link", async () => {
    const callOrder: string[] = [];
    mockNotificationCreate.mockImplementation(async () => {
      callOrder.push("claim");
      return { id: "notif-1" };
    });
    mockSendNotification.mockImplementation(async () => {
      callOrder.push("send");
    });
    mockGetAllTickets.mockResolvedValue([ticket()]);

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(callOrder).toEqual(["claim", "send"]);
    expect(mockNotificationCreate).toHaveBeenCalledWith({
      data: {
        ticketId: "101",
        stripeCustomerId: "cus_1",
        customerEmail: "user@x.com",
        lastArticleId: 555,
        lastArticleAt: new Date("2026-06-05T08:00:00Z"),
      },
    });
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@x.com",
        customerName: "Ada Lovelace",
        ticketTitle: "GPU stuck",
        dashboardUrl: expect.stringContaining("token=tok_abc"),
      }),
    );
    expect(mockSendNotification.mock.calls[0][0].dashboardUrl).toContain(
      "ticket=101",
    );
    expect(body.sent).toBe(1);
    expect(mockDelay).toHaveBeenCalledWith(10000);
  });

  it("skips silently when another run already claimed the article (unique constraint)", async () => {
    mockGetAllTickets.mockResolvedValue([ticket()]);
    mockNotificationCreate.mockRejectedValue(
      new Error("Unique constraint failed on the fields: (`ticketId`,`lastArticleId`)"),
    );

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(0);
    expect(body.results).toEqual([]); // silent skip, not an error entry
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("deletes the claim and records the error when the email send fails", async () => {
    mockGetAllTickets.mockResolvedValue([ticket()]);
    mockSendNotification.mockRejectedValue(new Error("SMTP refused"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(mockNotificationDelete).toHaveBeenCalledWith({
      where: { id: "notif-1" },
    });
    expect(body.sent).toBe(0);
    expect(body.results[0]).toEqual({
      ticketId: "101",
      customerEmail: "user@x.com",
      sent: false,
      error: "SMTP refused",
    });
  });

  it("generates the login token against the resolved primary customer", async () => {
    mockGetAllTickets.mockResolvedValue([ticket()]);
    mockResolvePrimaryCustomer.mockResolvedValue({ id: "cus_primary" });

    await GET(makeRequest(SECRET));

    expect(mockGenerateCustomerToken).toHaveBeenCalledWith(
      "user@x.com",
      "cus_primary",
    );
  });

  it("returns 500 when Zammad is unreachable", async () => {
    mockGetAllTickets.mockRejectedValue(new Error("zammad down"));

    const res = await GET(makeRequest(SECRET));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to process support notifications");
  });
});
