/**
 * Shared Volumes API
 *
 * Manage independent persistent storage volumes that survive pod termination.
 * Volumes can be attached to new pods to preserve data across deployments.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { getStripe } from "@/lib/stripe";
import { getSharedVolumes, deleteSharedVolume, createSharedVolume } from "@/lib/hostedai";
import { prisma } from "@/lib/prisma";
import Stripe from "stripe";

// GET - List all shared volumes for the customer
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

    // Get customer to find team ID
    const stripe = await getStripe();
    const customer = (await stripe.customers.retrieve(
      payload.customerId
    )) as Stripe.Customer;

    const teamId = customer.metadata?.hostedai_team_id;
    if (!teamId) {
      return NextResponse.json(
        { error: "No team associated with this account" },
        { status: 400 }
      );
    }

    // Get all shared volumes for this team
    const volumes = await getSharedVolumes(teamId);

    // HAI returns uppercase statuses (IN_USE, AVAILABLE) — normalize for the frontend
    const normalizeVolumeStatus = (status: string): string => {
      const s = status?.toUpperCase();
      if (s === "IN_USE") return "attached";
      if (s === "AVAILABLE") return "available";
      return status?.toLowerCase() || "unknown";
    };

    return NextResponse.json({
      volumes: volumes.map((v) => {
        const status = normalizeVolumeStatus(v.status);
        return {
          id: v.id,
          name: v.name,
          size_in_gb: v.size_in_gb,
          region_id: v.region_id,
          status,
          mount_point: v.mount_point,
          // Ensure cost is always a number (API may return string or null)
          cost: v.cost != null ? parseFloat(String(v.cost)) || 0 : 0,
          // Add helpful display info
          displaySize: `${v.size_in_gb}GB`,
          isAvailable: status === "available" || status === "attached",
        };
      }),
    });
  } catch (error) {
    console.error("List shared volumes error:", error);
    return NextResponse.json(
      { error: "Failed to list shared volumes" },
      { status: 500 }
    );
  }
}

// POST - Create a new shared volume
export async function POST(request: NextRequest) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
    }

    const stripe = await getStripe();
    const customer = (await stripe.customers.retrieve(payload.customerId)) as Stripe.Customer;
    const teamId = customer.metadata?.hostedai_team_id;
    if (!teamId) {
      return NextResponse.json({ error: "No team associated with this account" }, { status: 400 });
    }

    const body = await request.json();
    const { name, region_id, storage_block_id } = body;

    if (!name || !region_id || !storage_block_id) {
      return NextResponse.json(
        { error: "name, region_id, and storage_block_id are required" },
        { status: 400 }
      );
    }

    const volume = await createSharedVolume({
      team_id: teamId,
      region_id: Number(region_id),
      name,
      storage_block_id,
    });

    console.log(`[SharedVolumes] Created volume ${volume.id} (${volume.name}) for team ${teamId}`);

    return NextResponse.json({ volume });
  } catch (error) {
    console.error("Create shared volume error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to create volume";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

// DELETE - Delete a shared volume by ID
export async function DELETE(request: NextRequest) {
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

    // Get volume ID from request body
    const body = await request.json();
    const { volume_id, dryRun } = body;

    if (!volume_id) {
      return NextResponse.json(
        { error: "volume_id is required" },
        { status: 400 }
      );
    }

    // Get customer to find team ID
    const stripe = await getStripe();
    const customer = (await stripe.customers.retrieve(
      payload.customerId
    )) as Stripe.Customer;

    const teamId = customer.metadata?.hostedai_team_id;
    if (!teamId) {
      return NextResponse.json(
        { error: "No team associated with this account" },
        { status: 400 }
      );
    }

    // Verify the volume belongs to this team before deleting
    const volumes = await getSharedVolumes(teamId);
    const volumeToDelete = volumes.find((v) => v.id === volume_id);

    if (!volumeToDelete) {
      return NextResponse.json(
        { error: "Volume not found or does not belong to your team" },
        { status: 404 }
      );
    }

    // Check if volume is attached to an active pod
    // HAI returns uppercase statuses (IN_USE, AVAILABLE) — check case-insensitively
    const rawStatus = volumeToDelete.status?.toUpperCase();
    if (rawStatus === "IN_USE" || rawStatus === "ATTACHED") {
      return NextResponse.json(
        {
          error:
            "Cannot delete an attached volume. Please detach it from any running pods first.",
        },
        { status: 400 }
      );
    }

    // Check for snapshots that reference this volume
    const affectedSnapshots = await prisma.podSnapshot.findMany({
      where: {
        stripeCustomerId: payload.customerId,
        persistentVolumeId: volume_id,
      },
      select: {
        id: true,
        displayName: true,
      },
    });

    // dryRun: return snapshot info without performing any deletion
    if (dryRun) {
      return NextResponse.json({
        success: true,
        affectedSnapshots: affectedSnapshots.map((s) => ({
          id: s.id,
          name: s.displayName,
        })),
      });
    }

    const { deleteSnapshots } = body;

    // If there are affected snapshots and caller hasn't confirmed deletion
    if (affectedSnapshots.length > 0 && !deleteSnapshots) {
      return NextResponse.json({
        success: false,
        requiresConfirmation: true,
        affectedSnapshots: affectedSnapshots.map((s) => ({
          id: s.id,
          name: s.displayName,
        })),
        message: `This volume is referenced by ${affectedSnapshots.length} snapshot${affectedSnapshots.length === 1 ? "" : "s"}. Deleting it will also delete those snapshots.`,
      }, { status: 409 });
    }

    // Delete affected snapshots first
    if (affectedSnapshots.length > 0) {
      await prisma.podSnapshot.deleteMany({
        where: {
          id: { in: affectedSnapshots.map((s) => s.id) },
        },
      });
      console.log(
        `[SharedVolumes] Deleted ${affectedSnapshots.length} snapshot(s) referencing volume ${volume_id}`
      );
    }

    // Delete the volume
    await deleteSharedVolume(volume_id);

    // Verify the volume was actually deleted — HAI may return 200 without
    // actually removing an in-use volume, which would desync Packet's UI
    const volumesAfter = await getSharedVolumes(teamId);
    const stillExists = volumesAfter.find((v) => v.id === volume_id);
    if (stillExists) {
      console.error(
        `[SharedVolumes] Volume ${volume_id} still exists after DELETE (status: ${stillExists.status}) — HAI did not actually delete it`
      );
      return NextResponse.json(
        {
          error: `Volume could not be deleted (status: ${stillExists.status}). It may still be attached to a running instance.`,
        },
        { status: 409 }
      );
    }

    console.log(
      `[SharedVolumes] Deleted volume ${volume_id} (${volumeToDelete.name}) for team ${teamId}`
    );

    return NextResponse.json({
      success: true,
      message: `Volume "${volumeToDelete.name}" deleted successfully`,
      snapshotsDeleted: affectedSnapshots.length,
    });
  } catch (error) {
    console.error("Delete shared volume error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Failed to delete volume";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
