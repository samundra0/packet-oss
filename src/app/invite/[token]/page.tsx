// /invite/[token] — pure router. Does NOT accept the invitation.
//
// Flow:
//   - Look up invitation (read-only, no side effects).
//   - If a customer JWT is present in ?token= and JWT.email matches the
//     invitee → land at /dashboard?token=<JWT>&invite=<token>; the
//     dashboard surfaces an Accept modal.
//   - If JWT is present but email mismatches → render a "wrong session"
//     screen telling the user to sign out and click again.
//   - If no JWT → bounce through /account?invite=<token>&email=<invitee>.
//     The standard signin/signup flow runs, and the invite token is
//     carried forward all the way to /dashboard?token=<JWT>&invite=<token>.
//
// The actual accept (User+Membership upserts, HAI sync, invitation
// status flip) ONLY happens when the user clicks "Accept" in the
// dashboard modal, which POSTs to /api/invitations/[token]/accept with
// the user's own Bearer JWT.

import { redirect } from "next/navigation";
import Link from "next/link";
import { lookupInvitation } from "@/lib/auth/accept-invitation";
import { verifyCustomerToken } from "@/lib/customer-auth";

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ token?: string }>;
}

export default async function InviteRouter({
  params,
  searchParams,
}: PageProps) {
  const { token: inviteToken } = await params;
  const { token: jwtToken } = await searchParams;

  if (!inviteToken || typeof inviteToken !== "string") {
    return <ErrorScreen message="This invitation link is malformed." />;
  }

  const lookup = await lookupInvitation(inviteToken);
  if (!lookup.ok) {
    return <ErrorScreen message={lookup.error} />;
  }

  // No active session — kick through the standard auth flow with the
  // invite carried in the URL.
  if (!jwtToken) {
    const qs = new URLSearchParams({
      invite: inviteToken,
      email: lookup.email,
    });
    redirect(`/account?${qs.toString()}`);
  }

  // Session present — verify it points at the invitee.
  const payload = verifyCustomerToken(jwtToken);
  if (!payload) {
    // Expired / invalid JWT. Treat the same as no session.
    const qs = new URLSearchParams({
      invite: inviteToken,
      email: lookup.email,
    });
    redirect(`/account?${qs.toString()}`);
  }

  if (payload.email.toLowerCase() !== lookup.email.toLowerCase()) {
    return (
      <WrongSessionScreen
        currentEmail={payload.email}
        invitee={lookup.email}
      />
    );
  }

  // Right session — drop into the dashboard with the invite param so the
  // accept modal renders on mount.
  redirect(`/dashboard?token=${jwtToken}&invite=${inviteToken}`);
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-4">
      <div className="max-w-md w-full bg-white border border-zinc-200 rounded-lg p-8 text-center">
        <h1 className="text-lg font-semibold text-zinc-900 mb-2">
          Invitation problem
        </h1>
        <p className="text-sm text-red-700 mb-4">{message}</p>
        <Link
          href="/account"
          className="inline-block px-4 py-2 bg-zinc-200 text-zinc-700 rounded-lg hover:bg-zinc-300 transition-colors text-sm"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}

function WrongSessionScreen({
  currentEmail,
  invitee,
}: {
  currentEmail: string;
  invitee: string;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-4">
      <div className="max-w-md w-full bg-white border border-zinc-200 rounded-lg p-8">
        <h1 className="text-lg font-semibold text-zinc-900 mb-2">
          Wrong session
        </h1>
        <p className="text-sm text-zinc-700 mb-4">
          This invitation was sent to <strong>{invitee}</strong>, but
          you&apos;re currently signed in as <strong>{currentEmail}</strong>.
        </p>
        <p className="text-sm text-zinc-700 mb-5">
          Sign out, then click the invitation link from your email again.
        </p>
        <Link
          href="/account"
          className="inline-block px-4 py-2 bg-zinc-200 text-zinc-700 rounded-lg hover:bg-zinc-300 transition-colors text-sm"
        >
          Go to sign in
        </Link>
      </div>
    </div>
  );
}
