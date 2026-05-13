/**
 * Admin Pods API
 *
 * Returns ALL pods with ownership info, billing, and SSH details.
 * Pod list comes from the pool overview cache (refreshed every 2 min).
 * SSH connection info is fetched from hosted.ai on demand.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/admin";
import { getConnectionInfo, getAllUnifiedInstances } from "@/lib/hostedai";
import type { UnifiedInstance } from "@/lib/hostedai";
import { getStripeTeamMap } from "@/lib/admin-cache";
import { prisma } from "@/lib/prisma";

export interface AdminPod {
  subscriptionId: string;
  teamId: string;
  poolId: number;
  poolName: string;
  status: string;
  /** Kubernetes-level container status (e.g., Running, ContainerStatusUnknown) */
  podStatus?: string;
  /** Whether this pod is considered dead/unhealthy */
  isDead: boolean;
  vgpuCount: number;
  podName?: string;
  // Owner info (if matched to a customer)
  owner?: {
    customerId: string;
    email: string;
    name: string;
  };
  // SSH connection info
  ssh?: {
    host: string;
    port: number;
    username: string;
    password?: string;
  };
  // Metrics
  metrics?: {
    tflopsUsage?: number;
    vramUsage?: number;
  };
  // Metadata from our DB
  metadata?: {
    displayName?: string;
    deployTime?: string;
    notes?: string;
  };
  // Billing info
  billing?: {
    hourlyRateCents: number | null;
    monthlyRateCents?: number | null;
    billingType?: string; // "hourly" | "monthly"
    prepaidUntil?: string;
    stripeCustomerId?: string;
  };
  // Timestamps
  createdAt?: string;
}

export async function GET(request: NextRequest) {
  // Verify admin session
  const sessionToken = request.cookies.get("admin_session")?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await fetchPodsData();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Admin pods error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to fetch pods";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

async function fetchPodsData(): Promise<{ pods: AdminPod[]; summary: Record<string, number> }> {
  // Use HAI 2.2 unified instances API for actual pod data (not pool subscriptions)
  const [instances, teamToCustomer] = await Promise.all([
    getAllUnifiedInstances(),
    getStripeTeamMap(),
  ]);

  // Active statuses (running or transitional)
  const ACTIVE_STATUSES = ["running", "pending", "starting", "restarting"];
  const DEAD_STATUSES = ["error", "failed", "unknown"];

  // Build pods from unified instances
  const allPods: AdminPod[] = [];
  const teamIdsWithPods = new Set<string>();

  for (const inst of instances) {
    const teamId = inst.team?.id || "";
    const stripeInfo = teamId ? teamToCustomer.get(teamId) : undefined;
    const statusLower = inst.status?.toLowerCase() || "";
    const isDead = DEAD_STATUSES.includes(statusLower);

    allPods.push({
      subscriptionId: inst.id,
      teamId,
      poolId: 0, // Not directly available from unified API
      poolName: inst.pod_info?.pool_name || inst.service?.name || "Unknown",
      status: statusLower,
      podStatus: inst.status,
      isDead,
      vgpuCount: inst.pod_info?.vgpu_count || 1,
      podName: inst.name,
      owner: stripeInfo ? {
        customerId: stripeInfo.customerId,
        email: stripeInfo.email,
        name: stripeInfo.name || "Unknown",
      } : (inst.team?.name ? {
        customerId: "",
        email: "",
        name: inst.team.name,
      } : undefined),
      ssh: undefined,
      metrics: { tflopsUsage: undefined, vramUsage: undefined },
      createdAt: inst.created_at,
    });

    if (teamId) teamIdsWithPods.add(teamId);
  }

  console.log(`[Admin Pods] ${allPods.length} instances from unified API, ${teamIdsWithPods.size} unique teams`);

  // Fetch SSH connection info for teams with pods (parallel, with timeout)
  const teamsArray = Array.from(teamIdsWithPods);
  const connInfoMap = new Map<string, Map<string, { host: string; port: number; username: string; password?: string }>>();

  await Promise.all(
    teamsArray.map(async (teamId) => {
      try {
        const rawConnectionInfo = await getConnectionInfo(teamId).catch(() => []);
        const connectionInfo = Array.isArray(rawConnectionInfo) ? rawConnectionInfo : [];
        const connMap = new Map<string, { host: string; port: number; username: string; password?: string }>();
        for (const conn of connectionInfo) {
          if (conn.id && conn.pods && conn.pods.length > 0) {
            const pod = conn.pods[0];
            if (pod.ssh_info?.cmd) {
              let sshMatch = pod.ssh_info.cmd.match(/ssh\s+-p\s+(\d+)\s+(\w+)@([^\s]+)/);
              if (!sshMatch) {
                sshMatch = pod.ssh_info.cmd.match(/ssh\s+(\w+)@([^\s]+)\s+-p\s+(\d+)/);
                if (sshMatch) {
                  connMap.set(String(conn.id), {
                    host: sshMatch[2],
                    port: parseInt(sshMatch[3], 10),
                    username: sshMatch[1],
                    password: pod.ssh_info.pass,
                  });
                  continue;
                }
              }
              if (sshMatch) {
                connMap.set(String(conn.id), {
                  host: sshMatch[3],
                  port: parseInt(sshMatch[1], 10),
                  username: sshMatch[2],
                  password: pod.ssh_info.pass,
                });
              }
            }
          }
        }
        connInfoMap.set(teamId, connMap);
      } catch {
        // SSH info is optional — skip on error
      }
    })
  );

  // Match SSH info to pods (connection info is keyed by subscription ID)
  for (const pod of allPods) {
    const connMap = connInfoMap.get(pod.teamId);
    if (connMap) {
      // Try exact match first, then try any connection for this team
      const ssh = connMap.get(pod.subscriptionId) || (connMap.size > 0 ? connMap.values().next().value : undefined);
      if (ssh) pod.ssh = ssh;
    }
  }

  // Build GpuProduct price map by poolId and pool name — authoritative billing source.
  // Unified instances don't have numeric poolId, so we also match by pool_name.
  const poolPriceMap = new Map<number, { hourlyRateCents: number; monthlyRateCents: number | null; billingType: string }>();
  const poolNamePriceMap = new Map<string, { hourlyRateCents: number; monthlyRateCents: number | null; billingType: string }>();
  try {
    const gpuProducts = await prisma.gpuProduct.findMany({
      where: { active: true },
      select: { name: true, poolIds: true, pricePerHourCents: true, pricePerMonthCents: true, billingType: true },
    });

    for (const product of gpuProducts) {
      const pricing = {
        hourlyRateCents: product.pricePerHourCents,
        monthlyRateCents: product.pricePerMonthCents,
        billingType: product.billingType,
      };
      // Index by pool name (lowercase for matching)
      const nameKey = product.name.toLowerCase();
      const existingByName = poolNamePriceMap.get(nameKey);
      if (!existingByName || (product.billingType === "hourly" && existingByName.billingType !== "hourly")) {
        poolNamePriceMap.set(nameKey, pricing);
      }
      try {
        const ids = JSON.parse(product.poolIds) as number[];
        for (const id of ids) {
          const existing = poolPriceMap.get(id);
          if (!existing || (product.billingType === "hourly" && existing.billingType !== "hourly")) {
            poolPriceMap.set(id, pricing);
          }
        }
      } catch { /* skip invalid JSON */ }
    }
  } catch (priceError) {
    console.warn("[Admin Pods] Could not build pool price map:", priceError);
  }

  // Apply GpuProduct pricing to pods — try poolId first, fall back to pool name match
  for (const pod of allPods) {
    let pricing = pod.poolId ? poolPriceMap.get(pod.poolId) : undefined;
    if (!pricing && pod.poolName) {
      // Try matching pool name to product name (case-insensitive, partial match)
      const poolNameLower = pod.poolName.toLowerCase();
      pricing = poolNamePriceMap.get(poolNameLower);
      if (!pricing) {
        // Try partial match — product name contained in pool name or vice versa
        for (const [name, p] of poolNamePriceMap) {
          if (poolNameLower.includes(name) || name.includes(poolNameLower)) {
            pricing = p;
            break;
          }
        }
      }
    }
    if (pricing) {
      pod.billing = {
        hourlyRateCents: pricing.hourlyRateCents || null,
        monthlyRateCents: pricing.monthlyRateCents || null,
        billingType: pricing.billingType,
      };
    }
  }

  // Enrich with PodMetadata from our database (for display names, notes, deploy times)
  try {
    const allMeta = await prisma.podMetadata.findMany({
      select: {
        subscriptionId: true,
        displayName: true,
        notes: true,
        createdAt: true,
        hourlyRateCents: true,
        prepaidUntil: true,
        stripeCustomerId: true,
        poolId: true,
      },
    });

    // Build lookup maps
    const metaBySubId = new Map(allMeta.map((m) => [m.subscriptionId, m]));
    // Also by poolId + stripeCustomerId for matching cache pods
    const metaByPoolCustomer = new Map<string, typeof allMeta[0]>();
    for (const m of allMeta) {
      if (m.poolId && m.stripeCustomerId) {
        metaByPoolCustomer.set(`${m.poolId}-${m.stripeCustomerId}`, m);
      }
    }

    for (const pod of allPods) {
      // Try matching by subscriptionId first
      let meta = metaBySubId.get(pod.subscriptionId);

      // If no match, try by poolId + stripeCustomerId
      if (!meta && pod.owner?.customerId) {
        meta = metaByPoolCustomer.get(`${pod.poolId}-${pod.owner.customerId}`);
      }

      if (meta) {
        pod.metadata = {
          displayName: meta.displayName || undefined,
          deployTime: meta.createdAt?.toISOString(),
          notes: meta.notes || undefined,
        };
        // Merge PodMetadata billing fields into existing billing (don't overwrite GpuProduct rates)
        pod.billing = {
          ...pod.billing,
          hourlyRateCents: pod.billing?.hourlyRateCents ?? meta.hourlyRateCents,
          prepaidUntil: meta.prepaidUntil?.toISOString(),
          stripeCustomerId: meta.stripeCustomerId || undefined,
        };
        pod.createdAt = meta.createdAt?.toISOString();
      }
    }
  } catch (metaError) {
    console.warn("[Admin Pods] Could not fetch pod metadata:", metaError);
  }

  // Calculate summary stats
  // Active = running + transitional states (matches the KPI bar definition)
  const activePods = allPods.filter((p) => ACTIVE_STATUSES.includes(p.status) && !p.isDead);
  const deadPods = allPods.filter((p) => p.isDead);
  const unbilledPods = activePods.filter((p) =>
    !p.billing || (!p.billing.hourlyRateCents && !p.billing.monthlyRateCents)
  );
  const summary = {
    totalPods: allPods.length,
    activePods: activePods.length,
    deadPods: deadPods.length,
    totalVGPUs: activePods.reduce((sum, p) => sum + p.vgpuCount, 0),
    ownedPods: allPods.filter((p) => p.owner).length,
    unownedPods: allPods.filter((p) => !p.owner).length,
    unbilledPods: unbilledPods.length,
  };

  console.log(`[Admin Pods] Total: ${allPods.length} pods, ${summary.activePods} active`);

  return { pods: allPods, summary };
}
