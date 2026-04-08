import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { getGlobalInstanceSummary } from "@/lib/hostedai/instances";

export async function GET(request: NextRequest) {
  const sessionToken = request.cookies.get("admin_session")?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Read the two most recent snapshots (today + yesterday)
    const snapshots = await prisma.adminStatsSnapshot.findMany({
      orderBy: { date: "desc" },
      take: 2,
    });

    const latest = snapshots[0];
    const previous = snapshots[1];

    if (!latest) {
      return NextResponse.json({
        totalCustomers: 0,
        activePods: 0,
        mrr: 0,
        newCustomersThisWeek: 0,
        revenueThisWeek: 0,
        growth: null,
      });
    }

    // Use HAI 2.2 /instances/unified for live active pod count
    // The status_counts field gives us an accurate breakdown without fetching all items
    // Count running + transitional states (pending, starting, restarting) as "active"
    // Ref: Confluence HP/600178689 — Status for VM/Pod Instances
    const ACTIVE_STATUSES = ["running", "pending", "starting", "restarting"];
    let liveActivePods = latest.activeGPUs; // fallback to snapshot
    try {
      const summary = await getGlobalInstanceSummary();
      const activeCount = summary.statusCounts
        .filter((s) => ACTIVE_STATUSES.includes(s.status.toLowerCase()))
        .reduce((sum, s) => sum + s.count, 0);
      liveActivePods = activeCount;
    } catch (err) {
      console.warn("[Stats] Failed to fetch live instance summary, using snapshot:", err);
    }

    const current = {
      totalCustomers: latest.totalCustomers,
      activePods: liveActivePods,
      mrr: latest.mrrCents,
      newCustomersThisWeek: latest.newThisWeek,
      revenueThisWeek: latest.revenueWeekCents,
    };

    return NextResponse.json({
      ...current,
      growth: previous
        ? {
            totalCustomers: current.totalCustomers - previous.totalCustomers,
            activePods: current.activePods - previous.activeGPUs,
            mrr: current.mrr - previous.mrrCents,
            newCustomersThisWeek: current.newCustomersThisWeek - previous.newThisWeek,
            revenueThisWeek: current.revenueThisWeek - previous.revenueWeekCents,
          }
        : null,
    });
  } catch (error) {
    console.error("Stats error:", error);
    return NextResponse.json({ error: "Failed to fetch stats" }, { status: 500 });
  }
}
