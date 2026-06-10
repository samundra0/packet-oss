/**
 * PA-270 — PUT /api/admin/pricing must persist stoppedInstanceRatePercent.
 *
 * Bug: the handler destructured only hourlyRateCents, storagePricePerGBHourCents,
 * autoRefillThresholdCents, autoRefillAmountCents — so the stopped-instance rate
 * sent by the admin UI was silently dropped and never written to data/pricing.json.
 * The value stayed at the 25% default forever, with no error shown.
 *
 * These tests pin: the field is persisted, validated to 0..100, and the other
 * pricing fields keep working (no field is silently dropped).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockVerifySessionToken, mockGetPricing, mockUpdatePricing, mockLogSettingsUpdated } =
  vi.hoisted(() => ({
    mockVerifySessionToken: vi.fn(),
    mockGetPricing: vi.fn(),
    mockUpdatePricing: vi.fn(),
    mockLogSettingsUpdated: vi.fn(),
  }));

vi.mock("@/lib/admin", () => ({ verifySessionToken: mockVerifySessionToken }));
vi.mock("@/lib/pricing", () => ({
  getPricing: mockGetPricing,
  updatePricing: mockUpdatePricing,
}));
vi.mock("@/lib/admin-activity", () => ({ logSettingsUpdated: mockLogSettingsUpdated }));

import { PUT } from "@/app/api/admin/pricing/route";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_SESSION_TOKEN = "valid-session-token";

const BASE_PRICING = {
  hourlyRateCents: 0,
  storagePricePerGBHourCents: 0,
  autoRefillThresholdCents: 2500,
  autoRefillAmountCents: 10000,
  stoppedInstanceRatePercent: 25,
};

function makeReq({ body, withSession = true }: { body?: unknown; withSession?: boolean }) {
  const headers = new Headers();
  if (withSession) headers.set("cookie", `admin_session=${ADMIN_SESSION_TOKEN}`);
  const init: RequestInit = { method: "PUT", headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers.set("content-type", "application/json");
  }
  return new NextRequest("http://localhost/api/admin/pricing", init);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySessionToken.mockReturnValue({ email: ADMIN_EMAIL });
  mockGetPricing.mockReturnValue({ ...BASE_PRICING });
  mockUpdatePricing.mockImplementation((updates: Record<string, unknown>) => ({
    ...BASE_PRICING,
    ...updates,
  }));
  mockLogSettingsUpdated.mockResolvedValue(undefined);
});

describe("PUT /api/admin/pricing — PA-270 stoppedInstanceRatePercent", () => {
  it("persists stoppedInstanceRatePercent (100 → full price)", async () => {
    const res = await PUT(makeReq({ body: { stoppedInstanceRatePercent: 100 } }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(mockUpdatePricing).toHaveBeenCalledWith(
      expect.objectContaining({ stoppedInstanceRatePercent: 100 }),
      ADMIN_EMAIL,
    );
    expect(data.pricing.stoppedInstanceRatePercent).toBe(100);
  });

  it("allows 0 (no charge for stopped instances)", async () => {
    const res = await PUT(makeReq({ body: { stoppedInstanceRatePercent: 0 } }));
    expect(res.status).toBe(200);
    expect(mockUpdatePricing).toHaveBeenCalledWith(
      expect.objectContaining({ stoppedInstanceRatePercent: 0 }),
      ADMIN_EMAIL,
    );
  });

  it("rejects a value above 100 with 400 and persists nothing", async () => {
    const res = await PUT(makeReq({ body: { stoppedInstanceRatePercent: 150 } }));
    expect(res.status).toBe(400);
    expect(mockUpdatePricing).not.toHaveBeenCalled();
  });

  it("rejects a negative value with 400 and persists nothing", async () => {
    const res = await PUT(makeReq({ body: { stoppedInstanceRatePercent: -1 } }));
    expect(res.status).toBe(400);
    expect(mockUpdatePricing).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric value with 400 and persists nothing", async () => {
    const res = await PUT(makeReq({ body: { stoppedInstanceRatePercent: "100" } }));
    expect(res.status).toBe(400);
    expect(mockUpdatePricing).not.toHaveBeenCalled();
  });

  it("still persists the other pricing fields (no regression / no silent drop)", async () => {
    const res = await PUT(
      makeReq({ body: { autoRefillThresholdCents: 5000, stoppedInstanceRatePercent: 100 } }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdatePricing).toHaveBeenCalledWith(
      expect.objectContaining({
        autoRefillThresholdCents: 5000,
        stoppedInstanceRatePercent: 100,
      }),
      ADMIN_EMAIL,
    );
  });

  it("requires an admin session (401 without the cookie)", async () => {
    const res = await PUT(makeReq({ body: { stoppedInstanceRatePercent: 100 }, withSession: false }));
    expect(res.status).toBe(401);
    expect(mockUpdatePricing).not.toHaveBeenCalled();
  });
});
