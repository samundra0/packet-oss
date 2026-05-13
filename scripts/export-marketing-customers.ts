#!/usr/bin/env npx tsx
/**
 * Export active / paying customers for the marketing team as a CSV.
 *
 * Cohort: anyone in customer_cache (tenant-default) with any meaningful
 * activity — active pods, wallet credit, voucher redemption, or recorded
 * deposits. Broader than "deposited > 0" because monthly subscribers
 * bypass the wallet entirely.
 *
 * Live-from-Stripe fields: name, current wallet balance, lifetime revenue
 * (sum of all successful charges — covers wallet top-ups + monthly
 * subscription invoices).
 *
 * Local fields: email, signup date, coupon redemptions, active pod count
 * (from customer_cache.active_pods which syncs live from hosted.ai),
 * lifetime pod count, recent GPU types, billing type.
 *
 * Output: /tmp/packet-marketing-customers-<date>.csv
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

// ── Load .env.local ─────────────────────────────────────────────────
try {
  const envFile = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch (e) {
  console.error("Could not load .env.local:", (e as Error).message);
  process.exit(1);
}

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY missing in .env.local");
  process.exit(1);
}

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

async function main() {
  console.log("Building cohort from local DB…");

  // ── Coupon redemptions (sum per customer) ───────────────────────
  const voucherRows = await prisma.voucherRedemption.groupBy({
    by: ["stripeCustomerId"],
    _sum: { creditCents: true },
  });
  const couponByCustomer = new Map<string, number>();
  for (const row of voucherRows) {
    couponByCustomer.set(row.stripeCustomerId, row._sum.creditCents ?? 0);
  }

  // ── Lifecycle data (email, signup, wallet deposits) ─────────────
  const lifecycles = await prisma.customerLifecycle.findMany({
    where: { tenantId: "default" },
    select: {
      stripeCustomerId: true,
      email: true,
      signedUpAt: true,
      totalDepositsCents: true,
      currentBillingType: true,
    },
  });
  const lifecycleByCustomer = new Map(lifecycles.map((l) => [l.stripeCustomerId, l]));

  // ── Admin wallet adjustments (support team credits/debits) ──────
  // Two metadata shapes:
  //   adjust-credits:  { amountCents, direction: "credit"|"debit" }
  //   set-balance:     { adjustmentCents, direction: "credit"|"debit" }
  // "credit" = money added to wallet. "debit" = money removed.
  const adjEvents = await prisma.adminActivityEvent.findMany({
    where: { type: "wallet_adjustment" },
    select: { metadata: true },
  });
  const adminCreditsByCustomer = new Map<string, number>();
  for (const e of adjEvents) {
    if (!e.metadata) continue;
    try {
      const m = JSON.parse(e.metadata);
      const cid = m.customerId;
      if (!cid) continue;
      // amountCents (adjust-credits) is positive; adjustmentCents (set-balance) is already signed.
      // Normalize to magnitude then apply direction.
      const cents = Math.abs(Number(m.amountCents ?? m.adjustmentCents ?? 0));
      if (!cents) continue;
      const signed = m.direction === "credit" ? cents : -cents;
      adminCreditsByCustomer.set(cid, (adminCreditsByCustomer.get(cid) ?? 0) + signed);
    } catch {
      // skip malformed
    }
  }

  // ── Cohort: any activity ────────────────────────────────────────
  const allCache = await prisma.customerCache.findMany({
    where: { isDeleted: false },
    select: {
      id: true,
      email: true,
      name: true,
      stripeCreatedAt: true,
      balanceCents: true,
      billingType: true,
      activePods: true,
    },
  });

  // Include every non-deleted customer in the cache (even zero-activity signups).
  const cohort = allCache;
  console.log(`  ${cohort.length} customers with any activity`);

  const customerIds = cohort.map((c) => c.id);

  // ── Active pod count: already in customer_cache (hosted.ai live) ─
  // ── Recent GPU types from pod_metadata (may include stale rows) ─
  const podMetaRows = await prisma.podMetadata.findMany({
    where: { tenantId: "default", stripeCustomerId: { in: customerIds } },
    select: { stripeCustomerId: true, productId: true, billingType: true },
  });
  const gpuProducts = await prisma.gpuProduct.findMany({
    select: { id: true, name: true },
  });
  const productNameById = new Map(gpuProducts.map((p) => [p.id, p.name]));

  const recentGpuTypesByCustomer = new Map<string, Set<string>>();
  const podBillingTypesByCustomer = new Map<string, Set<string>>();
  for (const pod of podMetaRows) {
    const name = pod.productId ? productNameById.get(pod.productId) : undefined;
    if (name) {
      if (!recentGpuTypesByCustomer.has(pod.stripeCustomerId)) {
        recentGpuTypesByCustomer.set(pod.stripeCustomerId, new Set());
      }
      recentGpuTypesByCustomer.get(pod.stripeCustomerId)!.add(name);
    }
    if (pod.billingType) {
      if (!podBillingTypesByCustomer.has(pod.stripeCustomerId)) {
        podBillingTypesByCustomer.set(pod.stripeCustomerId, new Set());
      }
      podBillingTypesByCustomer.get(pod.stripeCustomerId)!.add(pod.billingType);
    }
  }

  // ── Lifetime pod count: distinct subscription_id in wallet_transaction ─
  const lifetimeRows = await prisma.$queryRaw<
    Array<{ stripe_customer_id: string; lifetime_pods: bigint }>
  >`
    SELECT stripe_customer_id, COUNT(DISTINCT subscription_id) AS lifetime_pods
    FROM wallet_transaction
    WHERE subscription_id IS NOT NULL
      AND type IN ('gpu_deploy', 'gpu_usage', 'stopped_reservation')
    GROUP BY stripe_customer_id
  `;
  const lifetimePodsByCustomer = new Map<string, number>();
  for (const row of lifetimeRows) {
    lifetimePodsByCustomer.set(row.stripe_customer_id, Number(row.lifetime_pods));
  }

  // ── Stripe: name + balance + lifetime revenue ───────────────────
  console.log(`Fetching live Stripe data for ${customerIds.length} customers…`);

  const CONCURRENCY = 6;
  const stripeByCustomer = new Map<
    string,
    { name: string; balanceCents: number; lifetimeRevenueCents: number } | null
  >();

  for (let i = 0; i < customerIds.length; i += CONCURRENCY) {
    const batch = customerIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const [customerRes, chargesRes] = await Promise.all([
            stripe.customers.retrieve(id),
            (async () => {
              let total = 0;
              for await (const charge of stripe.charges.list({ customer: id, limit: 100 })) {
                if (charge.status === "succeeded" && !charge.refunded) {
                  total += charge.amount - (charge.amount_refunded ?? 0);
                }
              }
              return total;
            })(),
          ]);
          if ("deleted" in customerRes && customerRes.deleted) return [id, null] as const;
          const c = customerRes as Stripe.Customer;
          return [
            id,
            {
              name: c.name ?? "",
              balanceCents: c.balance ?? 0,
              lifetimeRevenueCents: chargesRes,
            },
          ] as const;
        } catch (err) {
          console.warn(`  ! ${id}: ${(err as Error).message}`);
          return [id, null] as const;
        }
      }),
    );
    for (const [id, data] of results) stripeByCustomer.set(id, data);
    process.stdout.write(`  ${Math.min(i + CONCURRENCY, customerIds.length)}/${customerIds.length}\r`);
  }
  console.log();

  // ── Build CSV ───────────────────────────────────────────────────
  const headers = [
    "Name",
    "Email",
    "Sign-up Date",
    "Billing Type",
    "Current Wallet Balance ($)",
    "Lifetime Revenue ($)",
    "Lifetime Wallet Deposits ($)",
    "Coupon Redeemed ($)",
    "Admin Credits ($)",
    "GPU Spend ($)",
    "Active Pods",
    "Lifetime Pods",
    "Recent GPU Types",
    "Stripe Customer ID",
  ];

  const rows: string[][] = [];
  for (const c of cohort) {
    const lc = lifecycleByCustomer.get(c.id);
    const stripeData = stripeByCustomer.get(c.id);
    const walletCredit = stripeData
      ? Math.abs(Math.min(0, stripeData.balanceCents))
      : Math.abs(Math.min(0, c.balanceCents));
    const lifetimeRevenue = stripeData?.lifetimeRevenueCents ?? 0;
    const walletDeposits = lc?.totalDepositsCents ?? 0;
    const coupon = couponByCustomer.get(c.id) ?? 0;
    const adminCredits = adminCreditsByCustomer.get(c.id) ?? 0;
    const lifetimeCount = lifetimePodsByCustomer.get(c.id) ?? 0;
    const gpuTypes = Array.from(recentGpuTypesByCustomer.get(c.id) ?? [])
      .sort()
      .join(", ");

    // Billing type: prefer pod_metadata (authoritative per-pod), fall back to
    // customer_cache.billingType. "mixed" when a customer has both.
    const podBillings = podBillingTypesByCustomer.get(c.id);
    let billingType: string;
    if (podBillings && podBillings.size > 0) {
      billingType = podBillings.size > 1 ? "mixed" : Array.from(podBillings)[0];
    } else {
      billingType = c.billingType ?? lc?.currentBillingType ?? "";
    }

    const email = lc?.email ?? c.email ?? "";
    const signupDate = (lc?.signedUpAt ?? c.stripeCreatedAt).toISOString().split("T")[0];

    rows.push([
      csvEscape(stripeData?.name ?? c.name ?? ""),
      csvEscape(email),
      csvEscape(signupDate),
      csvEscape(billingType),
      csvEscape(centsToDollars(walletCredit)),
      csvEscape(centsToDollars(lifetimeRevenue)),
      csvEscape(centsToDollars(walletDeposits)),
      csvEscape(coupon > 0 ? centsToDollars(coupon) : ""),
      csvEscape(adminCredits !== 0 ? centsToDollars(adminCredits) : ""),
      // GPU Spend = all credit put in (deposits + coupons + admin adjustments) − unspent balance
      csvEscape(centsToDollars(Math.max(0, walletDeposits + coupon + adminCredits - walletCredit))),
      csvEscape(c.activePods),
      csvEscape(lifetimeCount),
      csvEscape(gpuTypes),
      csvEscape(c.id),
    ]);
  }

  // Sort: highest lifetime revenue first
  rows.sort((a, b) => parseFloat(b[5]) - parseFloat(a[5]));

  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const date = new Date().toISOString().split("T")[0];
  const outPath = `/tmp/packet-marketing-customers-${date}.csv`;
  writeFileSync(outPath, csv, "utf-8");

  console.log(`\nWrote ${rows.length} rows → ${outPath}`);

  // ── Summary ─────────────────────────────────────────────────────
  const totalRevenue = Array.from(stripeByCustomer.values()).reduce(
    (s, d) => s + (d?.lifetimeRevenueCents ?? 0),
    0,
  );
  const totalDeposits = cohort.reduce(
    (s, c) => s + (lifecycleByCustomer.get(c.id)?.totalDepositsCents ?? 0),
    0,
  );
  const totalCredit = Array.from(stripeByCustomer.values()).reduce(
    (s, d) => s + (d ? Math.abs(Math.min(0, d.balanceCents)) : 0),
    0,
  );
  const totalCoupons = Array.from(couponByCustomer.values()).reduce((s, v) => s + v, 0);
  const totalActive = cohort.reduce((s, c) => s + c.activePods, 0);
  console.log(`\nSummary:`);
  console.log(`  Customers in cohort:    ${rows.length}`);
  console.log(`  Lifetime revenue:       $${centsToDollars(totalRevenue)}`);
  console.log(`    ↳ wallet top-ups:     $${centsToDollars(totalDeposits)}`);
  console.log(`  Current wallet credit:  $${centsToDollars(totalCredit)}`);
  console.log(`  Coupons redeemed:       $${centsToDollars(totalCoupons)} (${couponByCustomer.size} customers)`);
  console.log(`  Active pods total:      ${totalActive}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
