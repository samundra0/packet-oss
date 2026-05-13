import Stripe from "stripe";
import { cacheCustomer } from "./customer-cache";

/**
 * Create a Stripe invoice for a one-time payment so it shows in customer portal.
 *
 * IMPORTANT: Stripe ALWAYS applies customer credit balance at finalization.
 * To prevent this (these are record-keeping invoices, not real charges),
 * we temporarily zero out the credit balance, finalize, then restore it.
 */
export async function createInvoiceForPayment(
  stripe: Stripe,
  customerId: string,
  amount: number,
  description: string,
  paymentIntentId?: string
) {
  try {
    // Step 1: Create draft invoice
    const invoice = await stripe.invoices.create({
      customer: customerId,
      auto_advance: false,
      collection_method: "send_invoice",
      days_until_due: 0,
      pending_invoice_items_behavior: "exclude",
      metadata: {
        type: "wallet_payment",
        payment_intent_id: paymentIntentId || "",
      },
    });

    // Step 2: Attach the line item explicitly to this invoice
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      amount: amount,
      currency: "usd",
      description: description,
    });

    // Step 3: Read current customer balance (negative = credit, positive = owes)
    const customer = await stripe.customers.retrieve(customerId);
    if (customer && !("deleted" in customer)) {
      cacheCustomer(customer).catch(() => {});
    }
    const currentBalance = "deleted" in customer ? 0 : customer.balance;

    // Step 4: If customer has ANY non-zero balance, temporarily zero it out
    // so Stripe doesn't apply credit or add debt to the invoice when we finalize
    let balanceNeutralized = false;
    if (currentBalance !== 0) {
      await stripe.customers.createBalanceTransaction(customerId, {
        amount: -currentBalance, // negate current balance to reach zero
        currency: "usd",
        description: "Temporary hold for invoice generation",
        metadata: { type: "invoice_balance_hold", invoice_id: invoice.id },
      });
      balanceNeutralized = true;
    }

    try {
      // Step 5: Finalize the invoice — balance is zero so nothing gets drained
      await stripe.invoices.finalizeInvoice(invoice.id);

      // Step 6: Mark as paid out of band (no real charge)
      await stripe.invoices.pay(invoice.id, {
        paid_out_of_band: true,
      });
    } finally {
      // Step 7: ALWAYS restore the balance, even if finalize/pay fails
      if (balanceNeutralized && currentBalance !== 0) {
        await stripe.customers.createBalanceTransaction(customerId, {
          amount: currentBalance, // restore original balance
          currency: "usd",
          description: "Restore after invoice generation",
          metadata: { type: "invoice_balance_restore", invoice_id: invoice.id },
        });
      }
    }

    console.log(`Created invoice ${invoice.id} for $${amount / 100} for customer ${customerId}`);
    return invoice;
  } catch (error) {
    console.error("Failed to create invoice:", error);
    // Don't throw - invoice creation is nice-to-have, not critical
  }
}

