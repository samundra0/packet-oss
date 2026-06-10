import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock auth
vi.mock("@/lib/auth/helpers", () => ({
  getAuthenticatedCustomer: vi.fn(),
}));

// Mock zammad — note we do NOT export getOrCreatePacketOrganization /
// getOrCreatePacketUser here. The unread endpoint must not need them. If the
// route ever starts importing them, the import will fail in this test and
// catch the regression.
vi.mock("@/lib/zammad", () => ({
  lookupPacketUserIdByEmail: vi.fn(),
  getTicketsByCustomer: vi.fn().mockResolvedValue([]),
  getTicketArticles: vi.fn().mockResolvedValue([]),
  isTicketClosed: vi.fn().mockResolvedValue(false),
}));

import { GET } from "@/app/api/support/unread/route";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import {
  lookupPacketUserIdByEmail,
  getTicketsByCustomer,
  getTicketArticles,
  isTicketClosed,
} from "@/lib/zammad";

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/support/unread", {
    method: "GET",
    headers: { authorization: "Bearer test-token" },
  });
}

describe("GET /api/support/unread (PA-226)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedCustomer).mockResolvedValue({
      payload: { customerId: "cus_123", email: "test@example.com" },
      customer: { name: "Test User" },
    } as any);
    vi.mocked(isTicketClosed).mockResolvedValue(false);
  });

  it("returns hasUnreadReplies=false with zero Zammad calls when user not in Zammad yet", async () => {
    vi.mocked(lookupPacketUserIdByEmail).mockResolvedValue(null);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data).toEqual({ success: true, hasUnreadReplies: false });
    expect(getTicketsByCustomer).not.toHaveBeenCalled();
    expect(getTicketArticles).not.toHaveBeenCalled();
  });

  it("makes exactly one ticket-search call when user has no open tickets", async () => {
    vi.mocked(lookupPacketUserIdByEmail).mockResolvedValue(42);
    vi.mocked(getTicketsByCustomer).mockResolvedValue([]);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.hasUnreadReplies).toBe(false);
    expect(getTicketsByCustomer).toHaveBeenCalledTimes(1);
    expect(getTicketArticles).not.toHaveBeenCalled();
  });

  it("skips article fetch when customer replied after agent", async () => {
    vi.mocked(lookupPacketUserIdByEmail).mockResolvedValue(42);
    vi.mocked(getTicketsByCustomer).mockResolvedValue([
      {
        id: 1,
        last_contact_agent_at: "2025-04-07T08:00:00Z",
        last_contact_customer_at: "2025-04-07T09:00:00Z",
      },
    ] as any);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.hasUnreadReplies).toBe(false);
    expect(getTicketArticles).not.toHaveBeenCalled();
  });

  it("skips article fetch when ticket is closed", async () => {
    vi.mocked(lookupPacketUserIdByEmail).mockResolvedValue(42);
    vi.mocked(getTicketsByCustomer).mockResolvedValue([
      {
        id: 1,
        last_contact_agent_at: "2025-04-07T10:00:00Z",
        last_contact_customer_at: "2025-04-07T08:00:00Z",
      },
    ] as any);
    vi.mocked(isTicketClosed).mockResolvedValue(true);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.hasUnreadReplies).toBe(false);
    expect(getTicketArticles).not.toHaveBeenCalled();
  });

  it("reports unread when last public article is from an agent", async () => {
    vi.mocked(lookupPacketUserIdByEmail).mockResolvedValue(42);
    vi.mocked(getTicketsByCustomer).mockResolvedValue([
      {
        id: 1,
        last_contact_agent_at: "2025-04-07T10:00:00Z",
        last_contact_customer_at: "2025-04-07T08:00:00Z",
      },
    ] as any);
    vi.mocked(getTicketArticles).mockResolvedValue([
      { sender: "Customer", internal: false },
      { sender: "Agent", internal: false },
    ] as any);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.hasUnreadReplies).toBe(true);
  });

  it("does NOT flag unread when last agent reply is internal-only", async () => {
    vi.mocked(lookupPacketUserIdByEmail).mockResolvedValue(42);
    vi.mocked(getTicketsByCustomer).mockResolvedValue([
      {
        id: 1,
        last_contact_agent_at: "2025-04-07T10:00:00Z",
        last_contact_customer_at: "2025-04-07T08:00:00Z",
      },
    ] as any);
    vi.mocked(getTicketArticles).mockResolvedValue([
      { sender: "Customer", body: "help", internal: false },
      { sender: "Agent", body: "internal note", internal: true },
    ] as any);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.hasUnreadReplies).toBe(false);
  });

  it("stops at the first ticket with a confirmed unread reply", async () => {
    vi.mocked(lookupPacketUserIdByEmail).mockResolvedValue(42);
    vi.mocked(getTicketsByCustomer).mockResolvedValue([
      {
        id: 1,
        last_contact_agent_at: "2025-04-07T10:00:00Z",
        last_contact_customer_at: "2025-04-07T08:00:00Z",
      },
      {
        id: 2,
        last_contact_agent_at: "2025-04-07T11:00:00Z",
        last_contact_customer_at: "2025-04-07T09:00:00Z",
      },
    ] as any);
    vi.mocked(getTicketArticles).mockResolvedValueOnce([
      { sender: "Customer", internal: false },
      { sender: "Agent", internal: false },
    ] as any);

    const res = await GET(makeRequest());
    const data = await res.json();

    expect(data.hasUnreadReplies).toBe(true);
    // Second ticket never inspected
    expect(getTicketArticles).toHaveBeenCalledTimes(1);
    expect(getTicketArticles).toHaveBeenCalledWith(1);
  });
});
