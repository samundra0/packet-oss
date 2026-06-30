import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/admin";
import { getStripe, getStripeOrNull } from "@/lib/stripe";
import { createOneTimeLogin, createTeam, suspendTeam, unsuspendTeam, terminateTeam, syncTeamsToDefaultPolicy, ensureDefaultPolicies, ensureRoles } from "@/lib/hostedai";
import { sendEmail } from "@/lib/email";
import {
  emailLayout, emailButton, emailGreeting, emailText, emailMuted,
  emailSignoff, escapeHtml, plainTextFooter,
} from "@/lib/email/utils";
import { generateAdminBypassToken, generateCustomerToken } from "@/lib/customer-auth";
import { logAdminActivity } from "@/lib/admin-activity";
import { cacheCustomer, markCustomerCacheDeleted } from "@/lib/customer-cache";
import { getBrandName, getDashboardUrl } from "@/lib/branding";
import { loadTemplate } from "@/lib/email/template-loader";
import { prisma } from "@/lib/prisma";
import { setSuspension } from "@/lib/customer-suspension";
import Stripe from "stripe";

async function sendCredentialsEmail(params: {
  to: string;
  customerName: string;
  dashboardUrl: string;
}) {
  const brandName = getBrandName();
  const dashboardBaseUrl = getDashboardUrl();

  const subject = `Your {{brandName}} login link`;
  const html = emailLayout({
    preheader: `Your login link for {{brandName}}`,
    body: `
      ${emailGreeting("{{customerName}}")}
      ${emailText(`Here is your login link for {{brandName}}:`)}
      ${emailButton("Open Dashboard", "{{dashboardUrl}}")}
      ${emailMuted(`This link expires in 1 hour. Request a new one at <a href="{{dashboardBaseUrl}}/account" style="color: #1a4fff;">{{dashboardBaseUrl}}/account</a>`)}
      ${emailMuted("Did not request this? You can safely ignore this email.")}
      ${emailSignoff()}
    `,
  });
  const text = `Hi {{customerName}},\n\nHere is your login link for {{brandName}}:\n\nOpen Dashboard: {{dashboardUrl}}\n\nThis link expires in 1 hour. Request a new one at {{dashboardBaseUrl}}/account\n\nDid not request this? You can ignore this email.\n${plainTextFooter()}`;

  const template = await loadTemplate(
    "customer-login",
    {
      customerName: escapeHtml(params.customerName),
      dashboardUrl: params.dashboardUrl,
      brandName,
      dashboardBaseUrl,
    },
    { subject, html, text }
  );

  await sendEmail({
    to: params.to,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });
}

export async function POST(
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
  const { action, amount, description, reason, reasonNote } = await request.json();

  // ── login-as: no Stripe needed, handle early ──────────────────────────
  if (action === "login-as") {
    const cached = await prisma.customerCache.findUnique({ where: { id: customerId } });
    const email = cached?.email;
    if (!email) {
      return NextResponse.json({ error: "Customer has no email" }, { status: 400 });
    }
    const token = generateAdminBypassToken(email.toLowerCase(), customerId, session.email);
    const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?token=${token}`;
    logAdminActivity(
      session.email,
      "customer_viewed",
      `Generated "Login as" link for ${email}`,
      { customerId, customerEmail: email, action: "login-as" }
    ).catch(() => {});
    return NextResponse.json({ success: true, url: dashboardUrl });
  }

  // ── send-credentials: no Stripe needed in OSS, handle early ──────────
  if (action === "send-credentials") {
    const cached = await prisma.customerCache.findUnique({ where: { id: customerId } });
    if (!cached?.email) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    const name = cached.name || cached.email.split("@")[0] || "Customer";
    const token = generateCustomerToken(cached.email.toLowerCase(), customerId);
    const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?token=${token}`;
    try {
      await sendCredentialsEmail({ to: cached.email, customerName: name, dashboardUrl });
      await logAdminActivity(session.email, "customer_viewed", `Sent login credentials to ${cached.email}`, { customerId, customerEmail: cached.email });
      return NextResponse.json({ success: true, message: "Credentials sent" });
    } catch (err) {
      return NextResponse.json({ error: `Failed to send: ${err instanceof Error ? err.message : "unknown"}` }, { status: 500 });
    }
  }

  // ── Non-Stripe actions: handle before Stripe init ─────────────────┐
  if (action === "toggle-bare-metal" || action === "hostedai-login") {
    const cached = await prisma.customerCache.findUnique({ where: { id: customerId } });
    if (action === "toggle-bare-metal") {
      const existing = await prisma.customerSettings.findUnique({ where: { stripeCustomerId: customerId } });
      const newValue = !(existing?.bareMetalEnabled ?? false);
      await prisma.customerSettings.upsert({
        where: { stripeCustomerId: customerId },
        update: { bareMetalEnabled: newValue },
        create: { stripeCustomerId: customerId, bareMetalEnabled: newValue },
      });
      const email = cached?.email || customerId;
      await logAdminActivity(session.email, "customer_viewed", `${newValue ? "Enabled" : "Disabled"} bare metal access for ${email}`, { customerId, customerEmail: email, bareMetalEnabled: newValue });
      return NextResponse.json({ success: true, message: `Bare metal ${newValue ? "enabled" : "disabled"} for ${email}`, bareMetalEnabled: newValue });
    }
    if (action === "hostedai-login") {
      if (!cached?.email) return NextResponse.json({ error: "Customer has no email" }, { status: 400 });
      if (!cached?.teamId) return NextResponse.json({ error: "Customer has no hosted.ai team" }, { status: 400 });
      try {
        const haiRoles = await ensureRoles();
        const otl = await createOneTimeLogin({ email: cached.email, send_email_invite: false, teamId: cached.teamId, roleId: haiRoles.teamAdmin, userName: cached.name || cached.email.split("@")[0] });
        await logAdminActivity(session.email, "customer_viewed", `Generated hosted.ai login link for ${cached.email}`, { customerId, customerEmail: cached.email, teamId: cached.teamId, action: "hostedai-login" });
        return NextResponse.json({ success: true, url: otl.url });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return NextResponse.json({ error: `Failed to generate login: ${msg}` }, { status: 500 });
      }
    }
  }

  // ── adjust-credits / set-balance: use local cache when no Stripe ──
  if (action === "adjust-credits" || action === "set-balance") {
    const stripe = await getStripeOrNull();
    if (stripe) {
      // Stripe available — let the main block handle it
    } else {
      // No Stripe — store balance in customer_cache.balance_cents
      const cached = await prisma.customerCache.findUnique({ where: { id: customerId } });
      if (!cached) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

      if (action === "adjust-credits") {
        const deltaDollars = parseFloat(amount);
        if (isNaN(deltaDollars) || deltaDollars === 0) {
          return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
        }
        const deltaCents = Math.round(deltaDollars * 100);
        if (!reason) return NextResponse.json({ error: "Reason is required" }, { status: 400 });
        const currentBalance = cached.balanceCents || 0;
        // Stripe convention: positive = debt, negative = credit.
        // Adding credit means making balance more negative.
        const newBalance = currentBalance - deltaCents;
        await prisma.customerCache.update({ where: { id: customerId }, data: { balanceCents: newBalance } });
        const reasonLabel = reason === "other" ? (reasonNote || "Other") : reason.replace(/_/g, " ");
        await logAdminActivity(session.email, "wallet_adjustment", `${deltaCents >= 0 ? "Added" : "Subtracted"} $${Math.abs(deltaDollars).toFixed(2)} ${deltaCents >= 0 ? "to" : "from"} ${cached.email || customerId} — ${reasonLabel}${reasonNote && reason !== "other" ? `: ${reasonNote}` : ""}`, { customerId, customerEmail: cached.email, deltaCents, reason, reasonNote: reasonNote || null });
        return NextResponse.json({ success: true, message: `Balance adjusted by $${Math.abs(deltaDollars).toFixed(2)}`, newBalance });
      }

      if (action === "set-balance") {
        const targetDollars = parseFloat(amount);
        if (isNaN(targetDollars) || targetDollars < 0) return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
        if (!reason) return NextResponse.json({ error: "Reason is required" }, { status: 400 });
        const targetCents = Math.round(targetDollars * 100);
        const currentBalance = cached.balanceCents || 0;
        // Stripe stores positive = debt, so credit balance = -credit. A "$600 credit" means balance = -60000.
        const stripeBalance = -targetCents;
        await prisma.customerCache.update({ where: { id: customerId }, data: { balanceCents: stripeBalance } });
        const reasonLabel = reason === "other" ? (reasonNote || "Other") : reason.replace(/_/g, " ");
        await logAdminActivity(session.email, "wallet_adjustment", `Set balance to $${targetDollars.toFixed(2)} for ${cached.email || customerId} (was $${(currentBalance / 100).toFixed(2)}) — ${reasonLabel}${reasonNote && reason !== "other" ? `: ${reasonNote}` : ""}`, { customerId, customerEmail: cached.email, previousBalance: currentBalance, newBalance: stripeBalance, reason, reasonNote: reasonNote || null, method: "set_balance" });
        return NextResponse.json({ success: true, message: `Balance set to $${targetDollars.toFixed(2)}`, newBalance: stripeBalance });
      }
    }
  }

  try {
    const stripe = await getStripe();
    const customer = await stripe.customers.retrieve(customerId);

    if ("deleted" in customer && customer.deleted) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    cacheCustomer(customer as Stripe.Customer).catch(() => {});

    const teamId = customer.metadata?.hostedai_team_id;

    switch (action) {
      case "send-credentials": {
        if (!customer.email) {
          return NextResponse.json({ error: "Customer has no email" }, { status: 400 });
        }

        try {
          // Auto-provision team if missing (webhook may have been lost during deployment)
          let resolvedTeamId = teamId;
          if (!resolvedTeamId) {
            console.log(`[Admin] No team ID for ${customer.email}, auto-provisioning...`);
            const customerName = customer.name || customer.email.split("@")[0];
            const safeName = customerName.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 30) || "user";
            const billingType = customer.metadata?.billing_type || "hourly";
            const [adminPolicies, adminRoles] = await Promise.all([
              ensureDefaultPolicies(),
              ensureRoles(),
            ]);
            const team = await createTeam({
              name: `${safeName}-${billingType}-${Date.now()}`,
              description: `${getBrandName()} - Auto-provisioned by admin`,
              color: "#6366F1",
              members: [
                {
                  email: customer.email,
                  name: customerName,
                  role: adminRoles.teamAdmin,
                  send_email_invite: false,
                  pre_onboard: true,
                },
              ],
              pricing_policy_id: adminPolicies.pricing,
              resource_policy_id: adminPolicies.resource,
              service_policy_id: adminPolicies.service,
              instance_type_policy_id: adminPolicies.instanceType,
              image_policy_id: adminPolicies.image,
            });
            resolvedTeamId = team.id;
            console.log(`[Admin] Created team ${team.id} for ${customer.email}`);

            // CRITICAL: Add team to resource policy's teams array
            // Without this, the team cannot access GPU pools
            try {
              await syncTeamsToDefaultPolicy([team.id]);
              console.log(`[Admin] Added team ${team.id} to default resource policy`);
            } catch (policyError) {
              console.error(`[Admin] WARNING: Failed to add team to resource policy:`, policyError);
            }

            // Store team ID in Stripe metadata so it doesn't need provisioning again
            const updatedWithTeam = await stripe.customers.update(customerId, {
              metadata: {
                ...customer.metadata,
                hostedai_team_id: team.id,
              },
            });
            cacheCustomer(updatedWithTeam as Stripe.Customer).catch(() => {});
            console.log(`[Admin] Updated Stripe metadata with team ID ${team.id}`);
          }

          const credRoles = await ensureRoles();
          const otl = await createOneTimeLogin({
            email: customer.email,
            send_email_invite: false,
            teamId: resolvedTeamId,
            roleId: credRoles.teamAdmin,
            userName: customer.name || customer.email.split("@")[0],
          });

          // Generate our JWT-based dashboard URL (NOT the hosted.ai OTL URL)
          const dashboardToken = generateCustomerToken(customer.email.toLowerCase(), customerId);
          const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?token=${dashboardToken}`;

          await sendCredentialsEmail({
            to: customer.email,
            customerName: customer.name || customer.email.split("@")[0],
            dashboardUrl,
          });

          // Log credentials sent
          await logAdminActivity(
            session.email,
            "customer_viewed", // Reusing type since no specific "credentials_sent" type
            `Sent login credentials to ${customer.email}`,
            { customerId, customerEmail: customer.email }
          );

          return NextResponse.json({ success: true, message: "Credentials sent" });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Failed to send credentials to ${customer.email}:`, errorMessage);

          if (errorMessage.includes("12330015") || errorMessage.includes("failed to process team")) {
            return NextResponse.json({
              error: `Team ${teamId} does not exist on hosted.ai. The customer may need a new team created.`,
            }, { status: 400 });
          }

          return NextResponse.json({
            error: `Failed to generate login link: ${errorMessage}`,
          }, { status: 500 });
        }
      }

      case "cancel": {
        const subscriptions = await stripe.subscriptions.list({
          customer: customerId,
          status: "active",
          limit: 1,
        });

        if (subscriptions.data.length === 0) {
          return NextResponse.json({ error: "No active subscription" }, { status: 400 });
        }

        await stripe.subscriptions.cancel(subscriptions.data[0].id);

        if (teamId) {
          try {
            await suspendTeam(teamId);
          } catch (e) {
            console.error("Failed to suspend team:", e);
          }
        }

        // Log subscription cancellation
        await logAdminActivity(
          session.email,
          "customer_viewed", // Reusing type
          `Canceled subscription for ${customer.email || customerId}`,
          { customerId, customerEmail: customer.email, action: "cancel-subscription" }
        );

        return NextResponse.json({ success: true, message: "Subscription canceled" });
      }

      case "suspend": {
        // Fraud lockout: blocks login, kills GPU access, cancels subscriptions,
        // zeros wallet. Applied to ALL Stripe customers sharing this email
        // (a single user may have linked hourly + monthly accounts).
        if (!reason) {
          return NextResponse.json({ error: "Reason is required for suspension" }, { status: 400 });
        }

        const reasonLabel = reason === "other" ? (reasonNote || "Other") : reason.replace(/_/g, " ");
        const fullReason = `${reasonLabel}${reasonNote && reason !== "other" ? `: ${reasonNote}` : ""}`;

        // Find all linked Stripe customers (same email)
        const linkedCustomers: Stripe.Customer[] = [customer as Stripe.Customer];
        if (customer.email) {
          const allWithEmail = await stripe.customers.list({ email: customer.email, limit: 20 });
          for (const c of allWithEmail.data) {
            if (c.id !== customerId) linkedCustomers.push(c);
          }
        }

        const teamIds = new Set<string>();
        for (const c of linkedCustomers) {
          const tid = c.metadata?.hostedai_team_id;
          if (tid) teamIds.add(tid);
        }

        const errors: string[] = [];

        // 1. Suspend all hosted.ai teams (block GPU access)
        for (const tid of teamIds) {
          try {
            await suspendTeam(tid);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`Failed to suspend team ${tid}:`, msg);
            errors.push(`HAI team ${tid}: ${msg}`);
          }
        }

        // 2. Cancel active subscriptions across all linked customers
        let canceledSubs = 0;
        for (const c of linkedCustomers) {
          try {
            const subs = await stripe.subscriptions.list({ customer: c.id, status: "active", limit: 100 });
            for (const sub of subs.data) {
              await stripe.subscriptions.cancel(sub.id);
              canceledSubs++;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`Failed to cancel subs for ${c.id}:`, msg);
            errors.push(`Subscriptions ${c.id}: ${msg}`);
          }
        }

        // 3. Zero out wallet on every linked customer (debit any positive credit)
        let zeroedCents = 0;
        for (const c of linkedCustomers) {
          const creditCents = -(c.balance || 0); // Stripe: negative balance = credit
          if (creditCents > 0) {
            try {
              await stripe.customers.createBalanceTransaction(c.id, {
                amount: creditCents, // positive = debit (removes credit)
                currency: "usd",
                description: `Wallet zeroed on suspension: ${fullReason}`,
                metadata: {
                  adjusted_by: session.email,
                  adjustment_type: "admin_suspension",
                  reason,
                  reason_note: reasonNote || "",
                },
              });
              zeroedCents += creditCents;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`Failed to zero wallet for ${c.id}:`, msg);
              errors.push(`Wallet ${c.id}: ${msg}`);
            }
          }
        }

        // 4. Set suspension flag on every linked customer (blocks dashboard login)
        for (const c of linkedCustomers) {
          try {
            await setSuspension({
              stripeCustomerId: c.id,
              suspended: true,
              reason: fullReason,
              adminEmail: session.email,
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`Failed to set suspension flag for ${c.id}:`, msg);
            errors.push(`DB flag ${c.id}: ${msg}`);
          }
        }

        await logAdminActivity(
          session.email,
          "customer_viewed",
          `Suspended ${customer.email || customerId} (fraud lockout) — ${fullReason}`,
          {
            customerId,
            customerEmail: customer.email,
            linkedCustomerIds: linkedCustomers.map(c => c.id),
            teamIds: Array.from(teamIds),
            canceledSubs,
            zeroedCents,
            reason,
            reasonNote: reasonNote || null,
            errors,
            action: "suspend-customer",
          }
        );

        return NextResponse.json({
          success: true,
          message: `Customer suspended. Canceled ${canceledSubs} subs, zeroed $${(zeroedCents / 100).toFixed(2)}, blocked ${teamIds.size} HAI team(s).${errors.length ? ` ${errors.length} non-fatal error(s) — see logs.` : ""}`,
          errors: errors.length ? errors : undefined,
        });
      }

      case "unsuspend": {
        // Reverses the suspension flag and unsuspends HAI teams across all
        // linked customers. Does NOT restore canceled subscriptions or refund
        // zeroed wallet — admin must do that manually if appropriate.
        const linkedCustomers: Stripe.Customer[] = [customer as Stripe.Customer];
        if (customer.email) {
          const allWithEmail = await stripe.customers.list({ email: customer.email, limit: 20 });
          for (const c of allWithEmail.data) {
            if (c.id !== customerId) linkedCustomers.push(c);
          }
        }

        const teamIds = new Set<string>();
        for (const c of linkedCustomers) {
          const tid = c.metadata?.hostedai_team_id;
          if (tid) teamIds.add(tid);
        }

        const errors: string[] = [];

        for (const tid of teamIds) {
          try {
            await unsuspendTeam(tid);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`Failed to unsuspend team ${tid}:`, msg);
            errors.push(`HAI team ${tid}: ${msg}`);
          }
        }

        for (const c of linkedCustomers) {
          try {
            await setSuspension({ stripeCustomerId: c.id, suspended: false });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`Failed to clear suspension flag for ${c.id}:`, msg);
            errors.push(`DB flag ${c.id}: ${msg}`);
          }
        }

        await logAdminActivity(
          session.email,
          "customer_viewed",
          `Unsuspended ${customer.email || customerId}`,
          {
            customerId,
            customerEmail: customer.email,
            linkedCustomerIds: linkedCustomers.map(c => c.id),
            teamIds: Array.from(teamIds),
            errors,
            action: "unsuspend-customer",
          }
        );

        return NextResponse.json({
          success: true,
          message: `Customer unsuspended.${errors.length ? ` ${errors.length} non-fatal error(s) — see logs.` : ""}`,
          errors: errors.length ? errors : undefined,
        });
      }

      case "adjust-credits": {
        // Amount is in dollars (can be positive to add or negative to remove credits)
        const amountDollars = parseFloat(amount);
        if (isNaN(amountDollars)) {
          return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
        }

        if (!reason) {
          return NextResponse.json({ error: "Reason is required for wallet adjustments" }, { status: 400 });
        }

        const amountCents = Math.round(amountDollars * 100);
        const reasonLabel = reason === "other" ? (reasonNote || "Other") : reason.replace(/_/g, " ");
        const adjustDescription = `${amountDollars >= 0 ? "Credit" : "Debit"}: ${reasonLabel}${reasonNote && reason !== "other" ? ` - ${reasonNote}` : ""}`;

        // Create balance transaction
        // In Stripe: negative amount = credit to customer, positive = debit from customer
        // Since we want positive dollars to ADD credits: multiply by -1
        await stripe.customers.createBalanceTransaction(customerId, {
          amount: -amountCents, // Negative = credit to customer
          currency: "usd",
          description: adjustDescription,
          metadata: {
            adjusted_by: session.email,
            adjustment_type: "admin_manual",
            reason,
            reason_note: reasonNote || "",
          },
        });

        // Get updated balance
        const updatedCustomer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
        cacheCustomer(updatedCustomer).catch(() => {});
        const newBalance = -(updatedCustomer.balance || 0); // Convert to credits view

        // Log wallet adjustment to admin activity
        const direction = amountDollars >= 0 ? "Added" : "Removed";
        await logAdminActivity(
          session.email,
          "wallet_adjustment",
          `${direction} $${Math.abs(amountDollars).toFixed(2)} ${amountDollars >= 0 ? "to" : "from"} ${customer.email || customerId} — ${reasonLabel}${reasonNote && reason !== "other" ? `: ${reasonNote}` : ""}`,
          {
            customerId,
            customerEmail: customer.email,
            amountCents,
            amountDollars,
            direction: amountDollars >= 0 ? "credit" : "debit",
            reason,
            reasonNote: reasonNote || null,
            previousBalance: newBalance - amountCents,
            newBalance,
          }
        );

        return NextResponse.json({
          success: true,
          message: `Credits adjusted by $${amountDollars.toFixed(2)}. New balance: $${(newBalance / 100).toFixed(2)}`,
          newBalance,
        });
      }

      case "set-balance": {
        if (!stripe) return NextResponse.json({ error: "Payment processor not configured" }, { status: 400 });
        const targetDollars = parseFloat(amount);
        if (isNaN(targetDollars) || targetDollars < 0) {
          return NextResponse.json({ error: "Invalid amount - must be a positive number" }, { status: 400 });
        }

        if (!reason) {
          return NextResponse.json({ error: "Reason is required for wallet adjustments" }, { status: 400 });
        }

        // Get current balance (Stripe: negative = credit to customer)
        const currentBalanceCents = -(customer.balance || 0); // Convert to positive credits
        const targetCents = Math.round(targetDollars * 100);
        const adjustmentCents = targetCents - currentBalanceCents;

        if (adjustmentCents === 0) {
          return NextResponse.json({
            success: true,
            message: `Balance already at $${targetDollars.toFixed(2)}`,
            newBalance: targetCents,
          });
        }

        const setReasonLabel = reason === "other" ? (reasonNote || "Other") : reason.replace(/_/g, " ");
        const setDescription = `Set balance to $${targetDollars.toFixed(2)} (was $${(currentBalanceCents / 100).toFixed(2)}): ${setReasonLabel}${reasonNote && reason !== "other" ? ` - ${reasonNote}` : ""}`;

        // Create balance transaction for the difference
        await stripe.customers.createBalanceTransaction(customerId, {
          amount: -adjustmentCents, // Negative = credit to customer
          currency: "usd",
          description: setDescription,
          metadata: {
            adjusted_by: session.email,
            adjustment_type: "admin_set_balance",
            previous_balance_cents: String(currentBalanceCents),
            target_balance_cents: String(targetCents),
            reason,
            reason_note: reasonNote || "",
          },
        });

        // Log the balance set action
        const setDirection = adjustmentCents >= 0 ? "Increased" : "Decreased";
        await logAdminActivity(
          session.email,
          "wallet_adjustment",
          `${setDirection} balance to $${targetDollars.toFixed(2)} for ${customer.email || customerId} (was $${(currentBalanceCents / 100).toFixed(2)}) — ${setReasonLabel}${reasonNote && reason !== "other" ? `: ${reasonNote}` : ""}`,
          {
            customerId,
            customerEmail: customer.email,
            previousBalance: currentBalanceCents,
            newBalance: targetCents,
            adjustmentCents,
            adjustmentDollars: adjustmentCents / 100,
            direction: adjustmentCents >= 0 ? "credit" : "debit",
            reason,
            reasonNote: reasonNote || null,
            method: "set_balance",
          }
        );

        return NextResponse.json({
          success: true,
          message: `Balance set to $${targetDollars.toFixed(2)} (was $${(currentBalanceCents / 100).toFixed(2)})`,
          newBalance: targetCents,
        });
      }

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Customer action error:", error);
    return NextResponse.json({ error: "Failed to perform action" }, { status: 500 });
  }
}

// DELETE /api/admin/customers/[id] - Delete a customer
export async function DELETE(
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
    // ── No Stripe: just delete from local cache ──
    const stripe = await getStripeOrNull();
    if (!stripe) {
      const cached = await prisma.customerCache.findUnique({ where: { id: customerId } });
      const email = cached?.email || "unknown";
      const teamId = cached?.teamId;
      if (teamId) {
        try { await terminateTeam(teamId); } catch { /* skip */ }
      }
      await prisma.customerCache.delete({ where: { id: customerId } }).catch(() => {});
      await logAdminActivity(session.email, "customer_viewed", `Deleted customer ${email} (${customerId})`, { customerId, customerEmail: email, teamId, action: "delete-customer" });
      return NextResponse.json({ success: true, message: `Customer ${email} deleted successfully` });
    }

    const customer = await stripe.customers.retrieve(customerId);
    if ("deleted" in customer && customer.deleted) {
      return NextResponse.json({ error: "Customer already deleted" }, { status: 404 });
    }

    cacheCustomer(customer as Stripe.Customer).catch(() => {});

    const customerEmail = customer.email || "unknown";
    const teamId = customer.metadata?.hostedai_team_id;

    // 1. Cancel any active subscriptions
    const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: "active" });
    for (const sub of subscriptions.data) {
      await stripe.subscriptions.cancel(sub.id);
      console.log(`Canceled subscription ${sub.id} for customer ${customerId}`);
    }

    // 2. Delete/terminate hosted.ai team if exists
    if (teamId) {
      try {
        await terminateTeam(teamId);
        console.log(`Terminated hosted.ai team ${teamId} for customer ${customerId}`);
      } catch (teamError) {
        console.error(`Failed to terminate team ${teamId}:`, teamError);
      }
    }

    // 3. Delete the Stripe customer
    await stripe.customers.del(customerId);
    markCustomerCacheDeleted(customerId).catch(() => {});
    console.log(`Deleted Stripe customer ${customerId}`);

    await logAdminActivity(session.email, "customer_viewed", `Deleted customer ${customer.email} (${customerId})`, { customerId, customerEmail, teamId, action: "delete-customer" });
    return NextResponse.json({ success: true, message: `Customer ${customer.email} deleted successfully` });
  } catch (error) {
    console.error("Customer delete error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `Failed to delete customer: ${errorMessage}` },
      { status: 500 }
    );
  }
}
