// Server-only helper for resolving a Packet (role, isOwner) pair to the
// HAI role UUID. Kept separate from @/lib/auth/role-permissions so that file
// stays client-safe — TeamMembers.tsx and other Client Components import
// from role-permissions for the pure data model (PACKET_ROLES, can(), etc.)
// without dragging settings/secrets/fs into the browser bundle.

import { ensureRoles } from "@/lib/hostedai/default-roles";
import {
  getHaiRoleForPacketRole,
  type PacketRole,
} from "@/lib/auth/role-permissions";

// Async resolver that returns the actual HAI role UUID (not the slug).
// MUST be used on HAI write paths instead of the synchronous ROLES Proxy —
// the Proxy falls back to staging UUIDs on cold cache, which would silently
// mis-assign roles in prod.
//
// Used by: invite accept (createOneTimeLogin), role change (HAI change-role).
export async function getHaiRoleIdForPacketRole(
  role: PacketRole,
  isOwner: boolean,
): Promise<string> {
  const haiRoles = await ensureRoles();
  const slug = getHaiRoleForPacketRole(role, isOwner);
  return haiRoles[slug];
}
