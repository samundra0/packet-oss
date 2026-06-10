// Resolves a (user, account) pair to a TeamMembership row, used by
// getAuthenticatedCustomer() to bind a per-request can() function.
//
// Lookup paths:
//   - new JWT  → resolveByUserId(user_id, account_id)
//   - legacy   → resolveByEmail(email, account_id) via User.email
//   - implicit → no row exists but email matches the Stripe customer's email
//                → treat as Owner+Admin (covers fresh signups that haven't
//                  written a membership yet; the backfill row is identical).
//
// Revoked memberships return revoked=true so the caller can 403 early.
// Missing memberships where email does NOT match → null (deny on can()).

import { prisma } from "@/lib/prisma";
import type { PacketRole } from "./role-permissions";
import { PACKET_ROLES } from "./role-permissions";

export interface ResolvedMembership {
  membershipId: string | null; // null when implicit (no row written yet)
  userId: string | null;       // null when implicit and User row not yet written
  accountId: string;           // stripe_customer_id
  role: PacketRole;
  isOwner: boolean;
  revokedAt: Date | null;
  // True when the row was synthesized from email-match rather than read from DB.
  // PR 3's invite-accept flow always writes a real row, so this should approach
  // zero over time. Useful for telemetry / monitoring during rollout.
  isImplicit: boolean;
}

function coerceRole(role: string | null | undefined): PacketRole {
  if (role && (PACKET_ROLES as readonly string[]).includes(role)) {
    return role as PacketRole;
  }
  // Fail-safe: unknown role in DB → treat as least-privileged member.
  // Logged loudly so we notice if a schema/data drift happens.
  if (role) {
    console.error(`[auth/membership] Unknown role in DB: '${role}', coercing to 'member'`);
  }
  return "member";
}

// Look up the active membership for a (user_id, account_id) pair.
// Returns null if no row exists for this user on this account at all.
// Returns the row (with revokedAt populated) when revoked — caller decides 403.
async function findByUserId(
  userId: string,
  accountId: string,
): Promise<ResolvedMembership | null> {
  const row = await prisma.teamMembership.findUnique({
    where: {
      userId_stripeCustomerId: { userId, stripeCustomerId: accountId },
    },
    select: {
      id: true,
      userId: true,
      role: true,
      isOwner: true,
      revokedAt: true,
    },
  });

  if (!row) return null;

  return {
    membershipId: row.id,
    userId: row.userId,
    accountId,
    role: coerceRole(row.role),
    isOwner: row.isOwner,
    revokedAt: row.revokedAt,
    isImplicit: false,
  };
}

// Look up the membership by email (used for legacy JWTs that don't carry user_id).
// Resolves the User row by email first, then defers to findByUserId().
async function findByEmail(
  email: string,
  accountId: string,
): Promise<ResolvedMembership | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true },
  });
  if (!user) return null;
  return findByUserId(user.id, accountId);
}

// Synthesize an Owner+Admin context for accounts where the JWT email matches
// the Stripe customer's email but no User/TeamMembership row exists yet.
// This mirrors the backfill rule: stripe_customer.email-matched member = Owner.
//
// We don't write the row in the hot path — let the next signup/invite flow
// create it lazily. PR 3 will add an explicit ensureOwnerMembership() at
// signup time.
function implicitOwner(accountId: string): ResolvedMembership {
  return {
    membershipId: null,
    userId: null,
    accountId,
    role: "teamAdmin",
    isOwner: true,
    revokedAt: null,
    isImplicit: true,
  };
}

export interface ResolveMembershipParams {
  // Provided when JWT has new-format claims; preferred path.
  userId?: string;
  // Always available from token (email lookup fallback).
  email: string;
  accountId: string;
  // Email on the Stripe customer record (used for implicit-owner fallback).
  // Pass null/undefined if not loaded; implicit fallback will not fire.
  customerEmail?: string | null;
}

export async function resolveMembership(
  params: ResolveMembershipParams,
): Promise<ResolvedMembership | null> {
  const { userId, email, accountId, customerEmail } = params;

  const row = userId
    ? await findByUserId(userId, accountId)
    : await findByEmail(email, accountId);

  if (row) return row;

  // No row found. If the JWT email matches the Stripe customer's email, treat
  // as implicit Owner. Covers post-PR-1-deploy edge cases (fresh signup before
  // PR 3's invite-accept flow exists, or backfill that missed a row).
  if (
    customerEmail &&
    customerEmail.toLowerCase() === email.toLowerCase()
  ) {
    return implicitOwner(accountId);
  }

  return null;
}

// Lazily writes a User + TeamMembership row for an implicit-Owner context.
// Returns the real userId. Idempotent: re-running yields the same row.
//
// Call this from write paths that need a non-null userId (e.g., POST
// invitations where invitedByUserId is required). Read paths can continue
// to use the synthesized implicit-owner context without writing.
export async function materializeImplicitOwner(params: {
  email: string;
  accountId: string;
  displayName?: string | null;
}): Promise<{ userId: string; membershipId: string }> {
  const lower = params.email.toLowerCase();

  const user = await prisma.user.upsert({
    where: { email: lower },
    create: {
      email: lower,
      displayName: params.displayName ?? undefined,
    },
    update: {},
  });

  const membership = await prisma.teamMembership.upsert({
    where: {
      userId_stripeCustomerId: {
        userId: user.id,
        stripeCustomerId: params.accountId,
      },
    },
    create: {
      userId: user.id,
      stripeCustomerId: params.accountId,
      role: "teamAdmin",
      isOwner: true,
      acceptedAt: new Date(),
      status: "active",
    },
    update: {},
  });

  return { userId: user.id, membershipId: membership.id };
}
