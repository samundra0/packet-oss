import type { TabType } from "./hooks/useModals";
import type { Permission } from "@/lib/auth/role-permissions";

export type CanMap = Partial<Record<Permission, boolean>>;

/**
 * PA-269: tabs whose visibility is gated on a permission in the sidebar.
 *
 * The sidebar (DashboardContent) hides these NavItems for unprivileged roles,
 * but `?tab=<x>` still mounts the tab on direct navigation — so a Team Member /
 * Read-only Member could open the Billing tab by typing the URL. These
 * predicates let DashboardContent redirect such a user back to the dashboard.
 *
 * Each predicate MUST mirror the exact sidebar condition for that tab. If you
 * change a sidebar gate, change it here too. (The real protection is the data
 * APIs, which enforce the same permissions server-side — this is UX + defense
 * in depth, not the security boundary.)
 *
 * Tabs not listed are always viewable (dashboard, team, settings, support, keys).
 */
export const TAB_VIEW_GUARDS: Partial<Record<TabType, (can: CanMap) => boolean>> = {
  billing: (can) => !!can["billing.view"],
  huggingface: (can) => !!can["huggingface.use"],
  apps: (can) => !!can["apps.use"],
  storage: (can) => !!(can["gpu.access"] || can["billing.view"]),
  metrics: (can) => !!(can["gpu.access"] || can["billing.view"]),
  referrals: (can) => !!can["referral.view"],
  baremetal: (can) => !!can["gpu.provision"],
};

/**
 * Whether `tab` may be viewed given the user's permission map.
 *
 * - Ungated tabs → always true.
 * - A null/undefined can-map → true. The map is populated by /api/account/verify;
 *   before it loads we must NOT redirect, or a legitimate billing.view user would
 *   be bounced off Billing on first paint. The server still gates the data.
 */
export function isTabAllowed(tab: TabType, can: CanMap | null | undefined): boolean {
  const guard = TAB_VIEW_GUARDS[tab];
  if (!guard) return true;
  if (!can) return true;
  return guard(can);
}
