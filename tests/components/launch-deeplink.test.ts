import { describe, it, expect } from "vitest";
import { resolveLaunchDeeplink } from "@/app/dashboard/components/launch-deeplink";

describe("resolveLaunchDeeplink (?gpu=&plan= contract)", () => {
  it("routes a bare gpu slug to the hourly stepper with the category", () => {
    expect(resolveLaunchDeeplink("?gpu=b200")).toEqual({ kind: "hourly", categorySlug: "b200" });
  });

  it("routes gpu + plan=hourly to the hourly stepper", () => {
    expect(resolveLaunchDeeplink("?gpu=rtx-pro-6000&plan=hourly")).toEqual({
      kind: "hourly",
      categorySlug: "rtx-pro-6000",
    });
  });

  it("routes plan=monthly to the monthly modal, carrying the category for filtering", () => {
    expect(resolveLaunchDeeplink("?gpu=b200&plan=monthly")).toEqual({
      kind: "monthly",
      categorySlug: "b200",
    });
  });

  it("routes plan=monthly with no gpu to the monthly modal (flat)", () => {
    expect(resolveLaunchDeeplink("?plan=monthly")).toEqual({ kind: "monthly", categorySlug: undefined });
  });

  it("routes plan=hourly with no gpu to the hourly stepper (no pre-select)", () => {
    expect(resolveLaunchDeeplink("?plan=hourly")).toEqual({ kind: "hourly", categorySlug: undefined });
  });

  it("returns none when there is no launch intent", () => {
    expect(resolveLaunchDeeplink("?tab=billing")).toEqual({ kind: "none" });
    expect(resolveLaunchDeeplink("")).toEqual({ kind: "none" });
  });

  it("accepts a URLSearchParams instance as well as a string", () => {
    expect(resolveLaunchDeeplink(new URLSearchParams({ gpu: "h100" }))).toEqual({
      kind: "hourly",
      categorySlug: "h100",
    });
  });
});
