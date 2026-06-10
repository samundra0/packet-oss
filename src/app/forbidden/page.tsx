// /forbidden — generic 403 landing page reached when the user clicks a UI
// affordance that requires a permission they don't have, or when an API gate
// has returned 403 and the dashboard chose to redirect them here.
//
// Surfaces the team admin's email + a "Request Access" mailto link as a
// fallback when SMTP isn't configured.

"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { getBrandName } from "@/lib/branding-client";

interface AdminContact {
  email: string;
  displayName: string | null;
}

function ForbiddenInner() {
  const params = useSearchParams();
  const permission = params?.get("permission") ?? null;
  const role = params?.get("role") ?? null;
  const accountId = params?.get("accountId") ?? null;
  const reason = params?.get("reason") ?? null;

  const [admin, setAdmin] = useState<AdminContact | null>(null);

  useEffect(() => {
    if (!accountId) return;
    // Best-effort: try to load a Team Admin's contact info from the members
    // endpoint. Falls back to no-contact UI if the user has no JWT or the
    // call fails. Wrapped in try/catch so an error here never hides the page.
    const jwt = typeof window !== "undefined" ? localStorage.getItem("customerToken") : null;
    if (!jwt) return;
    (async () => {
      try {
        const res = await fetch(`/api/accounts/${accountId}/members`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          members: Array<{ email: string; displayName: string | null; isOwner: boolean; role: string }>;
        };
        // Prefer the Owner row; fall back to any teamAdmin.
        const owner =
          data.members.find((m) => m.isOwner) ??
          data.members.find((m) => m.role === "teamAdmin");
        if (owner) setAdmin({ email: owner.email, displayName: owner.displayName });
      } catch {
        /* swallow — non-critical */
      }
    })();
  }, [accountId]);

  const requestAccessSubject = encodeURIComponent(
    `Access request${permission ? ` for ${permission}` : ""}`,
  );
  const requestAccessBody = encodeURIComponent(
    `Hi,\n\nI tried to use a feature on ${getBrandName()} but don't have permission for it.\n\n` +
      (permission ? `Permission required: ${permission}\n` : "") +
      (role ? `My current role: ${role}\n` : "") +
      `\nCould you grant me access, or change my role?\n\nThanks.`,
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-4">
      <div className="max-w-md w-full bg-white border border-zinc-200 rounded-lg p-8">
        <h1 className="text-lg font-semibold text-zinc-900 mb-2">
          You don&apos;t have permission for that
        </h1>
        <p className="text-sm text-zinc-600 mb-4">
          {reason
            ? reason
            : permission
              ? `This action requires the "${permission}" permission, which your current role doesn't include.`
              : "Your role doesn't include this action."}
          {role && (
            <span className="block mt-2 text-zinc-500">Your role: {role}</span>
          )}
        </p>

        {admin ? (
          <div className="border-t border-zinc-200 pt-4">
            <p className="text-sm text-zinc-700 mb-3">
              Ask a Team Admin for access. {admin.displayName ? admin.displayName : "Your Team Admin"}:
            </p>
            <a
              href={`mailto:${admin.email}?subject=${requestAccessSubject}&body=${requestAccessBody}`}
              className="inline-block px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm"
            >
              Request access
            </a>
            <span className="ml-3 text-xs text-zinc-500">{admin.email}</span>
          </div>
        ) : (
          <p className="text-xs text-zinc-500 border-t border-zinc-200 pt-4">
            Contact your Team Admin to request the necessary permission.
          </p>
        )}

        <div className="mt-6 text-right">
          <a
            href="/dashboard"
            className="text-xs text-zinc-500 hover:text-zinc-700 underline"
          >
            ← Back to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}

export default function ForbiddenPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-50" />}>
      <ForbiddenInner />
    </Suspense>
  );
}
