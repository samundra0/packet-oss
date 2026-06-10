// GET /invitations/:token — read-only lookup of an invitation by its
// 32-byte random token. No Bearer JWT required (anyone holding the token
// can see what it grants).
//
// Used by the dashboard accept modal to show the user what they're about
// to accept. Acceptance itself happens via POST /api/invitations/:token/accept
// which DOES require a Bearer JWT matching invitation.email.

import { NextRequest, NextResponse } from "next/server";
import { lookupInvitation } from "@/lib/auth/accept-invitation";

interface RouteContext {
  params: Promise<{ token: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { token } = await params;
  const result = await lookupInvitation(token);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    email: result.email,
    role: result.role,
    roleDisplayName: result.roleDisplayName,
    accountId: result.accountId,
    accountLabel: result.accountLabel,
    invitedByEmail: result.invitedByEmail,
    expiresAt: result.expiresAt,
    alreadyAccepted: result.alreadyAccepted,
  });
}
