import { describe, it, expect } from "vitest";
import { sanitizeNextPath } from "@/lib/auth/safe-next";

const APP = "https://dash.packet.ai";

describe("sanitizeNextPath", () => {
  it("accepts same-origin relative paths into /dashboard with a deep-link query", () => {
    expect(sanitizeNextPath("/dashboard?gpu=b200&plan=monthly", APP)).toBe(
      "/dashboard?gpu=b200&plan=monthly",
    );
  });

  it("accepts /account paths", () => {
    expect(sanitizeNextPath("/account?invite=abc", APP)).toBe("/account?invite=abc");
    expect(sanitizeNextPath("/dashboard", APP)).toBe("/dashboard");
  });

  it("rejects scheme-relative and absolute URLs (open redirect)", () => {
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com/dashboard",
      "http://evil.com",
      "javascript:alert(1)",
      "data:text/html,x",
    ]) {
      expect(sanitizeNextPath(bad, APP)).toBeUndefined();
    }
  });

  it("rejects encoded-slash, backslash, traversal, and userinfo tricks", () => {
    for (const bad of [
      "/dashboard%2f%2fevil.com",
      "/dashboard%5c%5cevil.com",
      "/dashboard/../../admin",
      "/dashboard/..%2f..",
      "/dashboard@evil.com",
      "/dashboard\\..\\admin",
    ]) {
      expect(sanitizeNextPath(bad, APP)).toBeUndefined();
    }
  });

  it("rejects paths outside the /dashboard|/account allowlist", () => {
    expect(sanitizeNextPath("/admin", APP)).toBeUndefined();
    expect(sanitizeNextPath("/dashboardx", APP)).toBeUndefined();
    expect(sanitizeNextPath("/", APP)).toBeUndefined();
  });

  it("rejects empty, oversized, and non-string input", () => {
    expect(sanitizeNextPath("", APP)).toBeUndefined();
    expect(sanitizeNextPath("/dashboard?x=" + "a".repeat(600), APP)).toBeUndefined();
    expect(sanitizeNextPath(undefined, APP)).toBeUndefined();
    expect(sanitizeNextPath(null, APP)).toBeUndefined();
    expect(sanitizeNextPath(42 as unknown, APP)).toBeUndefined();
  });
});
