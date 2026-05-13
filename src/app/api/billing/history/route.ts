import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { getWalletTransactions, formatCentsForUser } from "@/lib/wallet";

/**
 * GET /api/billing/history
 *
 * Returns the complete Stripe balance transaction history for the authenticated
 * customer, auto-paginating all pages regardless of count.
 *
 * Also returns pre-computed all-time aggregate totals so the dashboard can display
 * accurate "All-Time Spend" stats without the 100-transaction cap imposed by the
 * fast-path in /api/account/verify.
 *
 * Used by:
 *   - BillingTab.tsx  — lazy-loads all-time stats on mount
 *   - downloadTransactionsCSV — exports the complete transaction history
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
    }

    // payload.customerId is the Stripe customer ID baked into the JWT at login time.
    // For team members this is the owner's customer ID — the correct wallet to read.
    const allRaw = await getWalletTransactions(payload.customerId);

    // Apply the same bookkeeping filter as /api/account/verify
    const userFacing = allRaw.filter((txn) => {
      const metaType = txn.metadata?.type;
      if (metaType === "invoice_balance_hold" || metaType === "invoice_balance_restore") return false;
      const desc = (txn.description || "").toLowerCase();
      if (desc.includes("temporary hold for invoice") || desc.includes("restore after invoice")) return false;
      return true;
    });

    // Compute all-time aggregates from the raw Stripe amounts:
    // positive amount = debit (customer spent), negative = credit (customer received)
    let totalSpentCents = 0;
    let totalCreditsCents = 0;
    for (const txn of userFacing) {
      if (txn.amount > 0) {
        totalSpentCents += txn.amount;
      } else {
        totalCreditsCents += Math.abs(txn.amount);
      }
    }

    const transactions = userFacing.map((txn) => ({
      id: txn.id,
      amount: Math.abs(txn.amount),
      amountFormatted: formatCentsForUser(Math.abs(txn.amount)),
      description: txn.description || "Transaction",
      created: txn.created,
      type: txn.amount < 0 ? ("credit" as const) : ("debit" as const),
    }));

    return NextResponse.json({
      transactions,
      allTimeStats: {
        totalSpent: totalSpentCents / 100,
        totalCredits: totalCreditsCents / 100,
        netSpend: (totalSpentCents - totalCreditsCents) / 100,
        transactionCount: transactions.length,
      },
    });
  } catch (error) {
    console.error("[BillingHistory] Error fetching full transaction history:", error);
    return NextResponse.json(
      { error: "Failed to fetch billing history" },
      { status: 500 }
    );
  }
}
