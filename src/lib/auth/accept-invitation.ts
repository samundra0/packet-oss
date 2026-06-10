// Shared accept-invitation logic. Used by both:
//   1. POST /api/invitations/[token]/accept (legacy Bearer-auth path)
//   2. /invite/[token] Server Component (no-Bearer, token-as-identity path)
//
// The 32-byte random invitation token IS the proof-of-identity. We do NOT
// require a separate Bearer JWT — possession of the token (delivered only
// to the invitation's email) is sufficient. Mirrors how Stripe's hosted
// checkout links work.
//
// Sequencing follows the same rules as the original POST route:
//   1. Validate invitation (exists, pending, not expired, role is recognised).
//   2. HAI-FIRST: createOneTimeLogin with the derived HAI role. Use ensureRoles()
//      to avoid stale staging UUIDs from the ROLES Proxy.
//   3. Packet INSERT: upsert User + TeamMembership.
//   4. If Packet INSERT fails after HAI succeeded: compensating delete via
//      removeUserFromTeam (stubbed today).
//   5. Mark invitation accepted + write audit log.

import { prisma } from "@/lib/prisma";
import {
  PACKET_ROLES,
  getHaiRoleForPacketRole,
  type PacketRole,
} from "@/lib/auth/role-permissions";
import { ensureRoles } from "@/lib/hostedai/default-roles";
import {
  inviteToTeam,
  setMemberStatus,
  removeUserFromTeam,
} from "@/lib/hostedai";
import { getStripe } from "@/lib/stripe";
import type Stripe from "stripe";

function isPacketRole(role: string): role is PacketRole {
  return (PACKET_ROLES as readonly string[]).includes(role);
}

export type InvitationLookupResult =
  | {
      ok: true;
      email: string;
      role: PacketRole;
      roleDisplayName: string;
      accountId: string;
      accountLabel: string; // team name if set, else owner email, else account id (legacy/fallback)
      teamName: string | null; // null when the owner hasn't set a team name yet
      invitedByEmail: string | null;
      inviteeName: string | null;
      expiresAt: string; // ISO
      alreadyAccepted: boolean;
    }
  | { ok: false; status: 400 | 404 | 410; error: string };

// Read-only lookup. Used by the /invite/[token] confirmation page to show
// the invitee what they're about to accept BEFORE any side effects fire.
export async function lookupInvitation(
  inviteToken: string,
): Promise<InvitationLookupResult> {
  const { ROLE_PERMISSIONS } = await import("@/lib/auth/role-permissions");

  const invitation = await prisma.teamInvitation.findUnique({
    where: { token: inviteToken },
  });
  if (!invitation) {
    return { ok: false, status: 404, error: "Invitation not found." };
  }
  if (!isPacketRole(invitation.role)) {
    return {
      ok: false,
      status: 400,
      error: "This invitation has an invalid role.",
    };
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    return { ok: false, status: 400, error: "This invitation has expired." };
  }
  if (
    invitation.status === "revoked" ||
    invitation.status === "expired"
  ) {
    return {
      ok: false,
      status: 400,
      error: `This invitation is ${invitation.status}.`,
    };
  }

  // Resolve team label: team_name → customer.email → accountId.
  let accountLabel = invitation.stripeCustomerId;
  let teamName: string | null = null;
  let inviterEmail: string | null = null;
  try {
    const settings = await prisma.customerSettings.findUnique({
      where: { stripeCustomerId: invitation.stripeCustomerId },
      select: { teamName: true },
    });
    if (settings?.teamName) {
      teamName = settings.teamName;
      accountLabel = settings.teamName;
    } else {
      const stripe = await getStripe();
      const c = (await stripe.customers.retrieve(
        invitation.stripeCustomerId,
      )) as Stripe.Customer;
      if (!c.deleted && typeof c.email === "string") {
        accountLabel = c.email;
      }
    }
    const inviter = await prisma.user.findUnique({
      where: { id: invitation.invitedByUserId },
      select: { email: true },
    });
    inviterEmail = inviter?.email ?? null;
  } catch {
    // Best-effort labelling — never block lookup on enrichment failures.
  }

  return {
    ok: true,
    email: invitation.email,
    role: invitation.role,
    roleDisplayName: ROLE_PERMISSIONS[invitation.role].displayName,
    accountId: invitation.stripeCustomerId,
    accountLabel,
    teamName,
    invitedByEmail: inviterEmail,
    inviteeName: invitation.inviteeName,
    expiresAt: invitation.expiresAt.toISOString(),
    alreadyAccepted: invitation.status === "accepted",
  };
}

export type AcceptInvitationResult =
  | {
      ok: true;
      email: string;
      accountId: string;
      role: PacketRole;
      userId: string;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 410 | 500 | 503;
      error: string;
    };

export async function acceptInvitation(
  inviteToken: string,
): Promise<AcceptInvitationResult> {
  const invitation = await prisma.teamInvitation.findUnique({
    where: { token: inviteToken },
  });
  if (!invitation) {
    return { ok: false, status: 404, error: "Invitation not found" };
  }
  if (invitation.status !== "pending") {
    return {
      ok: false,
      status: 400,
      error: `This invitation is ${invitation.status}.`,
    };
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    await prisma.teamInvitation.update({
      where: { id: invitation.id },
      data: { status: "expired" },
    });
    return { ok: false, status: 400, error: "This invitation has expired." };
  }
  if (!isPacketRole(invitation.role)) {
    return {
      ok: false,
      status: 400,
      error: "This invitation has an invalid role and cannot be accepted.",
    };
  }

  // Look up the account's HAI team. Without it we can't bind the HAI side.
  const stripe = await getStripe();
  const customer = (await stripe.customers.retrieve(
    invitation.stripeCustomerId,
  )) as Stripe.Customer;
  if (customer.deleted) {
    return {
      ok: false,
      status: 410,
      error: "The account this invitation belongs to no longer exists.",
    };
  }
  const teamId = customer.metadata?.hostedai_team_id;
  if (!teamId) {
    return {
      ok: false,
      status: 500,
      error: "This account is not connected to a Team service.",
    };
  }

  // HAI-FIRST: createOneTimeLogin with the derived HAI role.
  const haiSlug = getHaiRoleForPacketRole(invitation.role, false);
  let haiRoleId: string;
  try {
    const roles = await ensureRoles();
    haiRoleId = roles[haiSlug];
  } catch (err) {
    console.error("[accept-invitation] ensureRoles failed:", err);
    return {
      ok: false,
      status: 503,
      error: "Team service is temporarily unavailable. Please try again.",
    };
  }

  // HAI-FIRST: /team/{id}/invite is the canonical primitive — it lands
  // the user with the chosen role correctly (status=invited). /create-otl
  // always sets role=team_admin regardless of role_id and we couldn't get
  // a follow-up role-change to stick (HAI appears to overwrite it
  // asynchronously). /invite has no such race.
  let haiCallSucceeded = false;
  try {
    await inviteToTeam({
      teamId,
      email: invitation.email,
      roleId: haiRoleId,
    });
    haiCallSucceeded = true;
    console.log(
      `[accept-invitation] HAI inviteToTeam ok: email=${invitation.email} role=${invitation.role}(${haiRoleId})`,
    );
  } catch (err) {
    console.error("[accept-invitation] HAI inviteToTeam failed:", err);
    return {
      ok: false,
      status: 503,
      error: "Team service is temporarily unavailable. Please try again.",
    };
  }

  // Flip status invited → active via the same /status endpoint that handles
  // "removed" (symmetric, used by HAI's own panel). Best-effort: if HAI
  // doesn't accept "active" as a target there, the user stays at status
  // 'invited' but has the correct role and team membership, which is
  // sufficient for Packet's purposes (we don't need them to log into HAI
  // directly).
  try {
    await setMemberStatus({
      teamId,
      email: invitation.email,
      status: "active",
    });
    console.log(
      `[accept-invitation] HAI status set active: email=${invitation.email}`,
    );
  } catch (err) {
    console.warn(
      `[accept-invitation] HAI status flip to active failed (non-fatal — role is correct, status stays 'invited'):`,
      err,
    );
  }

  // PACKET INSERT: User + TeamMembership.
  try {
    const lower = invitation.email.toLowerCase();
    // displayName only set on first creation (don't overwrite if user
    // already had one from a different invitation or signup flow).
    const user = await prisma.user.upsert({
      where: { email: lower },
      create: {
        email: lower,
        ...(invitation.inviteeName
          ? { displayName: invitation.inviteeName }
          : {}),
      },
      update: {},
    });

    await prisma.teamMembership.upsert({
      where: {
        userId_stripeCustomerId: {
          userId: user.id,
          stripeCustomerId: invitation.stripeCustomerId,
        },
      },
      create: {
        userId: user.id,
        stripeCustomerId: invitation.stripeCustomerId,
        role: invitation.role,
        isOwner: false,
        invitedByUserId: invitation.invitedByUserId,
        invitedAt: invitation.createdAt,
        acceptedAt: new Date(),
        status: "active",
      },
      update: {
        // Re-accepting an invitation un-revokes the row + applies the new role.
        role: invitation.role,
        revokedAt: null,
        status: "active",
        acceptedAt: new Date(),
      },
    });

    await prisma.teamInvitation.update({
      where: { id: invitation.id },
      data: { status: "accepted", acceptedAt: new Date() },
    });

    await prisma.teamAuditLog
      .create({
        data: {
          stripeCustomerId: invitation.stripeCustomerId,
          actorUserId: user.id,
          subjectUserId: user.id,
          action: "invite.accepted",
          payload: JSON.stringify({
            email: invitation.email,
            role: invitation.role,
            inviterUserId: invitation.invitedByUserId,
          }),
        },
      })
      .catch((err) =>
        console.error("[accept-invitation] audit log failed:", err),
      );

    return {
      ok: true,
      email: invitation.email,
      accountId: invitation.stripeCustomerId,
      role: invitation.role as PacketRole,
      userId: user.id,
    };
  } catch (err) {
    console.error(
      "[accept-invitation] Packet INSERT failed after HAI success:",
      err,
    );

    // Compensating delete on HAI. STUBBED today; logs intent.
    if (haiCallSucceeded) {
      try {
        await removeUserFromTeam({ teamId, email: invitation.email });
      } catch (rollbackErr) {
        console.error(
          "[accept-invitation] HAI compensating delete also failed — manual cleanup needed:",
          rollbackErr,
          {
            email: invitation.email,
            teamId,
            invitationId: invitation.id,
          },
        );
      }
    }

    return {
      ok: false,
      status: 500,
      error: "Failed to accept invitation. Please try again.",
    };
  }
}
