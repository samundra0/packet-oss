import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { resolveAllTeamsForEmail } from "@/lib/customer-resolver";
import { getSetting } from "@/lib/settings";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();

    if (!token) {
      return NextResponse.json(
        { error: "Token is required" },
        { status: 400 }
      );
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    const tosVersion = await getSetting("TOS_VERSION");
    if (!tosVersion) {
      return NextResponse.json(
        { error: "TOS version not configured" },
        { status: 400 }
      );
    }

    // Resolve the primary customer for this email
    const resolved = await resolveAllTeamsForEmail(payload.email, payload.customerId);
    if (!resolved) {
      return NextResponse.json(
        { error: "Account not found" },
        { status: 404 }
      );
    }

    const ipAddress =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("cf-connecting-ip") ||
      null;
    const userAgent = request.headers.get("user-agent") || null;

    await prisma.tosAcceptance.upsert({
      where: {
        stripeCustomerId_tosVersion: {
          stripeCustomerId: resolved.primaryCustomer.id,
          tosVersion,
        },
      },
      create: {
        stripeCustomerId: resolved.primaryCustomer.id,
        tosVersion,
        ipAddress,
        userAgent,
      },
      update: {}, // No-op on duplicate (double-click safe)
    });

    console.log(`TOS acceptance: ${payload.email} accepted v${tosVersion}`);

    return NextResponse.json({
      accepted: true,
      version: tosVersion,
    });
  } catch (error) {
    console.error("TOS accept error:", error);
    return NextResponse.json(
      { error: "Failed to record TOS acceptance. Please try again." },
      { status: 500 }
    );
  }
}
