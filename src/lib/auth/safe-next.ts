/**
 * Validate a post-login redirect ("next") target before it is signed into a
 * magic-link token and again before it is honoured.
 *
 * The only legitimate `next` values are same-origin, root-relative paths into
 * the app's own /dashboard or /account routes (this is how a deep-link survives
 * the login round-trip). Everything else is rejected to a safe `undefined`.
 *
 * Defends against open-redirect: scheme-relative `//host`, absolute URLs,
 * backslashes, encoded slashes (%2f/%5c), path traversal (..), userinfo `@`,
 * and any path outside the allowlist.
 */
export function sanitizeNextPath(next: unknown, appUrl: string): string | undefined {
  if (typeof next !== "string" || next.length === 0 || next.length > 512) return undefined;

  // Must be root-relative — not scheme-relative ("//host") or "/\host", not absolute.
  if (next[0] !== "/" || next[1] === "/" || next[1] === "\\") return undefined;

  // Reject encoding / traversal / userinfo tricks before normalisation.
  const lower = next.toLowerCase();
  if (
    lower.includes("\\") ||
    lower.includes("..") ||
    lower.includes("@") ||
    lower.includes("%2f") ||
    lower.includes("%5c") ||
    lower.includes("%2e")
  ) {
    return undefined;
  }

  let base: URL;
  try {
    base = new URL(appUrl);
  } catch {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return undefined;
  }

  // Resolving the relative path must not have escaped the app's origin.
  if (url.origin !== base.origin) return undefined;

  const path = url.pathname;
  const onAllowlist =
    path === "/dashboard" ||
    path === "/account" ||
    path.startsWith("/dashboard/") ||
    path.startsWith("/account/");
  if (!onAllowlist) return undefined;

  return url.pathname + url.search;
}
