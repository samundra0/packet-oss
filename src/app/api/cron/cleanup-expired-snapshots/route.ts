import { NextResponse } from "next/server";

/**
 * POST /api/cron/cleanup-expired-snapshots
 *
 * Disabled: auto-preservation of snapshots on billing suspension has been
 * removed (PA-88). Snapshots are now manual-only and do not expire.
 */
export async function POST() {
  return NextResponse.json({ success: true, message: "Auto-preservation disabled. No cleanup required." });
}

export async function GET() {
  return POST();
}
