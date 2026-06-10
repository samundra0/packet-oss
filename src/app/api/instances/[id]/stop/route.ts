import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { stopInstance } from "@/lib/hostedai";
import { gatePermission } from "@/lib/auth/gate";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";

// PUT - Stop instance
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    const { id } = await params;

    // PA-175: gate against operating account.
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    const denial = await gatePermission({
      payload,
      accountId: ctx.accountId,
      customerEmail: typeof ctx.customer.email === "string" ? ctx.customer.email : null,
      permission: "gpu.terminate",
      request,
      extra: { instanceId: id, action: "stop" },
    });
    if (denial) return denial;

    await stopInstance(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Stop instance error:", error);
    return NextResponse.json(
      { error: "Failed to stop instance" },
      { status: 500 }
    );
  }
}
