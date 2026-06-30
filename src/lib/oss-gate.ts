import { NextResponse } from "next/server";

// Shared response for Stripe-only features that have no OSS equivalent yet.
// These endpoints depend on Stripe (checkout, billing portal, self-service
// wallet top-up, subscription management). Rather than 500 when Stripe is
// absent, they return a friendly "under construction" payload the UI can show.

export const UNDER_CONSTRUCTION_MESSAGE =
  "This feature is currently under construction.";

export function underConstructionResponse(): NextResponse {
  return NextResponse.json(
    { error: UNDER_CONSTRUCTION_MESSAGE, code: "under_construction" },
    { status: 503 },
  );
}
