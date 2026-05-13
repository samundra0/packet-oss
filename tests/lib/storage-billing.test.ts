import { describe, it, expect } from "vitest";
import { computeStorageCharge, type StorageAccumulatorState } from "@/lib/storage-billing";

// Production rate: 0.004 cents/GB/hr ≈ $0.00004/GB/hr
const RATE_CENTS_PER_GB_HR = 0.004;
const HALF_HOUR = 0.5;

const HOUR_IN_SEC = 3600;

function emptyState(windowStartedAt: number): StorageAccumulatorState {
  return { pendingCents: 0, pendingGbHours: 0, windowStartedAt };
}

describe("computeStorageCharge — bug repro for PA-159", () => {
  it("does not bill on a single 30-min interval when raw cost is sub-cent", () => {
    // PA-159 bug: 400GB × 0.004c × 0.5h = 0.8c. Old code Math.round'd to 1c.
    // Accumulator should NOT charge yet.
    const t0 = 1_700_000_000;
    const result = computeStorageCharge(
      emptyState(t0),
      400,
      RATE_CENTS_PER_GB_HR,
      HALF_HOUR,
      t0 + 30 * 60,
    );

    expect(result.charge).toBeNull();
    expect(result.newState.pendingCents).toBeCloseTo(0.8, 6);
    expect(result.newState.windowStartedAt).toBe(t0);
  });

  it("does not over-charge tiny storage volumes (10GB → $0.292/mo, not $14.60/mo)", () => {
    // 10GB at 0.004c/GB/hr for 1 month (730h) = 29.2c expected.
    // Old code: 10GB × 0.004c × 0.5h = 0.02c → Math.round = 0 → never charges.
    // OR if rate happened to round up: $14.60/mo floor.
    // Accumulator: should accumulate exactly 29.2c over the month.
    const intervalsPerMonth = 730 * 2; // 30-min intervals in 730h month
    let state = emptyState(1_700_000_000);
    let now = 1_700_000_000;
    let totalBilled = 0;

    for (let i = 0; i < intervalsPerMonth; i++) {
      now += 30 * 60;
      const r = computeStorageCharge(state, 10, RATE_CENTS_PER_GB_HR, HALF_HOUR, now);
      if (r.charge) totalBilled += r.charge.cents;
      state = r.newState;
    }

    // Expected: 10 × 0.004 × 730 = 29.2 cents. Allow ±1c rounding floor.
    expect(totalBilled).toBeGreaterThanOrEqual(28);
    expect(totalBilled).toBeLessThanOrEqual(30);
  });

  it("flushes when accumulated cents cross 1, and carries the remainder forward", () => {
    // 400GB × 0.004c × 0.5h = 0.8c per interval.
    // After 2 intervals: 1.6c → bill 1c, carry 0.6c.
    // After 3rd interval: 0.6 + 0.8 = 1.4c → bill 1c, carry 0.4c.
    let state = emptyState(1_700_000_000);
    let now = 1_700_000_000;

    now += 30 * 60;
    const r1 = computeStorageCharge(state, 400, RATE_CENTS_PER_GB_HR, HALF_HOUR, now);
    expect(r1.charge).toBeNull();
    state = r1.newState;

    now += 30 * 60;
    const r2 = computeStorageCharge(state, 400, RATE_CENTS_PER_GB_HR, HALF_HOUR, now);
    expect(r2.charge).not.toBeNull();
    expect(r2.charge!.cents).toBe(1);
    expect(r2.newState.pendingCents).toBeCloseTo(0.6, 6);
    expect(r2.newState.windowStartedAt).toBe(now); // window resets on flush
    state = r2.newState;

    now += 30 * 60;
    const r3 = computeStorageCharge(state, 400, RATE_CENTS_PER_GB_HR, HALF_HOUR, now);
    expect(r3.charge).not.toBeNull();
    expect(r3.charge!.cents).toBe(1);
    expect(r3.newState.pendingCents).toBeCloseTo(0.4, 6);
  });
});

describe("computeStorageCharge — description content (James's ask)", () => {
  it("description includes GB, hours, true rate, and UTC window", () => {
    // Run enough intervals at 400GB to flush.
    let state = emptyState(Date.UTC(2026, 3, 29, 6, 0) / 1000);
    let now = state.windowStartedAt;

    let charge: NonNullable<ReturnType<typeof computeStorageCharge>["charge"]> | null = null;
    while (!charge) {
      now += 30 * 60;
      const r = computeStorageCharge(state, 400, RATE_CENTS_PER_GB_HR, HALF_HOUR, now);
      state = r.newState;
      charge = r.charge;
    }

    expect(charge.description).toContain("400GB");
    expect(charge.description).toContain("hrs");
    expect(charge.description).toContain("$0.000040/GB/hr"); // true rate, not $0.0000
    expect(charge.description).toContain("2026-04-29 06:00");
    expect(charge.description).toContain("UTC");
    expect(charge.description).not.toContain("$0.0000/GB/hr");
    expect(charge.description).not.toContain("rounded up");
  });

  it("computes average GB across windows where storage changed", () => {
    // 30 min at 1000GB, then 30 min at 0GB → avg should be 500GB across the window.
    // 1000 × 0.004 × 0.5 = 2c → flushes immediately on first interval.
    // Use a smaller volume so it spans 2 intervals: 100GB → 0.2c, then 1000GB → 2c. Total 2.2c.
    let state = emptyState(1_700_000_000);
    let now = 1_700_000_000;

    now += 30 * 60;
    const r1 = computeStorageCharge(state, 100, RATE_CENTS_PER_GB_HR, HALF_HOUR, now);
    expect(r1.charge).toBeNull();
    state = r1.newState;

    now += 30 * 60;
    const r2 = computeStorageCharge(state, 1000, RATE_CENTS_PER_GB_HR, HALF_HOUR, now);
    expect(r2.charge).not.toBeNull();
    // gbHours = 100×0.5 + 1000×0.5 = 550. window = 1h. avg = 550GB.
    expect(r2.charge!.avgGb).toBeCloseTo(550, 1);
    expect(r2.charge!.description).toContain("550GB avg");
  });
});

describe("computeStorageCharge — edge cases", () => {
  it("preserves window when storage is zero (no charge, no reset)", () => {
    const t0 = 1_700_000_000;
    const state: StorageAccumulatorState = {
      pendingCents: 0.5,
      pendingGbHours: 100,
      windowStartedAt: t0,
    };

    const result = computeStorageCharge(state, 0, RATE_CENTS_PER_GB_HR, HALF_HOUR, t0 + 30 * 60);

    expect(result.charge).toBeNull();
    expect(result.newState.pendingCents).toBe(0.5);
    expect(result.newState.pendingGbHours).toBe(100);
    expect(result.newState.windowStartedAt).toBe(t0);
  });

  it("handles zero rate (storage pricing disabled) without charging", () => {
    const t0 = 1_700_000_000;
    const result = computeStorageCharge(emptyState(t0), 1000, 0, HALF_HOUR, t0 + 30 * 60);

    expect(result.charge).toBeNull();
    expect(result.newState.pendingCents).toBe(0);
  });

  it("flushes on first interval when interval cost ≥ 1c (rate change scenario)", () => {
    // If admin raises rate, accumulator becomes a no-op: each interval flushes immediately.
    const t0 = 1_700_000_000;
    const highRate = 1.0; // 1 cent/GB/hr
    const result = computeStorageCharge(emptyState(t0), 100, highRate, HALF_HOUR, t0 + 30 * 60);

    // 100GB × 1c × 0.5h = 50c
    expect(result.charge).not.toBeNull();
    expect(result.charge!.cents).toBe(50);
    expect(result.newState.pendingCents).toBeCloseTo(0, 6);
  });
});
