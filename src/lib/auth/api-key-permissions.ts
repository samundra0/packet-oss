// PA-175 PR 2.5: API key effective-permissions precompute.
//
// The Token Factory hot-path (`/api/v1/*`) authenticates via API keys, not
// customer JWTs. To stay fast under load, the key's permission set is
// precomputed into `api_key.effective_permissions` (TEXT, JSON array of
// Permission strings) and read with a single column scan. No joins to
// team_membership, no role lookup per request.
//
// Recompute triggers (called from PR 3's PATCH/DELETE member routes):
//   - Member's role changes  → recompute all of their keys.
//   - Member is removed      → revoke all of their keys (revokedAt set).
//
// AC #3 of PA-175: updates take effect within 5 seconds of the role change.
// Implementation today is synchronous (writes happen in the PATCH route's
// own transaction). A queue-backed background recompute is a polish item
// if the hot-path latency becomes an issue.

import { prisma } from "@/lib/prisma";
import {
  can,
  PACKET_ROLES,
  PERMISSIONS,
  type PacketRole,
  type Permission,
} from "./role-permissions";

function isPacketRole(role: string | null | undefined): role is PacketRole {
  return !!role && (PACKET_ROLES as readonly string[]).includes(role);
}

// Resolve which permissions an API key should currently grant, given the
// holder's (role, isOwner). Returns the JSON-encoded array suitable for
// writing to api_key.effective_permissions.
export function computeEffectivePermissions(
  role: PacketRole | null,
  isOwner: boolean,
): string {
  const granted: Permission[] = PERMISSIONS.filter((perm) =>
    can(role, isOwner, perm),
  );
  return JSON.stringify(granted);
}

// Read a key's stored effective permissions back into a Set. Used by hot-path
// callers that just want to check "does this key have permission X?".
export function parseEffectivePermissions(stored: string | null): Set<Permission> {
  if (!stored) return new Set();
  try {
    const arr = JSON.parse(stored);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((p): p is Permission => typeof p === "string"));
  } catch {
    return new Set();
  }
}

// Recompute every NOT-revoked API key for a specific (userId, accountId)
// pair. Called when that membership's role changes. Returns the number of
// keys updated.
export async function recomputeApiKeyPermissions(params: {
  userId: string;
  accountId: string;
}): Promise<number> {
  const { userId, accountId } = params;

  // Read the current membership to derive the new permission set.
  const membership = await prisma.teamMembership.findUnique({
    where: {
      userId_stripeCustomerId: { userId, stripeCustomerId: accountId },
    },
  });

  if (!membership) {
    // Membership gone; no keys to recompute (DELETE flow handles revocation
    // separately).
    return 0;
  }

  const role: PacketRole | null = isPacketRole(membership.role)
    ? membership.role
    : null;
  const permissionsJson = computeEffectivePermissions(role, membership.isOwner);

  const result = await prisma.apiKey.updateMany({
    where: {
      holderUserId: userId,
      stripeCustomerId: accountId,
      revokedAt: null,
    },
    data: { effectivePermissions: permissionsJson },
  });

  return result.count;
}

// Revoke every API key issued by a specific (userId, accountId) pair.
// Called when the member is removed. Idempotent — re-running yields 0 updates.
export async function revokeApiKeysForRemovedMember(params: {
  userId: string;
  accountId: string;
}): Promise<number> {
  const { userId, accountId } = params;
  const result = await prisma.apiKey.updateMany({
    where: {
      holderUserId: userId,
      stripeCustomerId: accountId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}
