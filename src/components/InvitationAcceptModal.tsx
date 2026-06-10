"use client";

// Modal shown in the dashboard when the URL carries ?invite=<token>.
// Renders the invitation context (inviter, team, role) and an explicit
// Accept button. On accept:
//   1. POST /api/invitations/<token>/accept with the user's Bearer JWT
//   2. POST /api/session/switch-account to mint a JWT scoped to the
//      invited team (user explicitly clicked the invite link, so we
//      land them where they wanted to go).
//   3. window.location.href = /dashboard?token=<newJWT> — strips invite=
//      from the URL automatically.
//
// On cancel: just strip ?invite= from the URL via history.replaceState.

import { useEffect, useState } from "react";

interface InvitationInfo {
  email: string;
  roleDisplayName: string;
  accountLabel: string;
  teamName: string | null;
  invitedByEmail: string | null;
  expiresAt: string;
  alreadyAccepted: boolean;
}

interface Props {
  token: string;
  jwt: string;
  userEmail: string;
}

export function InvitationAcceptModal({ token, jwt, userEmail }: Props) {
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [emailMismatch, setEmailMismatch] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/invitations/${token}`);
        const data = (await res.json()) as
          | (InvitationInfo & { ok?: true })
          | { error: string };
        if (cancelled) return;
        if (!res.ok || "error" in data) {
          setError(("error" in data && data.error) || "Failed to load invitation.");
          setLoading(false);
          return;
        }
        setInfo(data);
        setEmailMismatch(
          data.email.toLowerCase() !== userEmail.toLowerCase(),
        );
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError("Network error loading invitation.");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, userEmail]);

  function stripInviteFromUrl() {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    window.history.replaceState({}, "", url.toString());
  }

  async function handleAccept() {
    setSubmitting(true);
    setError(null);
    try {
      const acceptRes = await fetch(`/api/invitations/${token}/accept`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
      });
      const acceptData = (await acceptRes.json()) as {
        success?: true;
        accountId?: string;
        error?: string;
      };
      if (!acceptRes.ok || !acceptData.accountId) {
        setError(acceptData.error ?? "Failed to accept invitation.");
        setSubmitting(false);
        return;
      }

      // Switch into the invited team so the user lands where they expected.
      const switchRes = await fetch("/api/session/switch-account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ accountId: acceptData.accountId }),
      });
      const switchData = (await switchRes.json()) as { token?: string };
      if (switchRes.ok && switchData.token) {
        window.location.href = `/dashboard?token=${switchData.token}`;
        return;
      }

      // Switch failed — at least drop the modal and refresh in place.
      stripInviteFromUrl();
      window.location.reload();
    } catch {
      setError("Network error during accept. Please try again.");
      setSubmitting(false);
    }
  }

  function handleCancel() {
    stripInviteFromUrl();
    setInfo(null);
  }

  if (!info && !loading && !error) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 px-4">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-6">
        <h2 className="text-lg font-semibold text-zinc-900 mb-2">
          {emailMismatch ? "Invitation not for you" : "Accept invitation"}
        </h2>

        {loading && (
          <p className="text-sm text-zinc-500">Loading invitation…</p>
        )}

        {error && (
          <>
            <p className="text-sm text-red-700 mb-4">{error}</p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-2 bg-zinc-200 text-zinc-700 rounded-lg hover:bg-zinc-300 transition-colors text-sm"
              >
                Dismiss
              </button>
            </div>
          </>
        )}

        {info && !error && (
          <>
            {emailMismatch ? (
              <>
                <p className="text-sm text-zinc-700 mb-4">
                  This invitation was sent to <strong>{info.email}</strong>,
                  but you&apos;re signed in as <strong>{userEmail}</strong>.
                </p>
                <p className="text-sm text-zinc-700 mb-5">
                  Sign out, then click the invitation link from the original
                  email to accept it.
                </p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="px-4 py-2 bg-zinc-200 text-zinc-700 rounded-lg hover:bg-zinc-300 transition-colors text-sm"
                  >
                    Dismiss
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-zinc-700 mb-5">
                  {info.invitedByEmail ? (
                    <>
                      <strong>{info.invitedByEmail}</strong> invited you to
                      join{" "}
                    </>
                  ) : (
                    "You were invited to join "
                  )}
                  {info.teamName ? (
                    <>
                      <strong>{info.teamName}</strong>{" "}
                    </>
                  ) : (
                    "their team "
                  )}
                  as a <strong>{info.roleDisplayName}</strong>.
                </p>

                {info.alreadyAccepted && (
                  <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 mb-4">
                    This invitation has already been used. Accepting again
                    simply switches you into{" "}
                    <strong>{info.teamName ?? "the team"}</strong>.
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={submitting}
                    className="px-4 py-2 bg-zinc-100 text-zinc-700 rounded-lg hover:bg-zinc-200 transition-colors text-sm disabled:opacity-50"
                  >
                    Not now
                  </button>
                  <button
                    type="button"
                    onClick={handleAccept}
                    disabled={submitting}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium disabled:opacity-50"
                  >
                    {submitting ? "Accepting…" : "Accept invitation"}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
