import { NextRequest, NextResponse } from "next/server";
import { getStripeOrNull } from "@/lib/stripe";
import { verifyCustomerToken, type CustomerTokenPayload } from "@/lib/customer-auth";
import {
  createCustomerSession,
  buildSessionCookie,
  isEphemeralToken,
  hasLiveSession,
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

    const stripe = await getStripeOrNull();

    // Resolve customer: try Stripe operating context, fall back to local cache
    let customer: Stripe.Customer | null = null;
    let billingType: string | undefined;
    let teamId: string | undefined;
    let monthlyCustomerIds: string[] = [];
    let allTeamIds: string[] = [];
    let allCustomerIds: string[] = [];

    if (stripe) {
      const ctx = await resolveOperatingContext({
        email: payload.email,
        jwtCustomerId: payload.customerId,
        activeAccountId: payload.activeAccountId,
      });
      if (!ctx) {
        return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
      customer = ctx.customer;
      billingType = customer.metadata?.billing_type;
      teamId = customer.metadata?.hostedai_team_id;
      monthlyCustomerIds = ctx.monthlyCustomerIds;
      allTeamIds = ctx.allTeamIds;
      allCustomerIds = ctx.allCustomerIds;
      console.log(`[Verify] Resolved ${payload.email}: account=${customer.id}, teams=[${allTeamIds.join(",")}], monthly=[${monthlyCustomerIds.join(",")}]`);

      // Block suspended customers
      const suspension = await findSuspension(allCustomerIds);
      if (suspension) {
        console.warn(`[Verify] Blocked suspended customer ${payload.email} (${customer.id})`);
        return NextResponse.json({ error: "This account has been suspended. Contact support." }, { status: 403 });
      }
    } else {
      // No Stripe — resolve from local customer cache
      const cached = await prisma.customerCache.findUnique({ where: { id: payload.customerId } });
      if (cached) {
        customer = {
          id: cached.id,
          email: cached.email,
          name: cached.name,
          metadata: { ...(cached.teamId ? { hostedai_team_id: cached.teamId } : {}) },
          balance: 0,
          created: Math.floor((cached.stripeCreatedAt?.getTime() || Date.now()) / 1000),
          currency: "usd",
          delinquent: null,
          description: null,
          discount: null,
          invoice_prefix: "",
          invoice_settings: {},
          livemode: false,
          next_invoice_sequence: null,
          phone: null,
          preferred_locales: [],
          shipping: null,
          tax_exempt: "none",
          tax_ids: null,
          default_source: null,
          object: "customer",
        } as unknown as Stripe.Customer;
        billingType = "free";
        teamId = cached.teamId || undefined;
      } else {
        return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
    }

    // ── Data loading: Stripe-powered or empty ──
    let wallet = null;
    let transactions: Array<{ id: string; amount: number; amountFormatted: string; description: string; created: number; type: "credit" | "debit" }> = [];
    let subscription = null;
    let subscriptions: Array<{ id: string; status: string; currentPeriodStart: number; currentPeriodEnd: number; cancelAtPeriodEnd: boolean; productId: string | null; productName: string | null; poolIds: string[]; pricePerMonthCents: number | null; stripePriceId: string | null; quantity: number }> = [];
    let recentPayments: Array<{ id: string; amount: number; amountFormatted: string; created: number; description: string; invoicePdf: string | null }> = [];
    let billingPortalUrl: string | null = null;

    if (stripe) {
      const availableBalance = -(customer.balance || 0);
      const [walletTxns, subsFromPrimary, payments, invoices, ...monthlySubResults] = await Promise.all([
        getWalletTransactions(customer.id, 100),
        stripe.subscriptions.list({ customer: customer.id, status: "active", limit: 10 }),
        stripe.paymentIntents.list({ customer: customer.id, limit: 50 }),
        stripe.invoices.list({ customer: customer.id, limit: 50, status: "paid" }),
        ...monthlyCustomerIds.map((monthlyId) =>
          stripe.subscriptions.list({ customer: monthlyId, status: "active", limit: 10 }).catch(() => ({ data: [] as Stripe.Subscription[] }))
        ),
      ]);

      wallet = { balance: Math.max(0, availableBalance), balanceFormatted: formatCentsForUser(availableBalance), currency: "usd" };
      transactions = walletTxns.filter((t) => !t.metadata?.type?.startsWith("invoice_balance_")).map((t) => ({ id: t.id, amount: Math.abs(t.amount), amountFormatted: formatCentsForUser(Math.abs(t.amount)), description: t.description || "Transaction", created: t.created, type: t.amount < 0 ? "credit" : "debit" }));

      // Subscriptions
      let allSubsData = [...subsFromPrimary.data];
      for (const r of monthlySubResults) allSubsData = [...allSubsData, ...r.data];
      const subs = { data: [...new Map(allSubsData.map(s => [s.id, s])).values()] };
      if (subs.data.length > 0) {
        const first = subs.data[0];
        const fi = first.items?.data?.[0];
        subscription = { id: first.id, status: first.status, currentPeriodStart: fi?.current_period_start || 0, currentPeriodEnd: fi?.current_period_end || 0, cancelAtPeriodEnd: first.cancel_at_period_end };
        const priceIds = subs.data.map((s) => s.items?.data?.[0]?.price?.id).filter(Boolean) as string[];
        const productIds = subs.data.map((s) => { const p = s.items?.data?.[0]?.price?.product; return typeof p === "string" ? p : p?.id; }).filter(Boolean) as string[];
        const matchingProducts = await prisma.gpuProduct.findMany({ where: { OR: [{ stripePriceId: { in: priceIds } }, { stripeProductId: { in: productIds } }], billingType: "monthly", active: true } });
        const byPriceId = new Map(matchingProducts.filter(p => p.stripePriceId).map(p => [p.stripePriceId!, p]));
        const byProductId = new Map(matchingProducts.filter(p => p.stripeProductId).map(p => [p.stripeProductId!, p]));
        subscriptions = subs.data.map((s) => {
          const item = s.items?.data?.[0];
          const pId = item?.price?.id || null;
          const prodRef = typeof item?.price?.product === "string" ? item.price.product : item?.price?.product?.id || null;
          const prod = (pId ? byPriceId.get(pId) : undefined) ?? (prodRef ? byProductId.get(prodRef) : undefined);
          return { id: s.id, status: s.status, currentPeriodStart: item?.current_period_start || 0, currentPeriodEnd: item?.current_period_end || 0, cancelAtPeriodEnd: s.cancel_at_period_end, productId: prod?.id || null, productName: prod?.name || null, poolIds: prod ? (() => { try { return JSON.parse(prod.poolIds); } catch { return []; } })() : [], pricePerMonthCents: prod?.pricePerMonthCents ?? null, stripePriceId: pId, quantity: item?.quantity ?? 1 };
        });
      }

      // Payments
      const invoicePdfMap = new Map(invoices.data.filter(i => i.metadata?.type === "wallet_payment" && i.metadata?.payment_intent_id && i.invoice_pdf).map(i => [i.metadata!.payment_intent_id!, i.invoice_pdf!]));
      recentPayments = payments.data.filter(p => p.status === "succeeded").map(p => ({ id: p.id, amount: p.amount, amountFormatted: formatCents(p.amount), created: p.created, description: p.description || "Payment", invoicePdf: invoicePdfMap.get(p.id) || null }));

      // Billing portal
      try {
        const portalSession = await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard` });
        billingPortalUrl = portalSession.url;
      } catch { /* no-op */ }
    } else {
      const cachedBal = await prisma.customerCache.findUnique({ where: { id: customer.id }, select: { balanceCents: true } });
      const rawBalance = cachedBal?.balanceCents || 0;
      const displayBalance = Math.max(0, -rawBalance); // Flip: positive = credit
      wallet = { balance: displayBalance, balanceFormatted: formatCentsForUser(displayBalance), currency: "usd" };
    }

    // ── Parallel fetch: OTL + 2FA ──
    const verifyRoles = await ensureRoles();
    const customerEmailForOtl = typeof customer.email === "string" ? customer.email : null;
    const otlIsOwner = payload.email.toLowerCase() === customer.email?.toLowerCase();
    const otlMembership = await resolveMembership({ userId: payload.userId, email: payload.email, accountId: customer.id, customerEmail: customerEmailForOtl }).catch(() => null);
    const otlPacketRole: PacketRole | null = otlMembership && isPacketRole(otlMembership.role) ? otlMembership.role : null;
    const otlMembershipIsOwner = otlMembership?.isOwner ?? false;
    const otlHaiSlug = otlPacketRole ? getHaiRoleForPacketRole(otlPacketRole, otlMembershipIsOwner) : otlIsOwner ? "teamAdmin" : "readOnlyMember";
    const otlRoleId = verifyRoles[otlHaiSlug];

    const tosVersionPromise = getSetting("TOS_VERSION").then(async (ver) => {
      if (!ver) return { version: null, accepted: true };
      const acceptance = await prisma.tosAcceptance.findFirst({ where: { stripeCustomerId: customer.id, tosVersion: ver }, select: { id: true } });
      return { version: ver, accepted: !!acceptance };
    }).catch(() => ({ version: "unknown", accepted: false }));

    const [otlResult, twoFactorStatus, tosResult] = await Promise.all([
      teamId
        ? createOneTimeLogin({ email: payload.email, send_email_invite: false, teamId, roleId: otlRoleId }).catch(() => null)
        : Promise.resolve(null),
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
    // Mint a session unless one already EXISTS AND IS LIVE. A stale/dead cookie
    // (revoked, expired, or left over from a deleted customer) must not block
    // creation — otherwise the next refresh validates the dead cookie, 401s,
    // and the user is bounced to "request a new link".
    const existingSession = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const hasValidSession = existingSession ? await hasLiveSession(existingSession) : false;
    let sessionRefreshToken: string | null = null;
    if (
      !isEphemeralToken(payload) &&
      twoFactorSatisfied &&
      !hasValidSession
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
      billingPortalUrl: canMap["billing.view"] ? billingPortalUrl : null,
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
