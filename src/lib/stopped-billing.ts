/**
 * Stopped-instance ("reserved") billing math.
 *
 * Stopped / paused / reserved GPU pods are billed at a configurable percentage
 * of their running rate (see getStoppedInstanceRatePercent / data/pricing.json).
 *
 * IMPORTANT: each stopped pod is priced at ITS OWN per-GPU rate × its gpuCount,
 * exactly like the running-charge path (sync/route.ts). Do NOT average rates
 * across the customer's fleet — a single expensive (or stale/terminated) pod in
 * PodMetadata would otherwise inflate the charge applied to a cheap stopped pod
 * (the cause of the "$751.90 for a stopped $100/hr GPU" overcharge).
 */

export interface StoppedPodInput {
  /** Number of GPUs in this stopped pod (HAI per_pod_info.vgpu_count / pod.gpu_count). */
  gpuCount: number;
  /** This pod's OWN per-GPU hourly rate in cents (PodMetadata.hourlyRateCents). 0 = unknown. */
  perGpuRateCents: number;
}

export interface StoppedChargeResult {
  /** Total GPUs actually billed (priced pods only). Used for the charge description. */
  stoppedGpuCount: number;
  /** Amount to charge for this billing interval, in cents (rounded). */
  stoppedCostCents: number;
}

/**
 * Compute the stopped-instance reservation charge for one billing interval.
 *
 * For each stopped pod with a known rate: contributes `perGpuRateCents × gpuCount`
 * to the full-rate hourly total. The total is then scaled by the stopped-rate
 * percentage and the interval length, and rounded once at the end.
 *
 * Pods with no known rate (perGpuRateCents <= 0) are skipped entirely — never
 * billed and never counted — so a missing PodMetadata row can't be "guessed" at
 * a fleet average.
 */
export function computeStoppedCharge(
  pods: StoppedPodInput[],
  stoppedRatePercent: number,
  intervalMinutes: number,
): StoppedChargeResult {
  const hoursInInterval = intervalMinutes / 60;

  let stoppedGpuCount = 0;
  let fullHourlyRateCents = 0;

  for (const pod of pods) {
    if (!pod.perGpuRateCents || pod.perGpuRateCents <= 0) continue; // unpriced → skip
    const gpus = Math.max(1, Math.ceil(pod.gpuCount || 1));
    stoppedGpuCount += gpus;
    fullHourlyRateCents += pod.perGpuRateCents * gpus;
  }

  const stoppedCostCents = Math.round(
    fullHourlyRateCents * (stoppedRatePercent / 100) * hoursInInterval,
  );

  return { stoppedGpuCount, stoppedCostCents };
}

/** Minimal shape of a Stripe customer balance transaction for the dedup check. */
export interface RecentBalanceTxn {
  created: number; // unix seconds
  metadata?: { billing_type?: string | null } | null;
}

export const STOPPED_RESERVATION_BILLING_TYPE = "stopped_reservation";

/**
 * Dedup guard: true if a stopped-reservation charge was already posted within
 * `withinSeconds` of `nowSec`.
 *
 * The running-charge path is idempotent per interval via each pod's prepaidUntil
 * (plus a recent-chargeId check). The stopped-charge path has no prepaidUntil, so
 * without this a double cron run could bill stopped pods twice — e.g. a brand-new
 * customer with no storage-sync timestamp yet, or two overlapping invocations
 * racing the 25-min storage-sync gate. A short window (well under the ~25-min
 * legitimate spacing) catches those races without blocking real consecutive bills.
 */
export function wasStoppedBilledRecently(
  txns: RecentBalanceTxn[],
  nowSec: number,
  withinSeconds: number,
): boolean {
  const cutoff = nowSec - withinSeconds;
  return txns.some(
    (t) => t.metadata?.billing_type === STOPPED_RESERVATION_BILLING_TYPE && t.created > cutoff,
  );
}
