"use client";

import { useEffect } from "react";

/**
 * Wraps window.fetch once per page load. When a same-origin /api/* call returns
 * 401, redirects the user to the supplied login page so they can re-authenticate
 * instead of silently failing in place.
 *
 * Auth endpoints (anything matching /api/(...)/auth) are skipped so the initial
 * "am I logged in?" check doesn't trigger a redirect loop with the existing
 * mount-time check in useAdminData.
 */

interface SessionGuardProps {
  redirectTo: string;
}

const INSTALL_FLAG = "__packetSessionGuardInstalled" as const;
export const SESSION_EXPIRED_QUERY = "reason=session_expired";

function isAuthEndpoint(pathname: string): boolean {
  return /\/auth(\/|$)/.test(pathname);
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function SessionGuard({ redirectTo }: SessionGuardProps) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const w = window as unknown as Record<string, unknown>;
    if (w[INSTALL_FLAG]) return;
    w[INSTALL_FLAG] = true;

    const originalFetch = window.fetch.bind(window);
    let redirecting = false;

    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);

      if (response.status !== 401 || redirecting) return response;

      try {
        const url = new URL(getRequestUrl(input), window.location.origin);
        const sameOrigin = url.origin === window.location.origin;
        const isApi = url.pathname.startsWith("/api/");

        if (sameOrigin && isApi && !isAuthEndpoint(url.pathname)) {
          redirecting = true;
          const separator = redirectTo.includes("?") ? "&" : "?";
          window.location.href = `${redirectTo}${separator}${SESSION_EXPIRED_QUERY}`;
        }
      } catch {
        // If URL parsing fails, just return the response — better to surface
        // the 401 normally than to break the page.
      }

      return response;
    };
  }, [redirectTo]);

  return null;
}
