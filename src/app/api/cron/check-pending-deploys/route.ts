/**
 * PA-158 safety net: reconcile orphaned "provisioning" PodMetadata rows.
 *
 * The POST /api/instances handler spawns a fire-and-forget monitor that
 * watches HAI for the pod to reach "running" and refunds on failure. That
 * monitor lives in memory — if the server restarts (PM2 reload, crash, OOM)
 * mid-poll, the deploy is orphaned. This cron picks those up and finishes
 * the reconciliation: refund + delete + mark failed if HAI never started
 * the pod within the timeout window.
 *
 * Schedule: every 2-3 minutes. Idempotent — the underlying status transition
 * is claimed atomically via a conditional Prisma update.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { reconcilePendingDeploy } from "@/lib/deploy-monitor";

// Pods older than this are considered stuck and auto-failed.
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;

// Look back this far to find rows worth inspecting. Anything older than the
// timeout has already been finalized on a previous run (or never will be).
const MAX_AGE_MS = 60 * 60 * 1000;

// Cap per run so a backlog never blows up HAI request volume.
const MAX_PER_RUN = 25;

async function reconcile(request: NextRequest): Promise<NextResponse> {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const now = Date.now();
  const minAge = new Date(now - MAX_AGE_MS);

  let pending;
  try {
    pending = await prisma.podMetadata.findMany({
      where: {
        deployStatus: "provisioning",
        deployTime: { gte: minAge },
      },
      orderBy: { deployTime: "asc" },
      take: MAX_PER_RUN,
    });
  } catch (err) {
    console.error("[CheckPendingDeploys] Query failed:", err);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  if (pending.length === 0) {
    return NextResponse.json({ success: true, checked: 0 });
  }

  console.log(`[CheckPendingDeploys] Reconciling ${pending.length} provisioning row(s)`);

  const results: Array<{ instanceId: string; status: string; reason?: string }> = [];

  for (const row of pending) {
    if (!row.instanceId || !row.deployTime) {
      // No instance id or no deploy time — flag and skip; nothing we can poll.
      console.warn(`[CheckPendingDeploys] Skipping row ${row.id}: missing instanceId or deployTime`);
      continue;
    }
    const isMonthlyDeploy = row.billingType === "monthly";
    const prechargedCents = isMonthlyDeploy ? 0 : (row.prepaidAmountCents || 0);

    try {
      const result = await reconcilePendingDeploy({
        instanceId: row.instanceId,
        customerId: row.stripeCustomerId,
        prechargedCents,
        isMonthlyDeploy,
        deployTime: row.deployTime,
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
      results.push({ instanceId: row.instanceId, status: result.status, reason: result.reason });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[CheckPendingDeploys] Reconcile failed for ${row.instanceId}:`, msg);
      results.push({ instanceId: row.instanceId, status: "error", reason: msg.slice(0, 200) });
    }
  }

  return NextResponse.json({
    success: true,
    checked: pending.length,
    durationMs: Date.now() - now,
    results,
  });
}

export async function POST(request: NextRequest) {
  return reconcile(request);
}

// GET → POST for manual testing (matches other crons in the repo).
export async function GET(request: NextRequest) {
  return reconcile(request);
}
