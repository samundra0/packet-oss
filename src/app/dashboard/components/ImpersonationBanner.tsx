"use client";

/**
 * Sticky bar shown only in an admin "Login as" (impersonation) session, so the
 * admin always knows whose account they're acting in. The real customer never
 * sees it — impersonation rides an ephemeral, tab-scoped token (no cookie), so
 * skipTwoFactor is only ever true in the admin's impersonation tab.
 */
export function ImpersonationBanner({
  customerEmail,
  adminEmail,
}: {
  customerEmail: string;
  adminEmail?: string | null;
}) {
  return (
    <div className="sticky top-0 z-[70] flex items-center justify-center gap-3 bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950 shadow">
      <span>
        ⚠ You are logged in as <strong>{customerEmail}</strong> using the
        &ldquo;Login as&rdquo; feature
        {adminEmail ? (
          <>
            {" "}from <strong>{adminEmail}</strong>&apos;s account
          </>
        ) : null}
        . Actions affect this customer&apos;s account.
      </span>
      <button
        type="button"
        onClick={() => {
          try {
            window.close();
          } catch {
            /* not script-opened */
          }
          window.location.href = "/admin";
        }}
        className="shrink-0 rounded bg-amber-950/10 px-2 py-0.5 font-semibold text-amber-950 hover:bg-amber-950/20"
      >
        Exit
      </button>
    </div>
  );
}
