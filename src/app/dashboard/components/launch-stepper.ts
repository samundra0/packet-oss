/**
 * Pure navigation logic for the GPU launch stepper (LaunchGPUModal).
 *
 * The modal has three steps: 1 = GPU Type (category), 2 = Product + Region,
 * 3 = Configure. Some entry points start the user partway through and must
 * prevent navigating back past where it makes sense:
 *
 *  - Deploying a paid monthly subscription locks the product, so the GPU-type
 *    step is meaningless and must be unreachable (floor at 2).
 *  - Legacy catalogs with no categories never render step 1 (floor at 2).
 *  - Normal browse / soft deeplinks allow full back navigation (floor at 1).
 *
 * Keeping this in one place lets every navigation path (the footer Back button
 * and the step-indicator pills) share a single floor, so the "locked deploy can
 * still reach the category picker" state is structurally unreachable.
 */

export type LaunchStep = 1 | 2 | 3;

export interface StepFloorInput {
  /** Set when deploying against a specific paid monthly subscription. */
  lockedProductId?: string;
  /** Whether the GPU-type/category step is present (category-based catalog). */
  hasCategories: boolean;
}

/** The lowest step the user may navigate back to. */
export function deriveMinStep({ lockedProductId, hasCategories }: StepFloorInput): LaunchStep {
  // Locked deploy: product is fixed, category step is meaningless -> floor at 2.
  // Legacy (no categories): step 1 never renders -> floor at 2.
  // Otherwise (browse / soft deeplink): full back navigation -> floor at 1.
  return lockedProductId || !hasCategories ? 2 : 1;
}

/** Clamp a requested step into [minStep, 3] — the single source of truth for step changes. */
export function clampStep(requested: number, minStep: LaunchStep): LaunchStep {
  return Math.min(3, Math.max(minStep, requested)) as LaunchStep;
}

/**
 * Result of pressing the footer Back/Cancel button: the step to move to, or
 * "close" when already at/below the floor.
 */
export function backAction(step: LaunchStep, minStep: LaunchStep): LaunchStep | "close" {
  return step > minStep ? clampStep(step - 1, minStep) : "close";
}
