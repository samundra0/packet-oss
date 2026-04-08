import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import { getPoolSubscriptions } from "@/lib/hostedai";

export async function GET(request: NextRequest) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const now = new Date();

    // Fetch all active, non-expired announcements
    const announcements = await prisma.dashboardAnnouncement.findMany({
      where: {
        active: true,
        OR: [
          { startsAt: null, expiresAt: null },
          { startsAt: null, expiresAt: { gt: now } },
          { startsAt: { lte: now }, expiresAt: null },
          { startsAt: { lte: now }, expiresAt: { gt: now } },
        ],
      },
      orderBy: { createdAt: "desc" },
    });

    if (announcements.length === 0) {
      return NextResponse.json({ announcements: [] });
    }

    // Split by target type
    const allTarget = announcements.filter((a) => a.targetType === "all");
    const poolTarget = announcements.filter((a) => a.targetType === "pools");

    // If no pool-targeted announcements, skip the pool lookup
    if (poolTarget.length === 0) {
      return NextResponse.json({
        announcements: allTarget.map(formatAnnouncement),
      });
    }

    // Get customer's pool IDs
    const customerPoolIds = await getCustomerPoolIds(payload.customerId);

    const matchingPoolAnnouncements = poolTarget.filter((a) => {
      try {
        const targetPools: number[] = JSON.parse(a.targetPoolIds || "[]");
        return targetPools.some((poolId) => customerPoolIds.includes(poolId));
      } catch {
        return false;
      }
    });

    return NextResponse.json({
      announcements: [...allTarget, ...matchingPoolAnnouncements].map(formatAnnouncement),
    });
  } catch (err) {
    console.error("Dashboard announcements error:", err);
    return NextResponse.json({ error: "Failed to fetch announcements" }, { status: 500 });
  }
}

function formatAnnouncement(a: {
  id: string;
  title: string;
  message: string;
  displayType: string;
  dismissible: boolean;
}) {
  return {
    id: a.id,
    title: a.title,
    message: a.message,
    displayType: a.displayType,
    dismissible: a.dismissible,
  };
}

async function getCustomerPoolIds(customerId: string): Promise<number[]> {
  try {
    const stripe = await getStripe();
    const customer = await stripe.customers.retrieve(customerId);
    if ("deleted" in customer && customer.deleted) return [];

    const teamId = customer.metadata?.hostedai_team_id;
    if (!teamId) return [];

    const subscriptions = await getPoolSubscriptions(teamId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return subscriptions.map((s: any) => Number(s.pool_id)).filter((id: number) => !isNaN(id));
  } catch {
    return [];
  }
}
