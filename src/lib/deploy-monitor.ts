/**
 * Post-createInstance deployment monitor (PA-158).
 *
 * HAI's createInstance can return a valid instance ID while the pod silently
 * fails to start (terminal error state, then deleted ~10min later). Without
 * monitoring, the customer's wallet pre-charge stands and they're silently
 * overcharged. This module polls HAI until the pod reaches a running state
 * or fails, then refunds + cleans up on failure.
 *
 * Two entry points:
 *   monitorDeployStatus()      — full polling loop, used inline (fire-and-forget)
 *                                from the POST /instances handlers.
 *   reconcilePendingDeploy()   — single status check, used by the cron safety
 *                                net to pick up orphaned "provisioning" rows
 *                                after a server restart.
 *
 * Idempotency:
 *   The state transition `provisioning → running | failed_refunded` is claimed
 *   via a conditional Prisma update (`where: { deployStatus: "provisioning" }`).
 *   Only the caller whose update affects 1 row issues the refund and HAI delete.
 *   Concurrent inline + cron runs cannot double-refund.
 */
import { prisma } from "./prisma";
import { refundDeployment } from "./wallet";
import {
  waitForInstanceRunning,
  getUnifiedInstanceDetail,
  deleteInstance,
  type WaitForInstanceOptions,
} from "./hostedai";

const RUNNING_STATUSES = new Set(["running", "active"]);
const TERMINAL_FAIL_STATUSES = new Set([
  "succeeded", "failed", "terminated", "error", "crashloopbackoff", "stopped",
]);

export interface MonitorDeployArgs {
  instanceId: string;
  customerId: string;
  prechargedCents: number;
  isMonthlyDeploy: boolean;
  // Polling tuning / test injection.
  maxMs?: number;
  intervalMs?: number;
  waitOpts?: Pick<WaitForInstanceOptions, "getDetail" | "sleep">;
}

export interface MonitorDeployResult {
  ready: boolean;
  reason?: string;
}

// Run a full polling loop. Designed to be invoked fire-and-forget from a
// request handler — never throws. On success, marks PodMetadata.deployStatus
// as "running". On failure, refunds the wallet, marks the row as
// "failed_refunded", and schedules a best-effort HAI instance delete.
export async function monitorDeployStatus(
  args: MonitorDeployArgs
): Promise<MonitorDeployResult> {
  try {
    const result = await waitForInstanceRunning(args.instanceId, {
      maxMs: args.maxMs,
      intervalMs: args.intervalMs,
      ...(args.waitOpts || {}),
    });
    if (result.ready) {
      await markDeployRunning(args.instanceId);
      return { ready: true };
    }
    await failDeploy(args, result.reason);
    return { ready: false, reason: result.reason };
  } catch (err) {
    console.error(`[DeployMonitor] Unexpected error monitoring ${args.instanceId}:`, err);
    return { ready: false, reason: "monitor exception" };
  }
}

// Re-check a single instance's status once. Returns the post-check state
// (or "still_provisioning" when within the timeout window).
//
// 404 handling mirrors waitForInstanceRunning: require two consecutive 404s
// (~5s apart) before declaring deletion, so a transient HAI blip during a
// cron run can't fire a premature refund.
export async function reconcilePendingDeploy(
  args: {
    instanceId: string;
    customerId: string;
    prechargedCents: number;
    isMonthlyDeploy: boolean;
    deployTime: Date;
    timeoutMs?: number;
    // Test injection: override the recheck sleep (default 5s).
    recheckDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<{ status: "running" | "still_provisioning" | "failed_refunded"; reason?: string }> {
  const timeoutMs = args.timeoutMs ?? 15 * 60 * 1000;
  const recheckDelayMs = args.recheckDelayMs ?? 5_000;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let statusStr: string;
  try {
    const detail = await getUnifiedInstanceDetail(args.instanceId);
    statusStr = (detail.status || "").toLowerCase();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("(404)")) {
      // Re-verify before refunding: wait briefly then re-check.
      await sleep(recheckDelayMs);
      try {
        const detail = await getUnifiedInstanceDetail(args.instanceId);
        statusStr = (detail.status || "").toLowerCase();
        // Recovered — fall through to normal status handling below.
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        if (msg2.includes("(404)")) {
          const reason = "instance deleted by HAI";
          await failDeploy(args, reason);
          return { status: "failed_refunded", reason };
        }
        console.error(`[DeployMonitor] Transient HAI error reconciling ${args.instanceId} (after 404 recheck):`, err2);
        return { status: "still_provisioning" };
      }
    } else {
      console.error(`[DeployMonitor] Transient HAI error reconciling ${args.instanceId}:`, err);
      return { status: "still_provisioning" };
    }
  }

  if (RUNNING_STATUSES.has(statusStr)) {
    await markDeployRunning(args.instanceId);
    return { status: "running" };
  }
  if (TERMINAL_FAIL_STATUSES.has(statusStr)) {
    const reason = `terminal status: ${statusStr}`;
    await failDeploy(args, reason);
    return { status: "failed_refunded", reason };
  }

  const ageMs = Date.now() - args.deployTime.getTime();
  if (ageMs > timeoutMs) {
    const reason = `cron timeout: pod still ${statusStr || "unknown"} after ${Math.round(ageMs / 60000)}min`;
    await failDeploy(args, reason);
    return { status: "failed_refunded", reason };
  }
  return { status: "still_provisioning" };
}

async function markDeployRunning(instanceId: string): Promise<void> {
  try {
    await prisma.podMetadata.updateMany({
      where: { instanceId, deployStatus: "provisioning" },
      data: { deployStatus: "running" },
    });
  } catch (err) {
    console.error(`[DeployMonitor] Failed to mark ${instanceId} running:`, err);
  }
}

// Claim the failure transition atomically, then refund + clean up. If the
// claim affects zero rows, another caller already finalized this deployment
// and we must not refund again.
async function failDeploy(
  args: { instanceId: string; customerId: string; prechargedCents: number; isMonthlyDeploy: boolean },
  reason: string
): Promise<void> {
  console.log(`[DeployMonitor] Instance ${args.instanceId} failed to start: ${reason}`);

  let claimed = 0;
  try {
    const result = await prisma.podMetadata.updateMany({
      where: { instanceId: args.instanceId, deployStatus: "provisioning" },
      data: {
        deployStatus: "failed_refunded",
        deployStatusReason: reason.slice(0, 500),
      },
    });
    claimed = result.count;
  } catch (err) {
    console.error(`[DeployMonitor] Failed to claim failure transition for ${args.instanceId}:`, err);
    return;
  }

  if (claimed === 0) {
    console.log(`[DeployMonitor] Skipping refund for ${args.instanceId}: already finalized`);
    return;
  }

  if (!args.isMonthlyDeploy && args.prechargedCents > 0) {
    const refund = await refundDeployment(
      args.customerId,
      args.prechargedCents,
      `Refund: instance ${args.instanceId} failed to start (${reason})`
    );
    if (!refund.success) {
      console.error(`[DeployMonitor] Refund failed for ${args.instanceId}: ${refund.error}`);
    }
  }

  // Best-effort cleanup — HAI will reap this anyway after ~10min.
  deleteInstance(args.instanceId).catch(() => {});
}
