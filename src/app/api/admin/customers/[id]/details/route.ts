import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/admin";
import { getStripeOrNull } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { getTeam } from "@/lib/hostedai";
import { getActivityEvents } from "@/lib/activity";
import Stripe from "stripe";

// GET /api/admin/customers/[id]/details - Get comprehensive customer details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Verify admin session
  const sessionToken = request.cookies.get("admin_session")?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: customerId } = await params;

  try {
    const stripe = await getStripeOrNull();
    let id: string, email: string | null = null, name: string | null = null;
    let created = 0, walletBalance = 0, metadata: Record<string, string> = {};
    let balanceTransactions: unknown[] = [], charges: unknown[] = [], invoices: unknown[] = [];

    if (stripe) {
      const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
      if ("deleted" in customer && customer.deleted) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      }
      id = customer.id; email = customer.email ?? null; name = customer.name ?? null;
      created = customer.created; metadata = (customer.metadata || {}) as Record<string, string>;
      walletBalance = -(customer.balance || 0);

      const [bt, ch, inv] = await Promise.all([
        stripe.customers.listBalanceTransactions(customerId, { limit: 50 }),
        stripe.charges.list({ customer: customerId, limit: 50 }),
        stripe.invoices.list({ customer: customerId, limit: 20 }),
      ]);
      balanceTransactions = bt.data.map(t => ({ id: t.id, amount: t.amount, type: t.type, description: t.description, created: t.created, endingBalance: t.ending_balance }));
      charges = ch.data.map(c => ({ id: c.id, amount: c.amount, status: c.status, description: c.description, created: c.created, paid: c.paid, refunded: c.refunded, paymentMethod: c.payment_method_details?.type }));
      invoices = inv.data.map(i => ({ id: i.id, number: i.number, amount: i.amount_due, status: i.status, created: i.created, pdfUrl: i.invoice_pdf, hostedUrl: i.hosted_invoice_url }));
    } else {
      const cached = await prisma.customerCache.findUnique({ where: { id: customerId } });
      if (!cached) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
      id = cached.id; email = cached.email; name = cached.name;
      created = Math.floor((cached.stripeCreatedAt?.getTime() || Date.now()) / 1000);
      walletBalance = -(cached.balanceCents || 0); // Flip: positive = credit
    }

    // Get hosted.ai team info if available
    const teamId = metadata?.hostedai_team_id;
    let hostedaiTeam = null;
    if (teamId) {
      try { hostedaiTeam = await getTeam(teamId); } catch { /* skip */ }
    }

    // DB-backed data (works without Stripe)
    const [voucherRedemptions, referralCode, referralClaim, activityEvents, customerSettings] = await Promise.all([
      prisma.voucherRedemption.findMany({ where: { stripeCustomerId: customerId }, include: { voucher: true }, orderBy: { createdAt: "desc" } }),
      prisma.referralCode.findFirst({ where: { stripeCustomerId: customerId }, include: { claims: true } }),
      prisma.referralClaim.findFirst({ where: { refereeCustomerId: customerId }, include: { referralCode: true } }),
      getActivityEvents(customerId, 200),
      prisma.customerSettings.findUnique({ where: { stripeCustomerId: customerId }, select: { bareMetalEnabled: true, suspended: true, suspendedAt: true, suspendedReason: true, suspendedBy: true } }),
    ]);

    const totalSpent = Array.isArray(charges) ? charges.filter((c: any) => c.paid && !c.refunded).reduce((sum: number, c: any) => sum + c.amount, 0) : 0;

    return NextResponse.json({
      success: true,
      customer: { id, email, name, created, metadata, billingType: metadata?.billing_type || "free", walletBalance, totalSpent },
      hostedaiTeam,
      balanceTransactions,
      charges,
      invoices,
      voucherRedemptions: voucherRedemptions.map(r => ({ id: r.id, voucherCode: r.voucher.code, voucherName: r.voucher.name, creditCents: r.creditCents, topupCents: r.topupCents, createdAt: r.createdAt })),
      referral: referralCode ? { code: referralCode.code, role: "referrer", totalClaims: referralCode.claims.length, creditedClaims: referralCode.claims.filter(c => c.referrerCredited).length, createdAt: referralCode.createdAt } : referralClaim ? { code: referralClaim.referralCode.code, role: "referred", status: referralClaim.status, credited: referralClaim.refereeCredited, createdAt: referralClaim.createdAt } : null,
      activityEvents,
      bareMetalEnabled: customerSettings?.bareMetalEnabled ?? false,
      suspension: { suspended: customerSettings?.suspended ?? false, suspendedAt: customerSettings?.suspendedAt ?? null, suspendedReason: customerSettings?.suspendedReason ?? null, suspendedBy: customerSettings?.suspendedBy ?? null },
    });
  } catch (error) {
    console.error("Failed to get customer details:", error);
    return NextResponse.json({ error: "Failed to get customer details" }, { status: 500 });
  }
}
