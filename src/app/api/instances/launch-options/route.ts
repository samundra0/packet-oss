/**
 * Launch Options API — Category-based for HAI 2.2 unified instances
 *
 * Returns GPU categories with nested products. Each category maps 1:1 to an HAI scenario.
 * Per-category scenario-compatible-services checks determine product availability.
 *
 * HAI handles all compatibility: region, GPU capacity, instance types, images, storage.
 * Packet only needs to know: which products are available + wallet balance.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { getStripe } from "@/lib/stripe";
import { getWalletBalance } from "@/lib/wallet";
import { getSharedVolumes } from "@/lib/hostedai";
import { prisma } from "@/lib/prisma";
import Stripe from "stripe";

export async function GET(request: NextRequest) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
    }

    const stripe = await getStripe();
    const customer = (await stripe.customers.retrieve(payload.customerId)) as Stripe.Customer;
    const teamId = customer.metadata?.hostedai_team_id;
    if (!teamId) {
      return NextResponse.json({ error: "No team associated with this account" }, { status: 400 });
    }

    // === PARALLEL: Fetch everything we need ===
    const [
      dbCategories,
      dbProducts,
      walletBalance,
      sharedVolumes,
      sshKeys,
    ] = await Promise.all([
      prisma.gpuCategory.findMany({
        where: { active: true },
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      }).catch(() => []),
      prisma.gpuProduct.findMany({
        where: { active: true },
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
        include: { categories: { select: { id: true } } },
      }),
      getWalletBalance(payload.customerId).then(w => w.availableBalance).catch(() => 0),
      getSharedVolumes(teamId).catch(() => []),
      prisma.sSHKey.findMany({
        where: { stripeCustomerId: payload.customerId },
        select: { id: true, name: true, fingerprint: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      }).catch(() => []),
    ]);

    // === ENTITLEMENT CHECK ===
    // Check which billing types the customer is entitled to
    const customerBillingType = customer.metadata?.billing_type;
    const hasHourlyWallet = customerBillingType === "hourly" || customerBillingType === "free_trial" || customerBillingType === "free";

    // Check monthly subscriptions across all customer accounts with same email
    const subscribedPriceIds = new Set<string>();
    let hourlyCustomerId: string | null = hasHourlyWallet ? payload.customerId : null;

    if (customer.email) {
      try {
        const allCustomers = await stripe.customers.list({ email: customer.email, limit: 20 });
        for (const cust of allCustomers.data) {
          const bt = cust.metadata?.billing_type;
          if (!hourlyCustomerId && (bt === "hourly" || bt === "free_trial" || bt === "free")) {
            hourlyCustomerId = cust.id;
          }
          try {
            const subs = await stripe.subscriptions.list({ customer: cust.id, status: "active", limit: 10 });
            for (const sub of subs.data) {
              const priceId = sub.items?.data?.[0]?.price?.id;
              if (priceId) subscribedPriceIds.add(priceId);
            }
          } catch (err) {
            console.error(`Failed to fetch subscriptions for ${cust.id}:`, err);
          }
        }
      } catch (err) {
        console.error("Failed to list customers by email:", err);
      }
    }

    // Re-fetch wallet from hourly customer if different from primary
    let walletBalanceCents = walletBalance;
    if (hourlyCustomerId && hourlyCustomerId !== payload.customerId) {
      try {
        const hourlyWallet = await getWalletBalance(hourlyCustomerId);
        walletBalanceCents = hourlyWallet.availableBalance;
      } catch (err) {
        console.error(`Failed to fetch wallet from hourly customer ${hourlyCustomerId}:`, err);
      }
    }

    // === FILTER PRODUCTS BY ENTITLEMENT ===
    const entitledProducts = dbProducts.filter(p => {
      if (p.billingType === "monthly" && p.stripePriceId) {
        return subscribedPriceIds.has(p.stripePriceId);
      }
      if (p.billingType === "hourly") {
        return !!hourlyCustomerId;
      }
      return false;
    });

    // NOTE: Compatibility checks are deferred to /api/instances/category-check
    // Called on-demand when user selects a category in the launch modal

    // === BUILD PRODUCT LIST ===
    const products = entitledProducts.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      pricePerHourCents: p.pricePerHourCents,
      pricePerMonthCents: p.pricePerMonthCents,
      billingType: p.billingType,
      stripePriceId: p.stripePriceId,
      serviceId: p.serviceId,
      categoryIds: p.categories.map((c: { id: string }) => c.id),
      displayOrder: p.displayOrder,
      active: p.active,
      featured: p.featured,
      badgeText: p.badgeText,
      vramGb: p.vramGb,
      cudaCores: p.cudaCores,
      gpuFamily: p.gpuFamily ?? null,
      // Availability checked on-demand via /api/instances/category-check
      available: null as boolean | null,
    }));

    console.log(`[LaunchOpts] ${products.length} entitled products`);

    // === BUILD CATEGORIES LIST ===
    // Only include categories that have at least one entitled product — categories
    // with no products (e.g. B200 not yet provisioned) must not appear in the UI.
    const categories = dbCategories
      .map(cat => ({
        id: cat.id,
        name: cat.name,
        slug: cat.slug,
        description: cat.description,
        displayOrder: cat.displayOrder,
        icon: cat.icon,
        scenarioConfigured: !!cat.scenarioId,
        products: products.filter(p => p.categoryIds.includes(cat.id)),
      }))
      .filter(cat => cat.products.length > 0);

    // Existing shared volumes for persistent storage option
    const existingSharedVolumes = (sharedVolumes || []).map(v => ({
      id: v.id,
      name: v.name,
      size_in_gb: v.size_in_gb,
      region_id: v.region_id,
      status: v.status,
      mount_point: v.mount_point,
      cost: v.cost,
    }));

    return NextResponse.json({
      categories,
      products, // flat list for backward compat
      existingSharedVolumes,
      sshKeys,
      teamId,
      walletBalanceCents,
    });
  } catch (error) {
    console.error("Launch options error:", error);
    return NextResponse.json({ error: "Failed to get launch options" }, { status: 500 });
  }
}
