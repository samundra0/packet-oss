import { describe, it, expect } from "vitest";
import {
  deriveMinStep,
  clampStep,
  backAction,
} from "@/app/dashboard/components/launch-stepper";

describe("launch stepper navigation floor", () => {
  describe("deriveMinStep", () => {
    it("floors a locked subscription deploy at step 2 (category step unreachable)", () => {
      expect(deriveMinStep({ lockedProductId: "prod_123", hasCategories: true })).toBe(2);
    });

    it("floors legacy (no categories) at step 2", () => {
      expect(deriveMinStep({ hasCategories: false })).toBe(2);
    });

    it("allows full navigation (floor 1) for a normal browse with categories", () => {
      expect(deriveMinStep({ hasCategories: true })).toBe(1);
    });

    it("allows full navigation for a soft deeplink (no locked product)", () => {
      expect(deriveMinStep({ hasCategories: true, lockedProductId: undefined })).toBe(1);
    });
  });

  describe("clampStep", () => {
    it("never returns a step below the floor (locked cannot reach the category step)", () => {
      expect(clampStep(1, 2)).toBe(2);
      expect(clampStep(0, 2)).toBe(2);
    });

    it("never exceeds step 3", () => {
      expect(clampStep(4, 1)).toBe(3);
      expect(clampStep(99, 2)).toBe(3);
    });

    it("passes through in-range steps", () => {
      expect(clampStep(2, 1)).toBe(2);
      expect(clampStep(1, 1)).toBe(1);
    });
  });

  describe("backAction", () => {
    // Regression (PA-266/PA-267): deploying a monthly subscription opened the modal
    // locked at step 2. Pressing Back ran `step > 1 && hasCategories` and dropped the
    // user to step 1 (the GPU-type picker) while the product stayed locked — an
    // incoherent "re-pick category" state. The floor must close the modal instead.
    it("closes instead of exposing the category step when a locked deploy presses Back at step 2", () => {
      const minStep = deriveMinStep({ lockedProductId: "prod_123", hasCategories: true });
      expect(backAction(2, minStep)).toBe("close");
    });

    it("lets a locked deploy step back from configure (3) to product (2)", () => {
      expect(backAction(3, 2)).toBe(2);
    });

    it("lets a normal browse session walk back 3 -> 2 -> 1 -> close", () => {
      expect(backAction(3, 1)).toBe(2);
      expect(backAction(2, 1)).toBe(1);
      expect(backAction(1, 1)).toBe("close");
    });

    it("closes for legacy (no categories) Back at step 2", () => {
      expect(backAction(2, deriveMinStep({ hasCategories: false }))).toBe("close");
    });
  });
});
