import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock auth
vi.mock("@/lib/auth/helpers", () => ({
  getAuthenticatedCustomer: vi.fn(),
}));

// Mock zammad
vi.mock("@/lib/zammad", () => ({
  getOrCreatePacketOrganization: vi.fn().mockResolvedValue({ id: 1 }),
  getOrCreatePacketUser: vi.fn().mockResolvedValue({ id: 100 }),
  getTicketsByCustomer: vi.fn().mockResolvedValue([]),
  getTicketArticles: vi.fn().mockResolvedValue([]),
  isTicketClosed: vi.fn().mockResolvedValue(false),
  createPacketSupportTicket: vi.fn(),
}));

// Mock onboarding events
vi.mock("@/lib/email/onboarding-events", () => ({
  sendOnboardingEvent: vi.fn(),
}));

import { GET } from "@/app/api/support/tickets/route";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import {
  getTicketsByCustomer,
  getTicketArticles,
} from "@/lib/zammad";

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/support/tickets", {
    method: "GET",
    headers: { authorization: "Bearer test-token" },
  });
}

describe("GET /api/support/tickets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedCustomer).mockResolvedValue({
      payload: { customerId: "cus_123", email: "test@example.com" },
      customer: { name: "Test User" },
    } as any);
  });

  it("should not show internal notes in the ticket preview (PA-99)", async () => {
    const ticket = {
      id: 1,
      number: "66849",
      title: "Not able to use the GPU",
      state: "open",
      created_at: "2025-04-06T18:27:00Z",
      updated_at: "2025-04-07T08:45:00Z",
    };

    vi.mocked(getTicketsByCustomer).mockResolvedValue([ticket] as any);
    vi.mocked(getTicketArticles).mockResolvedValue([
      {
        id: 1,
        body: "I cannot use my GPU, please help",
        sender: "Customer",
        internal: false,
        created_at: "2025-04-06T18:27:00Z",
        attachments: [],
      },
      {
        id: 2,
        body: "Can you confirm if things are working as expected with the instance and GPU?",
        sender: "Agent",
        internal: false,
        created_at: "2025-04-07T08:41:00Z",
        attachments: [],
      },
      {
        id: 3,
        body: "Adding an internal note to replicate the issue with internal notes being shown",
        sender: "Agent",
        internal: true,
        created_at: "2025-04-07T09:00:00Z",
        attachments: [],
      },
    ] as any);

    const response = await GET(makeRequest());
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.tickets).toHaveLength(1);

    const ticketPreview = data.tickets[0];
    // The preview should show the last PUBLIC message, not the internal note
    expect(ticketPreview.lastMessage).not.toContain("internal note");
    expect(ticketPreview.lastMessage).toContain(
      "Can you confirm if things are working as expected"
    );
  });

  it("should show last public message when all recent articles are internal", async () => {
    const ticket = {
      id: 2,
      number: "66850",
      title: "Billing question",
      state: "open",
      created_at: "2025-04-06T10:00:00Z",
      updated_at: "2025-04-07T12:00:00Z",
    };

    vi.mocked(getTicketsByCustomer).mockResolvedValue([ticket] as any);
    vi.mocked(getTicketArticles).mockResolvedValue([
      {
        id: 10,
        body: "I have a billing question",
        sender: "Customer",
        internal: false,
        created_at: "2025-04-06T10:00:00Z",
        attachments: [],
      },
      {
        id: 11,
        body: "Internal: checking stripe dashboard",
        sender: "Agent",
        internal: true,
        created_at: "2025-04-07T11:00:00Z",
        attachments: [],
      },
      {
        id: 12,
        body: "Internal: escalating to billing team",
        sender: "Agent",
        internal: true,
        created_at: "2025-04-07T12:00:00Z",
        attachments: [],
      },
    ] as any);

    const response = await GET(makeRequest());
    const data = await response.json();

    const ticketPreview = data.tickets[0];
    // Should fall back to the customer's message since all agent messages are internal
    expect(ticketPreview.lastMessage).toContain("billing question");
    expect(ticketPreview.lastMessage).not.toContain("Internal");
  });

  it("should not flag internal notes as unread replies", async () => {
    const ticket = {
      id: 3,
      number: "66851",
      title: "Setup help",
      state: "open",
      created_at: "2025-04-06T10:00:00Z",
      updated_at: "2025-04-07T12:00:00Z",
    };

    vi.mocked(getTicketsByCustomer).mockResolvedValue([ticket] as any);
    vi.mocked(getTicketArticles).mockResolvedValue([
      {
        id: 20,
        body: "Need help setting up",
        sender: "Customer",
        internal: false,
        created_at: "2025-04-06T10:00:00Z",
        attachments: [],
      },
      {
        id: 21,
        body: "Internal: investigating the setup issue",
        sender: "Agent",
        internal: true,
        created_at: "2025-04-07T11:00:00Z",
        attachments: [],
      },
    ] as any);

    const response = await GET(makeRequest());
    const data = await response.json();

    const ticketPreview = data.tickets[0];
    // Internal note from agent should NOT trigger unread reply indicator
    expect(ticketPreview.hasUnreadReply).toBe(false);
  });
});
