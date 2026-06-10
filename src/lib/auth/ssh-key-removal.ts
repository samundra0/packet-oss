// PA-175 PR 2.5: per-user SSH key removal on member-removal.
//
// When a member is removed from a team (PR 3 DELETE member route), we need
// to revoke their pod access "in ≤60s". For account-level credentials (API
// keys, JWT) the membership row is the epoch — once revokedAt is set, the
// next request 403s.
//
// SSH is the exception: their public key is sitting on the team's running
// pods under ~/.ssh/authorized_keys. They can keep using cached SSH sessions
// + reconnect via stored credentials until we physically remove their key
// from each pod.
//
// This module exposes the function that does the removal. It's called
// from PR 3's DELETE member route. The actual SSH execution + pod
// enumeration is deferred to ssh-keys.ts (already exists) — this layer
// only handles the "find all team pods, remove this user's key from each."
//
// Stub today: enumerates the user's keys + the team's pods and logs the
// intent. Real implementation requires SSH access to each running pod
// (already wired in src/lib/ssh-keys.ts via injectServerKeyIntoPod). The
// inverse operation (remove instead of inject) is a small follow-up:
// open SSH, edit authorized_keys, close. Filed separately because it
// touches the SSH execution code path which is already complex.

import { prisma } from "@/lib/prisma";

interface RemovalResult {
  keysRemoved: number;
  podsTouched: number;
  errors: string[];
  /** True when this is still a stub — the SSH execution is deferred to a follow-up. */
  stubbed: boolean;
}

// Removes every SSHKey row that belongs to (userId, accountId) AND queues
// the per-pod removal job (currently logged, not executed — see module
// docstring).
//
// Idempotent: re-running with the same args removes zero rows the second
// time + queues zero pod jobs.
export async function removeMemberSshKeys(params: {
  userId: string;
  accountId: string;
}): Promise<RemovalResult> {
  const { userId, accountId } = params;
  const errors: string[] = [];

  // Find every SSHKey row that's attributed to this user on this account.
  // We DON'T delete keys with userId=null (legacy / account-shared keys).
  const userKeys = await prisma.sSHKey.findMany({
    where: { userId, stripeCustomerId: accountId },
  });

  if (userKeys.length === 0) {
    return { keysRemoved: 0, podsTouched: 0, errors, stubbed: true };
  }

  // Enumerate the team's running pods so we can log which ones the per-pod
  // removal job would target. The actual SSH execution is deferred.
  const pods = await prisma.podMetadata.findMany({
    where: { stripeCustomerId: accountId },
    select: { instanceId: true, subscriptionId: true, displayName: true },
  });

  // STUB: log the intent. Replace with real per-pod SSH removal in a
  // follow-up — see ssh-keys.ts:injectServerKeyIntoPod for the SSH execution
  // pattern. The remove path needs: open SSH using existing credentials,
  // remove the matching line from ~/.ssh/authorized_keys, close.
  console.warn(
    `[ssh-key-removal STUB] Would remove ${userKeys.length} key(s) for user ${userId} from ${pods.length} pod(s) on account ${accountId}.`,
    {
      keys: userKeys.map((k) => ({ id: k.id, fingerprint: k.fingerprint })),
      pods: pods.map((p) => ({ instanceId: p.instanceId, displayName: p.displayName })),
    },
  );

  // Delete the SSHKey rows in our DB. This stops the keys from being
  // re-injected on pod start/restart (injectServerKeyIntoPod reads from this
  // table), so even though the existing pods still have the key, no NEW pods
  // pick it up.
  await prisma.sSHKey.deleteMany({
    where: { id: { in: userKeys.map((k) => k.id) } },
  });

  return {
    keysRemoved: userKeys.length,
    podsTouched: pods.length,
    errors,
    stubbed: true,
  };
}
