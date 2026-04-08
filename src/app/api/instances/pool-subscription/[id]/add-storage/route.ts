import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { getStripe } from "@/lib/stripe";
import {
  getUnifiedInstanceDetail,
  getSharedVolumes,
  getSharedStorageBlocks,
  createSharedVolume,
  podVolumeAction,
} from "@/lib/hostedai";
import Stripe from "stripe";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET - Get storage info for an instance: attached volumes, available volumes, block sizes
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id: instanceId } = await context.params;
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

    // Get instance details (region, attached volumes)
    const instance = await getUnifiedInstanceDetail(instanceId);
    if (!instance) {
      return NextResponse.json({ error: "Instance not found" }, { status: 404 });
    }

    const regionId = instance.region?.id;
    if (!regionId) {
      return NextResponse.json({ error: "Could not determine instance region" }, { status: 400 });
    }

    // Attached volume IDs to exclude from available list
    const attachedVolumeIds = new Set(
      (instance.shared_volumes || []).map((v) => v.id)
    );

    // Fetch team volumes and block sizes in parallel
    const [teamVolumes, storageBlocks] = await Promise.all([
      getSharedVolumes(teamId).catch(() => []),
      getSharedStorageBlocks(regionId, teamId).catch(() => []),
    ]);

    // Available = same region, not already attached, status AVAILABLE
    const availableVolumes = teamVolumes
      .filter(
        (v) =>
          v.region_id === regionId &&
          !attachedVolumeIds.has(v.id) &&
          v.status?.toUpperCase() === "AVAILABLE"
      )
      .map((v) => ({
        id: v.id,
        name: v.name,
        size_in_gb: v.size_in_gb,
        mount_point: v.mount_point,
        cost: v.cost,
      }));

    return NextResponse.json({
      instanceId,
      regionId,
      attachedVolumes: instance.shared_volumes || [],
      availableVolumes,
      storageBlocks: [...storageBlocks].sort((a, b) => a.size - b.size),
      hasSharedStorageSupport: instance.region?.has_shared_storage_support ?? true,
    });
  } catch (error) {
    console.error("Get storage options error:", error);
    const msg = error instanceof Error ? error.message : "Failed to get storage options";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST - Attach a volume to a running instance or create + attach
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id: instanceId } = await context.params;
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
    const { volume_id, storage_block_id } = body;

    if (!volume_id && !storage_block_id) {
      return NextResponse.json(
        { error: "Either volume_id (attach existing) or storage_block_id (create new) is required" },
        { status: 400 }
      );
    }

    // Get instance to verify ownership and get region
    const instance = await getUnifiedInstanceDetail(instanceId);
    if (!instance) {
      return NextResponse.json({ error: "Instance not found" }, { status: 404 });
    }

    // Verify instance belongs to this team
    if (instance.team?.id !== teamId) {
      return NextResponse.json({ error: "Instance not found" }, { status: 404 });
    }

    const regionId = instance.region?.id;
    if (!regionId) {
      return NextResponse.json({ error: "Could not determine instance region" }, { status: 400 });
    }

    let attachVolumeId: number;

    if (volume_id) {
      // Attach existing volume — verify it belongs to this team and is available
      const teamVolumes = await getSharedVolumes(teamId);
      const vol = teamVolumes.find((v) => v.id === Number(volume_id));
      if (!vol) {
        return NextResponse.json({ error: "Volume not found or does not belong to your team" }, { status: 404 });
      }
      if (vol.region_id !== regionId) {
        return NextResponse.json({ error: "Volume is in a different region than the instance" }, { status: 400 });
      }
      if (vol.status?.toUpperCase() !== "AVAILABLE") {
        return NextResponse.json({ error: `Volume is not available (status: ${vol.status})` }, { status: 400 });
      }
      attachVolumeId = vol.id;
    } else {
      // Create new volume then attach
      const volumeName = `${instance.name}-storage-${Date.now()}`;
      const volume = await createSharedVolume({
        team_id: teamId,
        region_id: regionId,
        name: volumeName,
        storage_block_id,
      });
      attachVolumeId = volume.id;
      console.log(`[AddStorage] Created volume ${volume.id} (${volume.name}) for instance ${instanceId}`);
    }

    // Attach volume to running instance
    console.log(`[AddStorage] Attaching volume ${attachVolumeId} to instance ${instanceId}`);
    await podVolumeAction(instanceId, "attach_volume", [attachVolumeId]);

    return NextResponse.json({
      success: true,
      volume_id: attachVolumeId,
      message: "Storage volume is being attached. The GPU will restart briefly.",
    });
  } catch (error) {
    console.error("Add storage error:", error);
    const msg = error instanceof Error ? error.message : "Failed to add storage";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
