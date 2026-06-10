/**
 * The single external deep-link contract for the launch funnel.
 *
 * One vocabulary end-to-end (marketing CTA, email, in-product):
 *   /dashboard?gpu=<categorySlug>&plan=<hourly|monthly>
 *
 * - `gpu`  is a GpuCategory.slug (e.g. "b200", "rtx-pro-6000"). Optional.
 * - `plan` is the billing intent. Optional; defaults to hourly when a gpu is present.
 *
 * The dashboard translates this into which launch UI to open. Marketing never
 * needs to know about product ids, category cuids, or internal modal state — it
 * speaks slugs and billing intent, and the dashboard resolves the rest.
 */

export type DeeplinkTarget =
  | { kind: "hourly"; categorySlug?: string }
  | { kind: "monthly"; categorySlug?: string }
  | { kind: "none" };

export function resolveLaunchDeeplink(search: string | URLSearchParams): DeeplinkTarget {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const gpu = params.get("gpu") || undefined;
  const plan = params.get("plan");

  if (plan === "monthly") return { kind: "monthly", categorySlug: gpu };
  if (gpu || plan === "hourly") return { kind: "hourly", categorySlug: gpu };
  return { kind: "none" };
}
