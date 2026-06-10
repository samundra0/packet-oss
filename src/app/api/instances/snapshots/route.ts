import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { prisma } from "@/lib/prisma";
import { gatePermission } from "@/lib/auth/gate";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";

// GET - List all snapshots for the authenticated customer
export async function GET(request: NextRequest) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    // PA-175: scope to operating account so invited members see team snapshots.
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // PA-202 gate: Snapshots hidden from Read-only Member + Finance Manager.
    const denial = await gatePermission({
      payload,
      accountId: ctx.accountId,
      customerEmail: typeof ctx.customer.email === "string" ? ctx.customer.email : null,
      permission: "snapshots.manage",
      request,
    });
    if (denial) return denial;

    // Get all snapshots for this customer, ordered by creation date (newest first)
    const snapshots = await prisma.podSnapshot.findMany({
      where: { stripeCustomerId: ctx.accountId },
      orderBy: { createdAt: "desc" },
    });

    // Transform for API response
    const formattedSnapshots = snapshots.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      notes: s.notes,
      snapshotType: s.snapshotType,
      poolId: s.poolId,
      poolName: s.poolName,
      vgpus: s.vgpus,
      // hasStorage is true if we have either a volume ID or a volume name (for legacy snapshots)
      hasStorage: s.snapshotType === "full" && (s.persistentVolumeId !== null || s.persistentVolumeName !== null),
      // Return storage info if we have ID or name
      storage: (s.persistentVolumeId || s.persistentVolumeName)
        ? {
            id: s.persistentVolumeId,
            name: s.persistentVolumeName,
            sizeGb: s.persistentVolumeSize,
          }
        : null,
      hfModel: s.hfItemId
        ? {
            id: s.hfItemId,
            name: s.hfItemName,
            type: s.hfItemType,
            deployScript: s.deployScript,
          }
        : null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    return NextResponse.json({
      success: true,
      snapshots: formattedSnapshots,
      count: formattedSnapshots.length,
    });
  } catch (error) {
    console.error("List snapshots error:", error);
    return NextResponse.json(
      { error: "Failed to list snapshots" },
      { status: 500 }
    );
  }
}
