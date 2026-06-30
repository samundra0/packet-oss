import { describe, it, expect } from "vitest";
import { sanitizeScenarioName } from "@/lib/scenarios";

// HAI rejects scenario names with characters outside
// [letters, numbers, spaces, underscores, hyphens] — e.g. the ":" in the old
// `Packet GPU: ${name}` template caused "invalid scenario name" (code 12230001).
describe("sanitizeScenarioName", () => {
  it("strips the colon that broke category scenario creation", () => {
    const out = sanitizeScenarioName("Packet GPU: L4");
    expect(out).not.toContain(":");
    expect(out).toMatch(/^[A-Za-z0-9 _-]+$/);
  });

  it("replaces arbitrary invalid characters from a category name", () => {
    const out = sanitizeScenarioName("Packet GPU - L4 (24GB) @datacenter#1");
    expect(out).toMatch(/^[A-Za-z0-9 _-]+$/);
    expect(out).toContain("L4");
    expect(out).toContain("24GB");
  });

  it("keeps already-valid names intact (letters, numbers, spaces, _ and -)", () => {
    expect(sanitizeScenarioName("Packet GPU - A100_80GB")).toBe("Packet GPU - A100_80GB");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeScenarioName("  Packet   GPU  ")).toBe("Packet GPU");
  });
});
