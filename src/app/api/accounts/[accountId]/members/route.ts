// GET /accounts/:accountId/members — list all members on this account.
//
// Authorization: any active member (default-read). Returns role, is_owner,
// status, accepted_at, revoked_at for each row plus user.email + displayName.
//
// PA-201/PA-202 reconciliation:
//   - is_owner is surfaced as a separate boolean field (not a role).
//   - UI displays "Team Admin" for every role='teamAdmin' row regardless of
//     is_owner; the flag controls UI affordances (hide Remove on Owner row).
//   - Role labels come from ROLE_PERMISSIONS[role].displayName.

import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { prisma } from "@/lib/prisma";
import { ROLE_PERMISSIONS, PACKET_ROLES, type PacketRole } from "@/lib/auth/role-permissions";

function isPacketRole(role: string): role is PacketRole {
  return (PACKET_ROLES as readonly string[]).includes(role);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const auth = await getAuthenticatedCustomer(request);
  if (auth instanceof NextResponse) return auth;

  const { accountId } = await params;

  // Cross-account guard: the URL accountId must match the authenticated
  // account context. Otherwise an attacker with one team's JWT could probe
  // another team's membership.
  if (accountId !== auth.accountId) {
    return NextResponse.json(
      { error: "You do not have access to this account." },
      { status: 403 },
    );
  }

  const memberships = await prisma.teamMembership.findMany({
    where: { stripeCustomerId: accountId },
    include: {
      user: {
        select: { id: true, email: true, displayName: true },
      },
    },
    orderBy: [
      { isOwner: "desc" }, // Owner first
      { acceptedAt: "asc" },
    ],
  });

  const members = memberships.map((m) => {
    const role = isPacketRole(m.role) ? m.role : null;
    const displayName = role ? ROLE_PERMISSIONS[role].displayName : m.role;
    return {
      id: m.id,
      userId: m.userId,
      email: m.user.email,
      displayName: m.user.displayName,
      role: m.role,
      roleDisplayName: displayName,
      isOwner: m.isOwner,
      status: m.status,
      invitedAt: m.invitedAt.toISOString(),
      acceptedAt: m.acceptedAt?.toISOString() ?? null,
      revokedAt: m.revokedAt?.toISOString() ?? null,
    };
  });

  return NextResponse.json({ members });
}
