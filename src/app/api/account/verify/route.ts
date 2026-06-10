import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { verifyCustomerToken, type CustomerTokenPayload } from "@/lib/customer-auth";
import {
  createCustomerSession,
  buildSessionCookie,
  isEphemeralToken,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/customer-session";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import { getWalletTransactions, formatCents, formatCentsForUser } from "@/lib/wallet";
import { createOneTimeLogin, ensureRoles } from "@/lib/hostedai";
import { getTwoFactorStatus } from "@/lib/two-factor";
import { logCustomerLogin } from "@/lib/admin-activity";
import { logAccountLogin, logTeamMemberJoined } from "@/lib/activity";
import { recordFirstLogin } from "@/lib/lifecycle";
import { getTeamMemberByEmail, acceptTeamInvite } from "@/lib/team-members";
import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/settings";
import { findSuspension } from "@/lib/customer-suspension";
import { resolveMembership } from "@/lib/auth/membership";
import { redactBillingPayload } from "@/lib/billing-visibility";
import {
  can,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  PACKET_ROLES,
  getHaiRoleForPacketRole,
  type Permission,
  type PacketRole,
} from "@/lib/auth/role-permissions";
import Stripe from "stripe";

function isPacketRole(role: string): role is PacketRole {
  return (PACKET_ROLES as readonly string[]).includes(role);
}

export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();

    if (!token) {
      return NextResponse.json(
        { error: "Token is required" },
        { status: 400 }
      );
    }

    // Verify the token
    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    const stripe = await getStripe();

    // PA-175: unified resolution. Honors JWT.activeAccountId for the multi-team
    // case; falls back to user's own Stripe customer; falls back to team-only
    // (invitee with no own Stripe customer) lookup via team_membership.
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json(
        { error: "Account not found" },
        { status: 404 }
      );
    }

    const customer = ctx.customer;
    const billingType = customer.metadata?.billing_type;
    const teamId = customer.metadata?.hostedai_team_id;
    const monthlyCustomerIds = ctx.monthlyCustomerIds;
    console.log(`[Verify] Resolved ${payload.email}: account=${customer.id}, teams=[${ctx.allTeamIds.join(",")}], monthly=[${monthlyCustomerIds.join(",")}]`);

    // Block suspended customers (fraud lockout). Checks all linked customer
    // IDs since one suspended account locks the whole email out.
    const suspension = await findSuspension(ctx.allCustomerIds);
    if (suspension) {
      console.warn(`[Verify] Blocked suspended customer ${payload.email} (${customer.id})`);
      return NextResponse.json(
        { error: "This account has been suspended. Contact support." },
        { status: 403 }
      );
    }

    // Get wallet balance for hourly customers
    let wallet = null;
    let transactions: Array<{
      id: string;
      amount: number;
      amountFormatted: string;
      description: string;
      created: number;
      type: "credit" | "debit";
    }> = [];

    // ── Parallel fetch: wallet, transactions, subscriptions, payments, invoices ──
    // Use the already-retrieved customer for wallet balance (avoid duplicate Stripe call)
    const availableBalance = -(customer.balance || 0); // Flip sign: positive = credit

    const [walletTxns, subsFromPrimary, payments, invoices, ...monthlySubResults] = await Promise.all([
      getWalletTransactions(customer.id, 100),
      stripe.subscriptions.list({ customer: customer.id, status: "active", limit: 10 }),
      stripe.paymentIntents.list({ customer: customer.id, limit: 50 }),
      stripe.invoices.list({ customer: customer.id, limit: 50, status: "paid" }),
      ...monthlyCustomerIds.map((monthlyId) =>
        stripe.subscriptions.list({ customer: monthlyId, status: "active", limit: 10 }).catch((err) => {
          console.error(`Failed to fetch subscriptions from linked monthly customer ${monthlyId}:`, err);
          return { data: [] as Stripe.Subscription[] };
        })
      ),
    ]);

    // Build wallet info from already-retrieved customer
    {
      const displayBalance = Math.max(0, availableBalance);
      wallet = {
        balance: displayBalance,
        balanceFormatted: formatCentsForUser(availableBalance),
        currency: "usd",
      };

      const userFacingTxns = walletTxns.filter((txn) => {
        const metaType = txn.metadata?.type;
        if (metaType === "invoice_balance_hold" || metaType === "invoice_balance_restore") return false;
        const desc = (txn.description || "").toLowerCase();
        if (desc.includes("temporary hold for invoice") || desc.includes("restore after invoice")) return false;
        return true;
      });

      transactions = userFacingTxns.map((txn) => ({
        id: txn.id,
        amount: Math.abs(txn.amount),
        amountFormatted: formatCentsForUser(Math.abs(txn.amount)),
        description: txn.description || "Transaction",
        created: txn.created,
        type: txn.amount < 0 ? "credit" : "debit",
      }));
    }

    // Build subscriptions from parallel results
    let subscription = null;
    let subscriptions: Array<{
      id: string;
      status: string;
      currentPeriodStart: number;
      currentPeriodEnd: number;
      cancelAtPeriodEnd: boolean;
      productId: string | null;
      productName: string | null;
      poolIds: string[];
      pricePerMonthCents: number | null;
      stripePriceId: string | null;
      quantity: number;
    }> = [];

    {
      let allSubsData = [...subsFromPrimary.data];
      for (const monthlyResult of monthlySubResults) {
        allSubsData = [...allSubsData, ...monthlyResult.data];
      }

      // Deduplicate by subscription ID (shouldn't happen but safety)
      const subs = { data: [...new Map(allSubsData.map(s => [s.id, s])).values()] };

      if (subs.data.length > 0) {
        // Backward compat: keep the singular `subscription` field for the first one
        const firstSub = subs.data[0];
        const firstItem = firstSub.items?.data?.[0];
        subscription = {
          id: firstSub.id,
          status: firstSub.status,
          currentPeriodStart: firstItem?.current_period_start || 0,
          currentPeriodEnd: firstItem?.current_period_end || 0,
          cancelAtPeriodEnd: firstSub.cancel_at_period_end,
        };

        // Collect price and product IDs from subscriptions. We match by both so
        // grandfathered subscriptions (whose price no longer matches the current
        // GpuProduct.stripePriceId) still resolve to a product via stripeProductId.
        const priceIds = subs.data
          .map((s) => s.items?.data?.[0]?.price?.id)
          .filter((id): id is string => !!id);
        const productIds = subs.data
          .map((s) => {
            const prod = s.items?.data?.[0]?.price?.product;
            return typeof prod === "string" ? prod : prod?.id;
          })
          .filter((id): id is string => !!id);

        const matchingProducts = priceIds.length > 0 || productIds.length > 0
          ? await prisma.gpuProduct.findMany({
              where: {
                OR: [
                  { stripePriceId: { in: priceIds } },
                  { stripeProductId: { in: productIds } },
                ],
                billingType: "monthly",
                active: true,
              },
            })
          : [];

        const productByPriceId = new Map(
          matchingProducts
            .filter((p) => p.stripePriceId)
            .map((p) => [p.stripePriceId as string, p])
        );
        const productByProductId = new Map(
          matchingProducts
            .filter((p) => p.stripeProductId)
            .map((p) => [p.stripeProductId as string, p])
        );

        // Build enriched subscriptions array
        subscriptions = subs.data.map((sub) => {
          const item = sub.items?.data?.[0];
          const priceId = item?.price?.id || null;
          const productIdRef = typeof item?.price?.product === "string"
            ? item.price.product
            : item?.price?.product?.id || null;
          const product =
            (priceId ? productByPriceId.get(priceId) : undefined) ??
            (productIdRef ? productByProductId.get(productIdRef) : undefined);

          let poolIds: string[] = [];
          if (product?.poolIds) {
            try {
              poolIds = (JSON.parse(product.poolIds) as unknown[]).map(String);
            } catch {
              poolIds = [];
            }
          }

          return {
            id: sub.id,
            status: sub.status,
            currentPeriodStart: item?.current_period_start || 0,
            currentPeriodEnd: item?.current_period_end || 0,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            productId: product?.id || null,
            productName: product?.name || null,
            poolIds,
            pricePerMonthCents: product?.pricePerMonthCents ?? null,
            stripePriceId: priceId,
            quantity: item?.quantity ?? 1,
          };
        });
      }
    }

    // Build payments + invoices from parallel results above
    const invoicePdfMap = new Map<string, string>();
    for (const inv of invoices.data) {
      if (inv.metadata?.type === "wallet_payment" && inv.metadata?.payment_intent_id && inv.invoice_pdf) {
        invoicePdfMap.set(inv.metadata.payment_intent_id, inv.invoice_pdf);
      }
    }

    const recentPayments = payments.data
      .filter((p) => p.status === "succeeded")
      .map((p) => ({
        id: p.id,
        amount: p.amount,
        amountFormatted: formatCents(p.amount),
        created: p.created,
        description: p.description || "Payment",
        invoicePdf: invoicePdfMap.get(p.id) || null,
      }));

    // ── Parallel fetch: OTL + billing portal + 2FA ──
    const verifyRoles = await ensureRoles();

    // PA-175: derive the OTL role from the user's actual Packet role. Hard-
    // coding teamAdmin destroys invited members' roles because HAI's
    // /create-otl updates UserTeam.role_id whenever it differs from the
    // input (models/one_time_login_tokens.go:242-244). /verify runs on every
    // dashboard load, so the member's HAI role was being reset on every
    // page refresh.
    const customerEmailForOtl =
      typeof customer.email === "string" ? customer.email : null;
    const otlIsOwner =
      payload.email.toLowerCase() === customer.email?.toLowerCase();
    const otlMembership = await resolveMembership({
      userId: payload.userId,
      email: payload.email,
      accountId: customer.id,
      customerEmail: customerEmailForOtl,
    });
    const otlPacketRole: PacketRole | null =
      otlMembership && isPacketRole(otlMembership.role)
        ? otlMembership.role
        : null;
    const otlMembershipIsOwner = otlMembership?.isOwner ?? false;
    const otlHaiSlug = otlPacketRole
      ? getHaiRoleForPacketRole(otlPacketRole, otlMembershipIsOwner)
      : otlIsOwner
        ? "teamAdmin"
        : "readOnlyMember";
    const otlRoleId = verifyRoles[otlHaiSlug];

    // TOS version check (runs in parallel, fail-closed: if query fails, gate stays up)
    const tosVersionPromise = getSetting("TOS_VERSION").then(async (ver) => {
      if (!ver) return { version: null, accepted: true }; // Kill switch: no version = no gate
      const acceptance = await prisma.tosAcceptance.findFirst({
        where: { stripeCustomerId: customer.id, tosVersion: ver },
        select: { id: true },
      });
      return { version: ver, accepted: !!acceptance };
    }).catch(() => {
      // Fail-closed: DB error means we can't confirm acceptance, gate stays up
      return { version: "unknown", accepted: false };
    });

    const [otlResult, portalSession, twoFactorStatus, tosResult] = await Promise.all([
      teamId
        ? createOneTimeLogin({
            email: payload.email,
            send_email_invite: false,
            teamId: teamId,
            roleId: otlRoleId,
          }).catch((error) => {
            console.error("Failed to generate OTL:", error);
            return null;
          })
        : Promise.resolve(null),
      stripe.billingPortal.sessions.create({
        customer: customer.id,
        // PA-267: no token in the return URL — the session cookie authenticates
        // the return to /dashboard, so the token can't leak via Stripe's redirect.
        return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
      }),
      getTwoFactorStatus(payload.email),
      tosVersionPromise,
    ]);

    const gpuDashboardUrl = otlResult?.url || null;

    // Check if logged-in user is the owner (their email matches Stripe customer email)
    // Team members have a different email than the Stripe customer
    const isOwner = payload.email.toLowerCase() === customer.email?.toLowerCase();

    // PA-175: the legacy isTeamMember check (against team_member_legacy)
    // is superseded by the resolveMembership call below — that consults
    // team_membership (the new model) and returns null/revoked for non-members.
    // The legacy lifecycle hook (acceptTeamInvite for team_member_legacy rows)
    // is still useful for accounts that haven't moved to the new flow.
    if (!isOwner) {
      try {
        const teamMember = await getTeamMemberByEmail(payload.email);
        if (teamMember && !teamMember.acceptedAt && teamMember.stripeCustomerId === customer.id) {
          await acceptTeamInvite(teamMember.id);
          console.log(`[Team] Marked invite as accepted for ${payload.email}`);
          logTeamMemberJoined(customer.id, payload.email).catch(() => {});
        }
      } catch (error) {
        console.error("Failed to accept team invite:", error);
      }
    }

    // Check if 2FA can be skipped:
    // - Admin bypass token (skipTwoFactor flag from "Login As" feature)
    // - Token already carries twoFactorVerified from a prior TOTP check
    const skipTwoFactor = payload.skipTwoFactor === true || payload.twoFactorVerified === true;

    // Log customer login to admin activity. During admin "Login as", attribute
    // it to the acting admin (not "system") for a clean audit trail.
    logCustomerLogin(payload.email, customer.id, !isOwner, payload.impersonator?.adminEmail).catch(() => {});

    // Log to customer activity — skip for admin "login as" sessions so customers
    // don't see admin impersonation events in their own activity feed.
    // Deduplicate using the token's iat: only log once per token issuance, not on
    // every page refresh (verify is called on every dashboard load, not just login).
    if (!skipTwoFactor) {
      const tokenIat = new Date(((payload as CustomerTokenPayload & { iat: number }).iat || 0) * 1000);
      const alreadyLogged = await prisma.activityEvent.findFirst({
        where: {
          customerId: customer.id,
          type: "account_login",
          createdAt: { gte: tokenIat },
        },
        select: { id: true },
      });
      if (!alreadyLogged) {
        logAccountLogin(customer.id, payload.email, !isOwner).catch(() => {});
      }
    }

    // Track lifecycle milestone (first login)
    recordFirstLogin(customer.id).catch(() => {});

    // Check if bare metal is enabled for this customer + load teamName
    const customerSettings = await prisma.customerSettings.findUnique({
      where: { stripeCustomerId: customer.id },
      select: { bareMetalEnabled: true, teamName: true },
    });

    // PA-175 PR 3: surface the user's Packet role + can() map. The
    // membership was already resolved above (otlMembership) so HAI's
    // /create-otl gets the correct role; reuse that result here.
    const membership = otlMembership;
    const role: PacketRole | null = otlPacketRole;
    const membershipIsOwner = otlMembershipIsOwner;
    const canMap = Object.fromEntries(
      PERMISSIONS.map((perm) => [perm, can(role, membershipIsOwner, perm)]),
    ) as Record<Permission, boolean>;
    const roleDisplayName = role ? ROLE_PERMISSIONS[role].displayName : null;

    // PA-224: surface the logged-in user's display name so the dashboard
    // sidebar greets the actual viewer, not the operating account's Stripe
    // customer (which is the inviter when an invited member switches in).
    const userRow = await prisma.user.findUnique({
      where: { email: payload.email.toLowerCase() },
      select: { displayName: true },
    });
    const userDisplayName = userRow?.displayName ?? null;

    // PA-267: on a fresh magic-link arrival — a non-ephemeral token with no
    // session cookie yet — establish a persistent 15-day session. Impersonation
    // (skipTwoFactor) is ephemeral and never gets a row, so it stays tab-scoped.
    // Repeat loads already carry the cookie, so no duplicate rows are created.
    // Only persist once 2FA is satisfied — never create a session for a token
    // still pending its TOTP step (the magic-link token before verification).
    const twoFactorSatisfied = !twoFactorStatus.enabled || payload.twoFactorVerified === true;
    let sessionRefreshToken: string | null = null;
    if (
      !isEphemeralToken(payload) &&
      twoFactorSatisfied &&
      !request.cookies.get(SESSION_COOKIE_NAME)?.value
    ) {
      try {
        sessionRefreshToken = await createCustomerSession({
          customerId: payload.customerId,
          email: payload.email,
          userId: payload.userId,
          activeAccountId: payload.activeAccountId,
          userAgent: request.headers.get("user-agent"),
          ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        });
      } catch (err) {
        console.error("[Verify] Failed to create customer session (non-fatal):", err);
      }
    }

    const res = NextResponse.json({
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        billingType,
        teamId,
        created: customer.created,
        teamName: customerSettings?.teamName ?? null,
      },
      // PA-271: redact billing data to []/null for users without billing.view.
      // The verify response is what the whole dashboard reads from, so gating
      // it here (server-side) is the real boundary — a Read-only/Team Member
      // switched into the owner's workspace can no longer read their finances
      // from the sidebar, stat cards, Monthly Subscriptions card, or Billing tab.
      ...redactBillingPayload(canMap["billing.view"], {
        wallet,
        transactions,
        subscription,
        subscriptions,
        recentPayments,
      }),
      gpuDashboardUrl,
      billingPortalUrl: canMap["billing.view"] ? portalSession.url : null,
      isOwner, // legacy field — kept for back-compat during PR 3 UI rollout
      // PA-175 PR 3: authoritative role + permission set for the UI.
      role,
      roleDisplayName,
      membershipIsOwner, // server-side Owner flag (separate from legacy email-match isOwner)
      can: canMap,
      userEmail: payload.email, // The logged-in user's email (may differ from customer email for team members)
      userDisplayName, // PA-224: logged-in user's display name (User.displayName), used for sidebar greeting
      bareMetalEnabled: customerSettings?.bareMetalEnabled ?? false,
      twoFactor: twoFactorStatus, // 2FA status for the user
      skipTwoFactor, // Admin bypass flag
      impersonator: payload.impersonator ?? null, // admin "Login as" marker → impersonation banner
      // PA-266: deep-link intent carried through login in the signed token.
      // Already sanitized at sign time; the dashboard opens the matching modal.
      next: payload.next ?? null,
      // PA-267: signals the client a 15-day cookie session was set, so it can
      // safely strip the one-time token from the URL (kills token-in-URL leak).
      sessionPersisted: !!sessionRefreshToken,
      tosConsent: {
        required: !tosResult.accepted,
        currentVersion: tosResult.version,
      },
    });
    if (sessionRefreshToken) {
      res.cookies.set(buildSessionCookie(sessionRefreshToken, process.env.NODE_ENV === "production"));
    }
    return res;
  } catch (error) {
    console.error("Account verify error:", error);
    return NextResponse.json(
      { error: "Failed to verify account" },
      { status: 500 }
    );
  }
}
