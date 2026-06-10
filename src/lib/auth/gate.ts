// Lightweight permission gate for routes that don't (yet) use
// getAuthenticatedCustomer. Loads the membership row for the JWT payload,
// applies the same revoked / no-membership / can() checks the helper does,
// and returns either a 403 NextResponse or null on allow.
//
// Routes built on getAuthenticatedCustomer should use requirePermission()
// from ./audit instead — that path reuses the already-loaded membership.

import { NextResponse } from "next/server";
import { resolveMembership } from "./membership";
import { can as canPure, type Permission } from "./role-permissions";
import { recordPermissionDecision } from "./audit";
import type { CustomerTokenPayload } from "./customer";

export interface GatePermissionParams {
  payload: CustomerTokenPayload;
  /** stripe_customer_id of the account this request is acting on. */
  accountId: string;
  /** Email on the Stripe customer record. Pass null if not loaded. */
  customerEmail: string | null | undefined;
  permission: Permission;
  request?: Request;
  /** Extra context for the audit payload (request body summary, etc.). */
  extra?: Record<string, unknown>;
}

export async function gatePermission(
  params: GatePermissionParams,
): Promise<NextResponse | null> {
  const { payload, accountId, customerEmail, permission, request, extra } =
    params;

  const membership = await resolveMembership({
    userId: payload.userId,
    email: payload.email,
    accountId,
    customerEmail,
  });

  const route = request?.url ? new URL(request.url).pathname : undefined;

  if (!membership) {
    console.warn(
      `[auth/gate] No membership for ${payload.email} on account ${accountId}`,
    );
    recordPermissionDecision({
      accountId,
      actorUserId: null,
      permission,
      allowed: false,
      route,
      payload: { reason: "no_membership", ...extra },
    });
    return NextResponse.json(
      { error: "You do not have access to this account." },
      { status: 403 },
    );
  }

  if (membership.revokedAt) {
    console.warn(
      `[auth/gate] Revoked membership for ${payload.email} on account ${accountId}`,
    );
    recordPermissionDecision({
      accountId,
      actorUserId: membership.userId,
      permission,
      allowed: false,
      route,
      payload: { reason: "revoked", ...extra },
    });
    return NextResponse.json(
      { error: "Your access to this account has been revoked." },
      { status: 403 },
    );
  }

  const allowed = canPure(membership.role, membership.isOwner, permission);
  recordPermissionDecision({
    accountId,
    actorUserId: membership.userId,
    permission,
    allowed,
    route,
    payload: extra,
  });

  if (!allowed) {
    return NextResponse.json(
      {
        error: "You do not have permission to perform this action.",
        permission,
        role: membership.role,
        isOwner: membership.isOwner,
      },
      { status: 403 },
    );
  }

  return null;
}
