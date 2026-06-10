// DELETE /accounts/:accountId/invitations/:id — revoke a pending invite.
//
// Path uses invitation ID (cuid), NOT token. The token is the user-facing
// acceptance secret and shouldn't appear in admin URLs / activity logs.
// Admins look up invitations by ID from the GET listing.
//
// Authorization: team.invite (teamAdmin only per PA-201 matrix).

import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { requirePermission } from "@/lib/auth/audit";
import { prisma } from "@/lib/prisma";

interface RouteContext {
  params: Promise<{ accountId: string; id: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const auth = await getAuthenticatedCustomer(request);
  if (auth instanceof NextResponse) return auth;

  const { accountId, id } = await params;
  if (accountId !== auth.accountId) {
    return NextResponse.json(
      { error: "You do not have access to this account." },
      { status: 403 },
    );
  }

  const denial = requirePermission(auth, "team.invite", request);
  if (denial) return denial;

  const invitation = await prisma.teamInvitation.findUnique({ where: { id } });

  if (!invitation || invitation.stripeCustomerId !== accountId) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }

  if (invitation.status !== "pending") {
    return NextResponse.json(
      { error: `Invitation is already ${invitation.status}` },
      { status: 400 },
    );
  }

  await prisma.teamInvitation.update({
    where: { id: invitation.id },
    data: { status: "revoked" },
  });

  // No HAI cleanup needed: invitations are not synced to HAI until accept-
  // time (HAI's /team/{id}/invite would email the invitee a competing
  // login link and leave us no way to flip status to active without their
  // interaction). The HAI side stays clean by virtue of never having been
  // touched for this token.

  await prisma.teamAuditLog
    .create({
      data: {
        stripeCustomerId: accountId,
        actorUserId: auth.membership.userId,
        subjectUserId: null,
        action: "invite.revoked",
        payload: JSON.stringify({ email: invitation.email, role: invitation.role }),
      },
    })
    .catch((err) => console.error("[DELETE invitations] audit log failed:", err));

  return NextResponse.json({ success: true });
}
