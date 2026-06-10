import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { prisma } from "@/lib/prisma";
import { gatePermission } from "@/lib/auth/gate";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import {
  getOrCreateReferralCode,
  getReferralStats,
  getReferralSettings,
  applyReferralCode,
  validateReferralCode,
} from "@/lib/referral";

// GET - Get customer's referral code and stats
export async function GET(request: NextRequest) {
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

    // PA-230 fix: resolve operating context so the gate receives a real
    // customerEmail (implicit-Owner fallback) AND so the referral code is
    // scoped to the team a member is operating in, not their own customer.
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // PA-201/PA-202 gate: Referral is Team Admin only.
    const denial = await gatePermission({
      payload,
      accountId: ctx.accountId,
      customerEmail: typeof ctx.customer.email === "string" ? ctx.customer.email : null,
      permission: "referral.view",
      request,
    });
    if (denial) return denial;

    const settings = getReferralSettings();

    if (!settings.enabled) {
      return NextResponse.json({
        enabled: false,
        code: null,
        stats: null,
      });
    }

    // Get or create referral code for this customer (operating account).
    const code = await getOrCreateReferralCode(ctx.accountId);

    // Get stats and referral claims
    const stats = await getReferralStats(ctx.accountId);

    // Get detailed referral claims for this user's code
    const referralCode = await prisma.referralCode.findUnique({
      where: { stripeCustomerId: ctx.accountId },
      include: {
        claims: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    const referrals = referralCode?.claims.map((claim) => ({
      id: claim.id,
      email: claim.refereeEmail,
      status: claim.status,
      createdAt: claim.createdAt.toISOString(),
      creditedAt: claim.creditedAt?.toISOString() || null,
    })) || [];

    // Check if this customer has already used a referral code
    const existingClaim = await prisma.referralClaim.findUnique({
      where: { refereeCustomerId: ctx.accountId },
      include: { referralCode: true },
    });

    let usedReferralCode = null;
    let usedReferralStatus = null;
    if (existingClaim) {
      usedReferralCode = existingClaim.referralCode.code;
      usedReferralStatus = existingClaim.status;
    }

    return NextResponse.json({
      enabled: true,
      code,
      stats,
      referrals, // List of people who used this code
      rewardAmount: settings.rewardAmountCents / 100, // Convert to dollars
      rewardHours: Math.floor(settings.rewardAmountCents / 200), // $2/hour
      minTopupRequired: settings.minTopupCents / 100, // Min top-up to qualify
      maxReferrals: settings.maxReferralsPerCustomer, // 0 = unlimited
      usedReferralCode, // Code they used (if any)
      usedReferralStatus, // pending | qualified | credited
    });
  } catch (error) {
    console.error("Get referral error:", error);
    return NextResponse.json(
      { error: "Failed to get referral info" },
      { status: 500 }
    );
  }
}

// POST - Apply a referral code (for new customers entering a friend's code)
export async function POST(request: NextRequest) {
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

    // PA-230 fix: see GET handler comment. Scope referral apply/validate
    // to the operating account so invited members redeem codes onto the
    // team they're switched into.
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // PA-201/PA-202 gate: Referral is Team Admin only.
    const denial = await gatePermission({
      payload,
      accountId: ctx.accountId,
      customerEmail: typeof ctx.customer.email === "string" ? ctx.customer.email : null,
      permission: "referral.view",
      request,
    });
    if (denial) return denial;

    const body = await request.json();
    const { code, action } = body;

    // Validate action
    if (action === "validate") {
      // Just validate the code without applying
      const result = await validateReferralCode(code);
      return NextResponse.json(result);
    }

    if (action === "apply") {
      if (!code) {
        return NextResponse.json(
          { success: false, error: "Referral code is required" },
          { status: 400 }
        );
      }

      // Use the resolved operating customer (already fetched by ctx). No
      // second Stripe round-trip needed.
      const customer = ctx.customer;
      const email = "email" in customer ? customer.email || "" : "";

      const result = await applyReferralCode(code, ctx.accountId, email);

      if (!result.success) {
        return NextResponse.json(
          { success: false, error: result.error },
          { status: 400 }
        );
      }

      return NextResponse.json({
        success: true,
        message: "Referral code applied! You'll receive your bonus when you top up $100+.",
      });
    }

    return NextResponse.json(
      { error: "Invalid action" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Apply referral error:", error);
    return NextResponse.json(
      { error: "Failed to apply referral code" },
      { status: 500 }
    );
  }
}
