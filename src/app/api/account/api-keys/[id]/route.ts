import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { prisma } from "@/lib/prisma";
import { logApiKeyDeleted } from "@/lib/activity";
import { gatePermission } from "@/lib/auth/gate";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// DELETE - Revoke an API key
export async function DELETE(request: NextRequest, { params }: RouteParams) {
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

    // PA-175: scope to operating account.
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // Find the API key
    const apiKey = await prisma.apiKey.findUnique({
      where: { id },
    });

    if (!apiKey) {
      return NextResponse.json(
        { error: "API key not found" },
        { status: 404 }
      );
    }

    // Verify ownership against operating account.
    if (apiKey.stripeCustomerId !== ctx.accountId) {
      return NextResponse.json(
        { error: "API key not found" },
        { status: 404 }
      );
    }

    // Already revoked
    if (apiKey.revokedAt) {
      return NextResponse.json(
        { error: "API key is already revoked" },
        { status: 400 }
      );
    }

    // PA-175 gate: only Owner / Admin can revoke API keys.
    const denial = await gatePermission({
      payload,
      accountId: ctx.accountId,
      customerEmail: typeof ctx.customer.email === "string" ? ctx.customer.email : null,
      permission: "api_keys.revoke",
      request,
      extra: { apiKeyId: id },
    });
    if (denial) return denial;

    // Revoke the key
    await prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    // Log activity
    logApiKeyDeleted(ctx.accountId, apiKey.name).catch(() => {});

    return NextResponse.json({
      success: true,
      id,
      revoked: true,
      revokedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Revoke API key error:", error);
    return NextResponse.json(
      { error: "Failed to revoke API key" },
      { status: 500 }
    );
  }
}
