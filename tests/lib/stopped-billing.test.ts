/**
 * Stopped-instance reservation billing.
 *
 * Bug (seen in prod/staging): a stopped GPU at 50% was billed ~15x a running
 * GPU at 100% for the same 30-min interval ($751.90 vs $50). Root cause: the
 * sync route charged stoppedGpuCount × a FLEET-WIDE AVERAGE of every pod's
 * hourlyRateCents, so an expensive (or stale terminated) pod in PodMetadata
 * inflated the rate applied to a cheap stopped pod. The running path bills each
 * pod at its OWN per-GPU rate — the stopped path must do the same.
 *
 * computeStoppedCharge() is the extracted pure calc: each stopped pod priced at
 * its own per-GPU rate × its gpuCount, summed, then × percent × interval.
 */
import { describe, it, expect } from "vitest";
import { computeStoppedCharge, wasStoppedBilledRecently } from "@/lib/stopped-billing";

describe("computeStoppedCharge", () => {
  it("charges a single stopped GPU the stopped % of ITS OWN rate (not a fleet avg)", () => {
    // $100/hr GPU, 50%, 30 min → $25 (half of the $50 running charge).
    const r = computeStoppedCharge([{ gpuCount: 1, perGpuRateCents: 10000 }], 50, 30);
    expect(r).toEqual({ stoppedGpuCount: 1, stoppedCostCents: 2500 });
  });

  it("at 100% equals the running charge for the interval", () => {
    const r = computeStoppedCharge([{ gpuCount: 1, perGpuRateCents: 10000 }], 100, 30);
    expect(r.stoppedCostCents).toBe(5000); // $50, same as running 1 GPU @ $100/hr x 30min
  });

  it("bills each pod at its own rate — never a blended average (regression)", () => {
    // A cheap 1×$100/hr pod + an expensive 8×$750/hr pod, both stopped, 50%, 30min.
    // Per-pod: (10000×1 + 75000×8) = 610000/hr → ×0.5 ×0.5h = 152500 ($1525).
    // The old fleet-average logic would have produced a different (wrong) number.
    const r = computeStoppedCharge(
      [
        { gpuCount: 1, perGpuRateCents: 10000 },
        { gpuCount: 8, perGpuRateCents: 75000 },
      ],
      50,
      30,
    );
    expect(r).toEqual({ stoppedGpuCount: 9, stoppedCostCents: 152500 });
  });

  it("a cheap stopped pod's charge is unaffected by an expensive one (the actual bug)", () => {
    // The reported bug: one stopped $100/hr GPU billed $751.90 because pricier
    // pods polluted the average. Here the cheap pod alone is always exactly $25.
    const cheapAlone = computeStoppedCharge([{ gpuCount: 1, perGpuRateCents: 10000 }], 50, 30);
    expect(cheapAlone.stoppedCostCents).toBe(2500);
    expect(cheapAlone.stoppedCostCents).toBeLessThan(5000); // always < running
  });

  it("skips pods with no known rate instead of guessing (no avg fallback)", () => {
    const r = computeStoppedCharge(
      [
        { gpuCount: 1, perGpuRateCents: 0 }, // unpriced → not billed, not counted
        { gpuCount: 2, perGpuRateCents: 20000 },
      ],
      50,
      30,
    );
    // Only the priced pod: 20000×2 = 40000/hr × 0.5 × 0.5h = 10000 ($100); 2 GPUs.
    expect(r).toEqual({ stoppedGpuCount: 2, stoppedCostCents: 10000 });
  });

  it("returns zero when nothing is stopped", () => {
    expect(computeStoppedCharge([], 50, 30)).toEqual({ stoppedGpuCount: 0, stoppedCostCents: 0 });
  });

  it("returns zero cost when the stopped rate is 0%", () => {
    const r = computeStoppedCharge([{ gpuCount: 1, perGpuRateCents: 10000 }], 0, 30);
    expect(r.stoppedCostCents).toBe(0);
    expect(r.stoppedGpuCount).toBe(1);
  });

  it("rounds to the nearest cent", () => {
    // 3333 × 0.25 × 0.5 = 416.625 → 417
    const r = computeStoppedCharge([{ gpuCount: 1, perGpuRateCents: 3333 }], 25, 30);
    expect(r.stoppedCostCents).toBe(417);
  });

  it("treats a fractional/zero gpuCount as at least 1 GPU", () => {
    const r = computeStoppedCharge([{ gpuCount: 0, perGpuRateCents: 10000 }], 100, 30);
    expect(r).toEqual({ stoppedGpuCount: 1, stoppedCostCents: 5000 });
  });
});

describe("wasStoppedBilledRecently — dedup guard", () => {
  const NOW = 1_000_000;

  it("returns true when a stopped_reservation charge is within the window", () => {
    const txns = [{ created: NOW - 60, metadata: { billing_type: "stopped_reservation" } }];
    expect(wasStoppedBilledRecently(txns, NOW, 300)).toBe(true);
  });

  it("returns false when the only stopped charge is older than the window", () => {
    const txns = [{ created: NOW - 600, metadata: { billing_type: "stopped_reservation" } }];
    expect(wasStoppedBilledRecently(txns, NOW, 300)).toBe(false);
  });

  it("ignores other charge types (GPU usage, storage)", () => {
    const txns = [
      { created: NOW - 10, metadata: { billing_type: "storage" } },
      { created: NOW - 10, metadata: null },
      { created: NOW - 10 },
    ];
    expect(wasStoppedBilledRecently(txns, NOW, 300)).toBe(false);
  });

  it("returns false for an empty transaction list", () => {
    expect(wasStoppedBilledRecently([], NOW, 300)).toBe(false);
  });

  it("detects a duplicate among a mix of recent transactions", () => {
    const txns = [
      { created: NOW - 5, metadata: { billing_type: "pod_usage" } },
      { created: NOW - 120, metadata: { billing_type: "stopped_reservation" } },
      { created: NOW - 5, metadata: { billing_type: "storage" } },
    ];
    expect(wasStoppedBilledRecently(txns, NOW, 300)).toBe(true);
  });
});
