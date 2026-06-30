/**
 * Category Check API — On-demand compatibility + region check for a single category
 *
 * Called when user selects a GPU category in the launch modal.
 * Returns which services are deployable + compatible regions per service.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import {
  getScenarioCompatibleServices,
  getServiceCompatibleRegions,
} from "@/lib/hostedai";
import { prisma } from "@/lib/prisma";

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

    const categoryId = request.nextUrl.searchParams.get("categoryId");
    if (!categoryId) {
      return NextResponse.json({ error: "categoryId is required" }, { status: 400 });
    }

    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    const teamId = ctx?.customer.metadata?.hostedai_team_id;
    if (!teamId) {
      return NextResponse.json({ error: "No team associated" }, { status: 400 });
    }

    // Get category with its scenario
    const category = await prisma.gpuCategory.findUnique({
      where: { id: categoryId },
      select: { scenarioId: true, name: true },
    });

    if (!category) {
      return NextResponse.json({ error: "Category not found" }, { status: 404 });
    }

    // Run scenario-compatible-services for this category
    let compatibleServiceIds = new Set<string>();

    // HAI scenario-compatible-services is the ONLY source of truth for
    // product availability. No fallback — if we can't get a real HAI
    // compat check (scenarioId missing, HAI 404, network error), the
    // category surfaces as unavailable in the UI. That's the correct
    // failure mode: visible to both admin ("Pending" badge) and customer,
    // instead of silently letting deploys proceed to products HAI won't
    // actually accept.
    if (category.scenarioId) {
      try {
        const compatible = await getScenarioCompatibleServices(category.scenarioId, teamId);
        const services = Array.isArray(compatible) ? compatible : compatible?.services;
        if (Array.isArray(services)) {
          for (const svc of services) {
            compatibleServiceIds.add(svc.id);
          }
        }
        console.log(`[CategoryCheck] ${category.name}: ${compatibleServiceIds.size} compatible services`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("404") || errMsg.includes("not found")) {
          // Don't auto-null the scenarioId here — a transient HAI error or a
          // response body that merely contains "not found" would permanently
          // corrupt DB state from inside a GET handler. Admin tooling owns
          // scenarioId lifecycle (creation, re-sync).
          console.warn(`[CategoryCheck] Scenario ${category.scenarioId} not found for "${category.name}" — leaving scenarioId intact, admin should resync if this persists`);
        } else {
          console.error(`[CategoryCheck] Compat check failed for "${category.name}":`, err);
        }
        // No fallback — leave compatibleServiceIds empty so nothing is
        // falsely marked deployable.
      }
    } else {
      console.warn(`[CategoryCheck] Category "${category.name}" has no scenarioId — admin must resync via the Products tab before deploys are possible`);
    }

    // Fetch regions for each compatible service
    const serviceRegions: Record<string, Array<{ id: number; region_name: string; city?: string; country?: string; country_code?: string }>> = {};
    await Promise.all(
      [...compatibleServiceIds].map(async (serviceId) => {
        try {
          const regions = await getServiceCompatibleRegions(serviceId, teamId);
          serviceRegions[serviceId] = regions;
        } catch (err) {
          console.error(`[CategoryCheck] Failed to get regions for service ${serviceId}:`, err);
          serviceRegions[serviceId] = [];
        }
      })
    );

    return NextResponse.json({
      categoryId,
      compatibleServiceIds: [...compatibleServiceIds],
      serviceRegions,
    });
  } catch (error) {
    console.error("Category check error:", error);
    return NextResponse.json({ error: "Failed to check category" }, { status: 500 });
  }
}
