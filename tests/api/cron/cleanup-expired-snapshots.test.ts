// Tests for src/app/api/cron/cleanup-expired-snapshots/route.ts.
//
// This cron is intentionally a no-op: PA-88 removed snapshot auto-preservation,
// so snapshots are manual-only and never expire. The contract worth pinning is
// exactly that — it stays a no-op and never touches the database — so a future
// re-activation has to consciously rewrite these expectations.

import { describe, it, expect } from "vitest";
import { GET, POST } from "@/app/api/cron/cleanup-expired-snapshots/route";

describe("POST /api/cron/cleanup-expired-snapshots", () => {
  it("returns a disabled-cleanup success message", async () => {
    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/disabled/i);
  });

  it("GET delegates to POST (manual-trigger parity)", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
