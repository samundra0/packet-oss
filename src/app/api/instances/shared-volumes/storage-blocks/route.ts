/**
 * Storage Blocks API — Available block sizes for creating shared volumes
 *
 * Returns the storage block options (sizes) available in a given region.
 * Used by the LaunchGPUModal to let users pick persistent storage size.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { getStripe } from "@/lib/stripe";
import { getSharedStorageBlocks } from "@/lib/hostedai";
import Stripe from "stripe";

export async function GET(request: NextRequest) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
    }

    const regionId = request.nextUrl.searchParams.get("region_id");
    if (!regionId) {
      return NextResponse.json({ error: "region_id is required" }, { status: 400 });
    }

    const stripe = await getStripe();
    const customer = (await stripe.customers.retrieve(payload.customerId)) as Stripe.Customer;
    const teamId = customer.metadata?.hostedai_team_id;
    if (!teamId) {
      return NextResponse.json({ error: "No team associated with this account" }, { status: 400 });
    }

    const blocks = await getSharedStorageBlocks(Number(regionId), teamId);

    // Sort by size ascending
    const sorted = [...blocks].sort((a, b) => a.size - b.size);

    return NextResponse.json({ blocks: sorted });
  } catch (error) {
    console.error("Storage blocks error:", error);
    return NextResponse.json({ error: "Failed to get storage blocks" }, { status: 500 });
  }
}
