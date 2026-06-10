import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * edition.ts memoizes the resolved edition on first call, so each case loads a
 * fresh module copy (vi.resetModules + dynamic import) with the env pre-set.
 * Only EDITION / NEXT_PUBLIC_EDITION are touched, and they are restored after.
 */
const KEYS = ["EDITION", "NEXT_PUBLIC_EDITION"] as const;

async function loadEdition(env: Partial<Record<(typeof KEYS)[number], string>>) {
  vi.resetModules();
  for (const k of KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return import("@/lib/edition");
}

describe("edition", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it("defaults to pro when no edition env is set", async () => {
    const m = await loadEdition({});
    expect(m.getEdition()).toBe("pro");
    expect(m.isPro()).toBe(true);
    expect(m.isOSS()).toBe(false);
    expect(m.hasPremiumFeature("token-factory")).toBe(true);
  });

  it("is oss when EDITION=oss", async () => {
    const m = await loadEdition({ EDITION: "oss" });
    expect(m.getEdition()).toBe("oss");
    expect(m.isOSS()).toBe(true);
    expect(m.isPro()).toBe(false);
    expect(m.hasPremiumFeature("token-factory")).toBe(false);
  });

  it("is oss when NEXT_PUBLIC_EDITION=oss", async () => {
    const m = await loadEdition({ NEXT_PUBLIC_EDITION: "oss" });
    expect(m.isOSS()).toBe(true);
  });

  it("treats unknown EDITION values as pro", async () => {
    const m = await loadEdition({ EDITION: "enterprise" });
    expect(m.isPro()).toBe(true);
  });

  it("memoizes the edition after the first resolve", async () => {
    const m = await loadEdition({ EDITION: "oss" });
    expect(m.isOSS()).toBe(true);
    process.env.EDITION = "pro"; // mutate after resolution
    expect(m.isOSS()).toBe(true); // cached value wins
  });
});
