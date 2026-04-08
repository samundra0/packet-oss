/**
 * CRON: Refresh Pool Overview (Every 2 minutes)
 *
 * Pre-computes pool overview data and writes to disk cache.
 * The /api/admin/pools endpoint serves from this cache for instant loads.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { computePoolOverview, writePoolOverviewCache, readPoolOverviewCache } from "@/lib/pool-overview";

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const startTime = Date.now();

  try {
    // Read existing cache first — passed to computePoolOverview so it can
    // preserve per-pool pod data when individual API calls fail
    const existingCache = readPoolOverviewCache();

    console.log("[Pool Overview Cron] Computing pool overview...");
    const data = await computePoolOverview(existingCache);

    // Don't overwrite good cache when GPUaaS API is partially or fully down.
    // If pod count drops by more than 50%, it's likely API failures, not real terminations.
    if (existingCache && existingCache.summary.activePods > 0) {
      const dropPercent = Math.round(
        ((existingCache.summary.activePods - data.summary.activePods) / existingCache.summary.activePods) * 100
      );
      if (dropPercent > 50) {
        const elapsed = Date.now() - startTime;
        console.warn(
          `[Pool Overview Cron] Pod count dropped ${dropPercent}% (${existingCache.summary.activePods} → ${data.summary.activePods}) — likely API failures, keeping existing cache`
        );
        return NextResponse.json({
          ok: true,
          pools: data.pools.length,
          activePods: data.summary.activePods,
          keptExistingCache: true,
          existingActivePods: existingCache.summary.activePods,
          dropPercent,
          elapsedMs: elapsed,
        });
      }
    }

    writePoolOverviewCache(data);

    const elapsed = Date.now() - startTime;
    console.log(`[Pool Overview Cron] Done in ${elapsed}ms — ${data.pools.length} pools, ${data.summary.activePods} active pods`);

    return NextResponse.json({
      ok: true,
      pools: data.pools.length,
      activePods: data.summary.activePods,
      elapsedMs: elapsed,
    });
  } catch (e) {
    const elapsed = Date.now() - startTime;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Pool Overview Cron] Failed in ${elapsed}ms:`, e);
    return NextResponse.json(
      { error: "Cron failed", message: msg, elapsedMs: elapsed },
      { status: 500 }
    );
  }
}
