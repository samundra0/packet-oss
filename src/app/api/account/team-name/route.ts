// PATCH /account/team-name — update the team display name for the current
// active account. Gated on team.manage permission (Team Admin / Owner).
//
// Stored on customer_settings.team_name. NULL clears the override so the
// switcher / UI falls back to the Stripe customer email.

import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { requirePermission } from "@/lib/auth/audit";
import { prisma } from "@/lib/prisma";

const MAX_TEAM_NAME_LEN = 80;

export async function PATCH(request: NextRequest) {
  const auth = await getAuthenticatedCustomer(request);
  if (auth instanceof NextResponse) return auth;

  const denial = requirePermission(auth, "team.manage", request);
  if (denial) return denial;

  const body = (await request.json().catch(() => ({}))) as {
    teamName?: string | null;
  };
  let teamName: string | null;
  if (body.teamName === null || body.teamName === undefined || body.teamName === "") {
    teamName = null;
  } else if (typeof body.teamName !== "string") {
    return NextResponse.json({ error: "teamName must be a string" }, { status: 400 });
  } else {
    teamName = body.teamName.trim().slice(0, MAX_TEAM_NAME_LEN);
    if (teamName.length === 0) teamName = null;
  }

  await prisma.customerSettings.upsert({
    where: { stripeCustomerId: auth.accountId },
    create: { stripeCustomerId: auth.accountId, teamName },
    update: { teamName },
  });

  await prisma.teamAuditLog
    .create({
      data: {
        stripeCustomerId: auth.accountId,
        actorUserId: auth.membership.userId,
        subjectUserId: null,
        action: "team.renamed",
        payload: JSON.stringify({ teamName }),
      },
    })
    .catch((err) => console.error("[team-name PATCH] audit log failed:", err));

  return NextResponse.json({ teamName });
}
