// POST /invitations/:token/accept — accept a pending invitation (Bearer-auth path).
//
// This route is the LEGACY path. The actual end-user flow goes through the
// /invite/[token] Server Component which does not require a pre-existing
// Bearer JWT. This route remains for already-authenticated callers (e.g.,
// API consumers, tests) that want to accept an invite while holding their
// own customer JWT.
//
// Authentication: customer JWT required. The acceptor's email MUST match
// the invitation's email (case-insensitive). The new flow proves identity
// via the random invite token instead — see acceptInvitation().

import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { prisma } from "@/lib/prisma";
import { acceptInvitation } from "@/lib/auth/accept-invitation";

interface RouteContext {
  params: Promise<{ token: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authHeader = request.headers.get("authorization");
  const tokenJwt = authHeader?.replace("Bearer ", "");
  if (!tokenJwt) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const payload = verifyCustomerToken(tokenJwt);
  if (!payload) {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 401 },
    );
  }

  const { token } = await params;

  // Email-match precheck: keeps the legacy guarantee that an
  // already-authenticated user can't accept someone else's invite using
  // their own JWT. The Server-Component path doesn't need this because the
  // invite token itself is the identity proof.
  const invitation = await prisma.teamInvitation.findUnique({
    where: { token },
    select: { email: true },
  });
  if (invitation && payload.email.toLowerCase() !== invitation.email.toLowerCase()) {
    return NextResponse.json(
      { error: "This invitation was not issued to you." },
      { status: 403 },
    );
  }

  const result = await acceptInvitation(token);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    success: true,
    accountId: result.accountId,
    role: result.role,
  });
}
