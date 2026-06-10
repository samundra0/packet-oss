// Tests for src/lib/cron-auth.ts.
//
// This gate guards 24 cron routes that mutate state unattended every night:
// wallet-refill, midnight-status-email, check-budgets, process-batches, etc.
// A regression here turns into "every cron is open to the internet" or "every
// cron is broken silently" — both are incidents.
//
// Contracts we pin:
//   * Missing CRON_SECRET env var → 500 (fail closed, not open).
//   * Three accepted credential sources: Authorization: Bearer, x-cron-secret
//     header, ?secret= query (the latter for cron-job.org compatibility).
//   * Timing-safe comparison — different-length secrets must not throw.
//   * No credential → 401, wrong credential → 401.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";

const ORIGINAL_SECRET = process.env.CRON_SECRET;
const SECRET = "cron-test-secret-1234567890";

function makeRequest({
  url = "http://localhost/api/cron/anything",
  authorization,
  xCronSecret,
}: {
  url?: string;
  authorization?: string;
  xCronSecret?: string;
} = {}) {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  if (xCronSecret) headers.set("x-cron-secret", xCronSecret);
  return new NextRequest(url, { method: "POST", headers });
}

describe("verifyCronAuth", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  describe("CRON_SECRET configuration", () => {
    it("returns 500 (fail closed) when CRON_SECRET is unset", async () => {
      delete process.env.CRON_SECRET;

      const res = verifyCronAuth(makeRequest({ xCronSecret: "anything" }));

      expect(res).not.toBeNull();
      expect(res!.status).toBe(500);
      const body = await res!.json();
      expect(body.error).toContain("not configured");
    });

    it("returns 500 (fail closed) when CRON_SECRET is empty string", async () => {
      process.env.CRON_SECRET = "";

      const res = verifyCronAuth(makeRequest({ xCronSecret: "anything" }));

      expect(res!.status).toBe(500);
    });
  });

  describe("credential acceptance", () => {
    it("accepts the secret via x-cron-secret header", () => {
      const res = verifyCronAuth(makeRequest({ xCronSecret: SECRET }));
      expect(res).toBeNull();
    });

    it("accepts the secret via Authorization: Bearer <secret>", () => {
      const res = verifyCronAuth(
        makeRequest({ authorization: `Bearer ${SECRET}` }),
      );
      expect(res).toBeNull();
    });

    it("accepts the secret via ?secret= query (cron-job.org compatibility)", () => {
      const res = verifyCronAuth(
        makeRequest({
          url: `http://localhost/api/cron/anything?secret=${SECRET}`,
        }),
      );
      expect(res).toBeNull();
    });

    it("prefers x-cron-secret over Authorization header when both are present", () => {
      // x-cron-secret has the right value, Authorization is wrong → still allow.
      const res = verifyCronAuth(
        makeRequest({
          xCronSecret: SECRET,
          authorization: "Bearer wrong-secret",
        }),
      );
      expect(res).toBeNull();
    });
  });

  describe("denial paths", () => {
    it("returns 401 when no credential is supplied", async () => {
      const res = verifyCronAuth(makeRequest());

      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
      const body = await res!.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 401 when x-cron-secret is wrong", () => {
      const res = verifyCronAuth(makeRequest({ xCronSecret: "wrong" }));
      expect(res!.status).toBe(401);
    });

    it("returns 401 when Bearer token is wrong", () => {
      const res = verifyCronAuth(
        makeRequest({ authorization: "Bearer wrong-secret" }),
      );
      expect(res!.status).toBe(401);
    });

    it("returns 401 when the query secret is wrong", () => {
      const res = verifyCronAuth(
        makeRequest({
          url: "http://localhost/api/cron/anything?secret=wrong",
        }),
      );
      expect(res!.status).toBe(401);
    });

    it("returns 401 (not 500) when provided secret has a different length than expected", () => {
      // Regression guard: timingSafeEqual throws if buffers differ in length.
      // The route code length-checks first to avoid that crash.
      const res = verifyCronAuth(
        makeRequest({ xCronSecret: "short" }), // 5 bytes vs 25
      );
      expect(res!.status).toBe(401);
    });

    it("uses timing-safe comparison so equal-length wrong values still return 401, not throw", () => {
      const sameLengthWrong = "X".repeat(SECRET.length);
      const res = verifyCronAuth(makeRequest({ xCronSecret: sameLengthWrong }));
      expect(res!.status).toBe(401);
    });
  });
});
