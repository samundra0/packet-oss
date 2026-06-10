// Tests for src/app/api/instances/[id]/* — pod lifecycle routes.
//
// These routes are the PA-230 bug class: each one constructs a
// gatePermission call from JWT + operating context, and a single careless
// `customerEmail: null` here means implicit-Owner customers 403 the same way
// they did in /api/services.
//
// What we pin:
//   * Auth gating (missing/invalid token → 401).
//   * resolveOperatingContext is consulted BEFORE gatePermission.
//   * gatePermission receives customerEmail from ctx.customer.email, NOT null
//     (the exact wiring PA-230 violated).
//   * Gate denial is returned verbatim (don't accidentally allow on denial).
//   * Happy path calls the hosted.ai action exactly once.
//
// We don't re-test the gate's internal four-quadrant matrix — that lives in
// tests/lib/auth/gate.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const {
  mockVerifyCustomerToken,
  mockResolveOperatingContext,
  mockGatePermission,
  mockGetInstance,
  mockDeleteInstance,
  mockStopInstance,
  mockStartInstance,
} = vi.hoisted(() => ({
  mockVerifyCustomerToken: vi.fn(),
  mockResolveOperatingContext: vi.fn(),
  mockGatePermission: vi.fn(),
  mockGetInstance: vi.fn(),
  mockDeleteInstance: vi.fn(),
  mockStopInstance: vi.fn(),
  mockStartInstance: vi.fn(),
}));

vi.mock("@/lib/customer-auth", () => ({
  verifyCustomerToken: mockVerifyCustomerToken,
}));
vi.mock("@/lib/auth/account-resolver", () => ({
  resolveOperatingContext: mockResolveOperatingContext,
}));
vi.mock("@/lib/auth/gate", () => ({ gatePermission: mockGatePermission }));
vi.mock("@/lib/hostedai", () => ({
  getInstance: mockGetInstance,
  deleteInstance: mockDeleteInstance,
  stopInstance: mockStopInstance,
  startInstance: mockStartInstance,
}));

import { GET, DELETE } from "@/app/api/instances/[id]/route";
import { PUT as PUT_STOP } from "@/app/api/instances/[id]/stop/route";

const TOKEN = "Bearer valid.jwt.token";
const PAYLOAD = {
  customerId: "cus_jwt",
  email: "alice@example.com",
  userId: "user_alice",
};
const CTX = {
  customer: { id: "cus_op", email: "alice@example.com" },
  accountId: "cus_op",
  allTeamIds: ["team_1"],
  allCustomerIds: ["cus_op"],
  monthlyCustomerIds: [],
};

function makeRequest(method: "GET" | "DELETE" | "PUT", authorized = true) {
  const headers = new Headers();
  if (authorized) headers.set("authorization", TOKEN);
  return new NextRequest("http://localhost/api/instances/i-abc", {
    method,
    headers,
  });
}

const params = Promise.resolve({ id: "i-abc" });

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyCustomerToken.mockReturnValue(PAYLOAD);
  mockResolveOperatingContext.mockResolvedValue(CTX);
  mockGatePermission.mockResolvedValue(null); // allow by default
});

describe("GET /api/instances/[id]", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await GET(makeRequest("GET", false), { params });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token is invalid", async () => {
    mockVerifyCustomerToken.mockReturnValue(null);
    const res = await GET(makeRequest("GET"), { params });
    expect(res.status).toBe(401);
  });

  it("returns the instance on a valid token", async () => {
    mockGetInstance.mockResolvedValue({ id: "i-abc", status: "running" });
    const res = await GET(makeRequest("GET"), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instance).toEqual({ id: "i-abc", status: "running" });
    expect(mockGetInstance).toHaveBeenCalledWith("i-abc");
  });

  it("does NOT call gatePermission (GET is read, gated upstream by token only)", async () => {
    mockGetInstance.mockResolvedValue({ id: "i-abc" });
    await GET(makeRequest("GET"), { params });
    expect(mockGatePermission).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/instances/[id] (pod terminate)", () => {
  it("returns 401 with no token", async () => {
    const res = await DELETE(makeRequest("DELETE", false), { params });
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    mockVerifyCustomerToken.mockReturnValue(null);
    const res = await DELETE(makeRequest("DELETE"), { params });
    expect(res.status).toBe(401);
  });

  it("returns 404 when operating context can't be resolved", async () => {
    mockResolveOperatingContext.mockResolvedValue(null);
    const res = await DELETE(makeRequest("DELETE"), { params });
    expect(res.status).toBe(404);
    expect(mockGatePermission).not.toHaveBeenCalled();
    expect(mockDeleteInstance).not.toHaveBeenCalled();
  });

  it("PA-230 REGRESSION: passes ctx.customer.email (not null) to gatePermission", async () => {
    // This is the exact wiring PA-230 violated in /api/services. If a refactor
    // ever passes null here, implicit-owner customers will 403 again.
    await DELETE(makeRequest("DELETE"), { params });

    expect(mockGatePermission).toHaveBeenCalledTimes(1);
    const call = mockGatePermission.mock.calls[0][0];
    expect(call.customerEmail).toBe("alice@example.com");
    expect(call.customerEmail).not.toBeNull();
    expect(call.accountId).toBe("cus_op");
    expect(call.permission).toBe("gpu.terminate");
  });

  it("passes null customerEmail only when Stripe customer has no email (acceptable)", async () => {
    // Some Stripe customers have email=null (older accounts, sandbox). The
    // route's `typeof ctx.customer.email === "string"` guard preserves this.
    // Tested separately from PA-230 since this is a legitimate null path.
    mockResolveOperatingContext.mockResolvedValue({
      ...CTX,
      customer: { id: "cus_op", email: null },
    });
    await DELETE(makeRequest("DELETE"), { params });

    const call = mockGatePermission.mock.calls[0][0];
    expect(call.customerEmail).toBeNull();
  });

  it("returns the gate denial verbatim when permission is denied", async () => {
    const deniedResponse = NextResponse.json(
      { error: "denied" },
      { status: 403 },
    );
    mockGatePermission.mockResolvedValue(deniedResponse);

    const res = await DELETE(makeRequest("DELETE"), { params });

    expect(res).toBe(deniedResponse); // exact same reference
    expect(mockDeleteInstance).not.toHaveBeenCalled();
  });

  it("calls deleteInstance exactly once on success", async () => {
    mockDeleteInstance.mockResolvedValue({});
    const res = await DELETE(makeRequest("DELETE"), { params });

    expect(res.status).toBe(200);
    expect(mockDeleteInstance).toHaveBeenCalledTimes(1);
    expect(mockDeleteInstance).toHaveBeenCalledWith("i-abc");
  });

  it("returns 500 when deleteInstance throws", async () => {
    mockDeleteInstance.mockRejectedValue(new Error("HAI 500"));
    const res = await DELETE(makeRequest("DELETE"), { params });
    expect(res.status).toBe(500);
  });
});

describe("PUT /api/instances/[id]/stop", () => {
  it("returns 401 with no token", async () => {
    const res = await PUT_STOP(makeRequest("PUT", false), { params });
    expect(res.status).toBe(401);
  });

  it("returns 404 when operating context can't be resolved", async () => {
    mockResolveOperatingContext.mockResolvedValue(null);
    const res = await PUT_STOP(makeRequest("PUT"), { params });
    expect(res.status).toBe(404);
    expect(mockStopInstance).not.toHaveBeenCalled();
  });

  it("PA-230 REGRESSION: passes ctx.customer.email (not null) to gatePermission", async () => {
    await PUT_STOP(makeRequest("PUT"), { params });

    const call = mockGatePermission.mock.calls[0][0];
    expect(call.customerEmail).toBe("alice@example.com");
    expect(call.permission).toBe("gpu.terminate");
    expect(call.extra).toEqual({ instanceId: "i-abc", action: "stop" });
  });

  it("returns the gate denial verbatim when readOnlyMember tries to stop", async () => {
    const denied = NextResponse.json({ error: "denied" }, { status: 403 });
    mockGatePermission.mockResolvedValue(denied);

    const res = await PUT_STOP(makeRequest("PUT"), { params });

    expect(res.status).toBe(403);
    expect(mockStopInstance).not.toHaveBeenCalled();
  });

  it("calls stopInstance exactly once on success", async () => {
    mockStopInstance.mockResolvedValue({});
    const res = await PUT_STOP(makeRequest("PUT"), { params });

    expect(res.status).toBe(200);
    expect(mockStopInstance).toHaveBeenCalledWith("i-abc");
  });
});
