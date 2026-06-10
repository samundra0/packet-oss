import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { getStripe } from "@/lib/stripe";
import { resolveAllTeamsForEmail } from "@/lib/customer-resolver";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import {
  createInstance,
  getUnifiedInstances,
  getUnifiedInstanceDetail,
  PoolSubscription,
} from "@/lib/hostedai";
import type { UnifiedInstance } from "@/lib/hostedai";
import { logGPULaunched, getFirstGpuLaunch } from "@/lib/activity";
import { sendOnboardingEvent } from "@/lib/email/onboarding-events";
import { prisma } from "@/lib/prisma";
import { sendGpuLaunchedEmail } from "@/lib/email";
import { generateCustomerToken } from "@/lib/customer-auth";
import { getWalletBalance, deductUsage, refundDeployment } from "@/lib/wallet";
import { monitorDeployStatus } from "@/lib/deploy-monitor";
import { cacheCustomer } from "@/lib/customer-cache";
// Pricing now comes from GpuProduct model, not static config
import { randomBytes } from "crypto";
import Stripe from "stripe";
import { installMetricsCollector } from "@/lib/metrics-collector";
import { gatePermission } from "@/lib/auth/gate";

// Billing constants
const MINIMUM_BILLING_MINUTES = 30; // Minimum billing period in minutes

// GET - List team instances
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

    // PA-175: resolve the OPERATING account, not just the user's own teams.
    // A Read-only / Team Member viewing their owner's team needs the
    // owner's team pods — those live on the owner's customer, not theirs.
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx || ctx.allTeamIds.length === 0) {
      return NextResponse.json(
        { error: "No team associated with this account" },
        { status: 400 }
      );
    }

    const customer = ctx.customer;
    cacheCustomer(customer).catch(() => {});
    console.log(`[Instances GET] Resolved ${payload.email}: account=${customer.id}, teams=[${ctx.allTeamIds.join(",")}]`);

    // HAI 2.2: Fetch unified instances from ALL teams in parallel
    let poolSubscriptions: PoolSubscription[] = [];
    const teamFetchResults = await Promise.all(
      ctx.allTeamIds.map(async (teamId) => {
        try {
          const result = await getUnifiedInstances(teamId);
          return result.items || [];
        } catch (error) {
          console.error(`Failed to fetch unified instances for team ${teamId}:`, error);
          return [];
        }
      })
    );

    // Convert unified instances to PoolSubscription shape for dashboard compatibility
    const allUnified = teamFetchResults.flat();
    for (const ui of allUnified) {
      poolSubscriptions.push({
        id: ui.id,
        pool_id: ui.id, // use instance id as pool_id for compatibility
        pool_name: ui.name, // instance name (user-given), not pool_name
        status: ui.status.toLowerCase(), // "Running" → "running" for card status checks
        region: ui.region ? {
          region_name: ui.region.region_name,
          city: ui.region.city,
        } : undefined,
        per_pod_info: {
          image_name: ui.pod_info?.model ? `${ui.pod_info.vendor || ""} ${ui.pod_info.model}`.trim() : undefined,
          vgpu_count: ui.pod_info?.vgpu_count || 1,
          vcpu_count: ui.instance_type?.cpu_cores,
          ram_mb: ui.instance_type?.ram_mb,
        },
        pods: [{
          pod_name: ui.name,
          pod_status: ui.status.toLowerCase(),
          gpu_count: ui.pod_info?.vgpu_count || 1,
        }],
      });
    }

    console.log(`[Instances GET] Fetched ${poolSubscriptions.length} unified instances across ${ctx.allTeamIds.length} team(s)`);

    // Fetch instance details in parallel to get shared_volumes and root_disk info
    if (poolSubscriptions.length > 0) {
      const detailResults = await Promise.all(
        poolSubscriptions.map(async (sub) => {
          try {
            return await getUnifiedInstanceDetail(String(sub.id));
          } catch {
            return null;
          }
        })
      );

      for (let i = 0; i < poolSubscriptions.length; i++) {
        const detail = detailResults[i];
        if (!detail) continue;

        const sharedVols = detail.shared_volumes || [];
        const rootDisk = detail.root_disk;

        poolSubscriptions[i].storage_details = {
          ephemeral_storage_gb: rootDisk?.size_gb,
          shared_volumes: sharedVols.map((v) => ({
            id: String(v.id),
            name: v.name,
            size_in_gb: v.size_in_gb,
            mount_point: v.mount_point,
            mount_status: v.mount_status,
            mount_operation: v.mount_operation,
          })),
        };

        // Backfill CPU/RAM from detail if not already set from list response
        if (detail.instance_type && !poolSubscriptions[i].per_pod_info?.vcpu_count) {
          poolSubscriptions[i].per_pod_info = {
            ...poolSubscriptions[i].per_pod_info,
            vcpu_count: detail.instance_type.cpu_cores,
            ram_mb: detail.instance_type.ram_mb,
          };
        }

        // PA-183: the LIST endpoint's pod_info often omits vgpu_count (or
        // reports 1 while the instance is still Pending), so a multi-GPU
        // instance renders as "1 GPU". The DETAIL endpoint carries the real
        // provisioned count — backfill it here so the card shows e.g. "2 GPU".
        const detailVgpu = detail.pod_info?.vgpu_count;
        if (typeof detailVgpu === "number" && detailVgpu > 0) {
          poolSubscriptions[i].per_pod_info = {
            ...poolSubscriptions[i].per_pod_info,
            vgpu_count: detailVgpu,
          };
          if (poolSubscriptions[i].pods?.[0]) {
            poolSubscriptions[i].pods![0].gpu_count = detailVgpu;
          }
        }
      }
    }

    // Fetch pod metadata for unified instances
    const instanceIds = poolSubscriptions.map(s => String(s.id));
    type MetaValue = { displayName: string | null; notes: string | null; hourlyRate?: number; startupScriptStatus?: string | null; stripeSubscriptionId?: string; billingType?: string; deployStatus?: string | null; deployStatusReason?: string | null };
    let podMetadata: Record<string, MetaValue> = {};
    let hfDeployments: Record<string, {
      id: string;
      hfItemId: string;
      hfItemName: string;
      status: string;
      errorMessage: string | null;
      createdAt: string;
      netdata?: boolean;
      netdataPort?: number | null;
      openWebUI?: boolean;
      webUiPort?: number | null;
    }> = {};

    if (instanceIds.length > 0) {
      try {
        // Fetch metadata by instanceId or subscriptionId (legacy records may use subscriptionId = instance id)
        const metadata = await prisma.podMetadata.findMany({
          where: {
            OR: [
              { instanceId: { in: instanceIds } },
              { subscriptionId: { in: instanceIds } },
            ],
          },
        });
        // Tie-breaker for the (rare) case where multiple rows reference the
        // same HAI instance: prefer the row that has instanceId populated, then
        // the row whose subscriptionId uses the canonical "instance-" prefix,
        // then an explicit billingType. This keeps a stray reconciliation-style
        // row from overwriting a properly-deployed monthly row when both exist.
        const rowScore = (m: typeof metadata[number]) => {
          let s = 0;
          if (m.instanceId) s += 4;
          if (m.subscriptionId.startsWith("instance-")) s += 2;
          if (m.billingType) s += 1;
          return s;
        };
        const sortedMeta = [...metadata].sort((a, b) => rowScore(a) - rowScore(b));
        podMetadata = sortedMeta.reduce((acc, m) => {
          const metaValue: MetaValue = {
            displayName: m.displayName,
            notes: m.notes,
            hourlyRate: m.hourlyRateCents ? m.hourlyRateCents / 100 : undefined,
            startupScriptStatus: m.startupScriptStatus,
            stripeSubscriptionId: m.stripeSubscriptionId || undefined,
            billingType: m.billingType || undefined,
            deployStatus: m.deployStatus,
            deployStatusReason: m.deployStatusReason,
          };
          // Index by instanceId (primary key for 2.2)
          if (m.instanceId) acc[m.instanceId] = metaValue;
          // Also index by subscriptionId for records created during transition
          acc[m.subscriptionId] = metaValue;
          return acc;
        }, {} as Record<string, MetaValue>);

        // Fetch HuggingFace deployments
        const deployments = await prisma.huggingFaceDeployment.findMany({
          where: { subscriptionId: { in: instanceIds } },
          orderBy: { createdAt: 'desc' },
        });

        hfDeployments = deployments.reduce((acc, d) => {
          if (!acc[d.subscriptionId]) {
            acc[d.subscriptionId] = {
              id: d.id,
              hfItemId: d.hfItemId,
              hfItemName: d.hfItemName,
              status: d.status,
              errorMessage: d.errorMessage,
              createdAt: d.createdAt.toISOString(),
              netdata: d.netdata,
              netdataPort: d.netdataPort,
              openWebUI: d.openWebUI,
              webUiPort: d.webUiPort,
            };
          }
          return acc;
        }, {} as Record<string, { id: string; hfItemId: string; hfItemName: string; status: string; errorMessage: string | null; createdAt: string; netdata?: boolean; netdataPort?: number | null; openWebUI?: boolean; webUiPort?: number | null }>);
      } catch (error) {
        console.error("Failed to fetch pod metadata:", error);
      }
    }

    return NextResponse.json({ instances: [], poolSubscriptions, podMetadata, hfDeployments });
  } catch (error) {
    console.error("List instances error:", error);
    return NextResponse.json(
      { error: "Failed to list instances" },
      { status: 500 }
    );
  }
}

// POST - Create new instance (supports both traditional and GPUaaS pool-based creation)
export async function POST(request: NextRequest) {
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

    // PA-175: resolve the OPERATING account so an invited member deploying
    // from a switched-into team targets the team Owner's customer (wallet,
    // team_id, SSH keys, predeploy lock all live there). Before this fix
    // the deploy went against the JWT user's OWN primary customer, which
    // is wrong when they're operating in a team they don't own.
    const stripe = await getStripe();
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json(
        { error: "No team associated with this account" },
        { status: 400 }
      );
    }
    const customer = ctx.customer;
    cacheCustomer(customer).catch(() => {});
    const teamId = customer.metadata?.hostedai_team_id;
    if (!teamId) {
      return NextResponse.json(
        { error: "No team associated with this account" },
        { status: 400 }
      );
    }

    // PA-175 gate: provisioning a new GPU requires gpu.provision on the
    // OPERATING team (not the JWT user's own customer).
    const denial = await gatePermission({
      payload,
      accountId: ctx.accountId,
      customerEmail: typeof customer.email === "string" ? customer.email : null,
      permission: "gpu.provision",
      request,
    });
    if (denial) return denial;

    const body = await request.json();
    const {
      name,
      pool_id,
      product_id, // GPU product ID for per-product pricing
      instance_type_id,
      // GPUaaS fields
      ephemeral_storage_block_id,
      persistent_storage_block_id, // Create new volume with this storage block (legacy)
      new_storage_block_id, // Create new volume with this block (from launch modal)
      existing_shared_volume_id, // Attach existing shared volume by ID
      shared_volume_ids, // Pre-created shared volume IDs to attach
      image_uuid,
      vgpus,
      startup_script, // Custom startup script to run after pod starts
      startup_script_preset_id, // Preset ID for automatic port exposure
      // Monthly subscription fields
      billingType, // "monthly" for subscription-based deploy
      stripeSubscriptionId, // Stripe subscription ID for monthly deploys
      // Region (HAI 2.2 unified instances)
      region_id,
      // Legacy fields for traditional instance creation
      service_id,
      image_hash_id,
      storage_block_id
    } = body;

    if (!name) {
      return NextResponse.json(
        { error: "Instance name is required" },
        { status: 400 }
      );
    }

    // ============================================================
    // HAI 2.2 UNIFIED INSTANCE CREATION
    // When the GpuProduct has a serviceId, use the unified create-instance API
    // instead of the legacy pool subscription flow.
    // ============================================================
    if (product_id) {
      const gpuProduct = await prisma.gpuProduct.findUnique({
        where: { id: product_id },
      });

      if (gpuProduct?.serviceId) {
        return await handleUnifiedInstanceCreate({
          request,
          body,
          gpuProduct,
          teamId,
          customer,
          payload,
          stripe: await getStripe(),
        });
      }
    }

    // All instances require a product with a linked HAI service
    return NextResponse.json(
      { error: "A GPU product with a linked HAI service is required for instance creation." },
      { status: 400 }
    );

  } catch (error) {
    console.error("Create instance error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to create instance";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

// Metrics collector and startup script runner are imported from shared modules
import { runStartupScript } from "@/lib/startup-script-runner";
import { WORKSPACE_SETUP_SCRIPT } from "@/lib/startup-scripts";


// ============================================================
// HAI 2.2 Unified Instance Creation Handler
// Uses create-instance API instead of pool subscription
// ============================================================

interface UnifiedCreateParams {
  request: NextRequest;
  body: Record<string, unknown>;
  gpuProduct: {
    id: string;
    name: string;
    serviceId: string | null;
    pricePerHourCents: number;
    billingType: string;
    stripePriceId: string | null;
  };
  teamId: string;
  customer: Stripe.Customer;
  payload: { email: string; customerId: string };
  stripe: Stripe;
}

async function handleUnifiedInstanceCreate({
  body,
  gpuProduct,
  teamId,
  customer,
  payload,
  stripe,
}: UnifiedCreateParams): Promise<NextResponse> {
  const {
    name,
    region_id,
    instance_type_id,
    image_uuid,
    image_hash_id,
    storage_block_id,
    persistent_storage_block_id,
    new_storage_block_id,
    existing_shared_volume_id,
    shared_volume_ids, // Pre-created shared volume IDs to attach via pod_opts
    startup_script,
    startup_script_preset_id,
    billingType: requestedBillingType,
    stripeSubscriptionId,
    app_service_id, // Optional: app's service (carries recipe). If set, used for create-instance instead of product's service.
    ssh_key_ids, // Optional: saved SSH key IDs to bake into the instance at deploy time
  } = body as Record<string, string | number | boolean | number[] | string[] | undefined>;

  // Product's service — used for provisioning-info, compatible-pools, region checks
  const serviceId = gpuProduct.serviceId!;
  // Instance creation service — either the app's service (recipe) or the product's service (bare GPU)
  const createServiceId = (app_service_id as string) || serviceId;
  const gpuCount = 1; // Unified instances are single-GPU
  const resolvedRegionId = typeof region_id === "number" ? region_id : Number(region_id) || 0;
  if (!resolvedRegionId) {
    return NextResponse.json(
      { error: "Region is required. Please select a region and try again." },
      { status: 400 }
    );
  }

  // DEPLOYMENT LOCK
  const lockKey = "deploy_lock";
  const lockTimestamp = customer.metadata?.[lockKey];
  const now = Math.floor(Date.now() / 1000);

  if (lockTimestamp) {
    const lockTime = parseInt(lockTimestamp, 10);
    if (now - lockTime < 60) {
      return NextResponse.json(
        { error: "Another GPU deployment is in progress. Please wait a moment." },
        { status: 429 }
      );
    }
  }

  try {
    await stripe.customers.update(customer.id, {
      metadata: { ...customer.metadata, [lockKey]: now.toString() },
    });
  } catch (lockErr) {
    console.error("[Billing] Failed to acquire lock:", lockErr);
  }

  const clearDeployLock = async () => {
    try {
      const fresh = await stripe.customers.retrieve(customer.id) as Stripe.Customer;
      cacheCustomer(fresh).catch(() => {});
      const meta = { ...fresh.metadata };
      delete meta[lockKey];
      const unlocked = await stripe.customers.update(customer.id, { metadata: meta });
      cacheCustomer(unlocked as Stripe.Customer).catch(() => {});
    } catch (e) {
      console.error("[Billing] Failed to release lock:", e);
    }
  };

  // Tracks the wallet pre-charge so the outer catch can refund if anything
  // throws between deductUsage and the createInstance try/catch — e.g. the
  // SSH key DB lookup at lines ~700-717 (PA-158 secondary gap).
  let prechargedCents = 0;

  try {
    // Use provisioning-info to get locked defaults from the service
    // This replaces 3 separate calls (instance types, images, storage)
    const { getServiceProvisioningInfo, getServiceCompatibleGPUPools, getTeamWorkspaces } = await import("@/lib/hostedai");

    let selectedInstanceType = instance_type_id as string | undefined;
    let selectedImage = (image_hash_id || image_uuid) as string | undefined;
    let selectedStorage = storage_block_id as string | undefined;
    let selectedPoolId: number | undefined;
    let workspaceId: string | undefined;

    // Fetch the team's default workspace (required for create-instance)
    try {
      const workspaces = await getTeamWorkspaces(teamId);
      if (workspaces.length > 0) {
        workspaceId = workspaces[0].id;
        console.log(`[HAI 2.2] Using workspace: ${workspaces[0].name} (${workspaceId})`);
      }
    } catch (wsErr) {
      console.error("[HAI 2.2] Failed to fetch workspaces:", wsErr);
    }

    // Get provisioning info (locked defaults) from the product's service
    if (!selectedInstanceType || !selectedImage || !selectedStorage) {
      try {
        const provInfo = await getServiceProvisioningInfo(serviceId, teamId, resolvedRegionId);
        // Response shape: { instance_type_details: { default: { id } }, image_details: { default: { hash } }, storage_block_details: { default: { id } } }
        const itDetails = provInfo.instance_type_details as { default?: { id: string } } | undefined;
        const imgDetails = provInfo.image_details as { default?: { hash?: string; id?: string } } | undefined;
        const sbDetails = provInfo.storage_block_details as { default?: { id: string } } | undefined;

        if (!selectedInstanceType && itDetails?.default?.id) {
          selectedInstanceType = itDetails.default.id;
          console.log(`[HAI 2.2] From provisioning-info: instance_type=${selectedInstanceType}`);
        }
        if (!selectedImage && imgDetails?.default) {
          selectedImage = imgDetails.default.hash || imgDetails.default.id;
          console.log(`[HAI 2.2] From provisioning-info: image=${selectedImage}`);
        }
        if (!selectedStorage && sbDetails?.default?.id) {
          selectedStorage = sbDetails.default.id;
          console.log(`[HAI 2.2] From provisioning-info: storage=${selectedStorage}`);
        }
      } catch (provErr) {
        console.error("[HAI 2.2] Provisioning-info failed:", provErr);
        // Service must have locked defaults via provisioning-info — no fallback
      }
    }

    if (!selectedInstanceType || !selectedImage || !selectedStorage) {
      await clearDeployLock();
      return NextResponse.json(
        { error: "Could not resolve instance configuration. The service may not be fully configured." },
        { status: 400 }
      );
    }

    // Get compatible pool from HAI (replaces selectOptimalPool)
    try {
      const pools = await getServiceCompatibleGPUPools(serviceId, teamId, resolvedRegionId);
      if (pools.length > 0) {
        // Pick pool with most available vGPUs
        const sorted = [...pools].sort((a, b) => (b.available_vgpus || 0) - (a.available_vgpus || 0));
        selectedPoolId = sorted[0].id;
        console.log(`[HAI 2.2] Selected pool: ${sorted[0].name} (id=${selectedPoolId}, available=${sorted[0].available_vgpus})`);
      }
    } catch (poolErr) {
      console.error("[HAI 2.2] Compatible pools lookup failed:", poolErr);
      // Pool selection is optional — HAI will auto-select if service has gpu_pool_locked
    }

    // Handle persistent storage — attach shared volumes via pod_opts.shared_volumes
    const sharedVolumes: number[] = [];

    if (shared_volume_ids && Array.isArray(shared_volume_ids) && (shared_volume_ids as number[]).length > 0) {
      // Frontend already created the volume(s) — just attach them
      sharedVolumes.push(...(shared_volume_ids as number[]));
      console.log("[HAI 2.2] Attaching pre-created shared volumes:", sharedVolumes);
    } else if (existing_shared_volume_id) {
      // Attach an existing shared volume by ID
      sharedVolumes.push(Number(existing_shared_volume_id));
      console.log("[HAI 2.2] Attaching existing shared volume:", existing_shared_volume_id);
    } else if (new_storage_block_id || persistent_storage_block_id) {
      // Create a new volume, wait for it to become ready, then attach
      const blockId = String(new_storage_block_id || persistent_storage_block_id);
      try {
        const { createSharedVolume, getSharedVolumes } = await import("@/lib/hostedai");
        const volumeName = `${name}-storage-${Date.now()}`;
        const volume = await createSharedVolume({
          team_id: teamId,
          region_id: resolvedRegionId,
          name: volumeName,
          storage_block_id: blockId,
        });
        console.log(`[HAI 2.2] Created shared volume: ${volume.id}, waiting for readiness...`);

        // Poll until volume is ready (max 60s, 3s intervals)
        let volumeReady = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          try {
            const volumes = await getSharedVolumes(teamId);
            const vol = volumes.find(v => v.id === volume.id);
            const status = (vol?.status || "").toLowerCase();
            if (status === "available" || status === "ready" || status === "active") {
              volumeReady = true;
              break;
            }
            console.log(`[HAI 2.2] Volume ${volume.id} status: ${vol?.status || "unknown"} (attempt ${attempt + 1})`);
          } catch {
            // Ignore poll errors, keep trying
          }
        }

        if (volumeReady) {
          console.log(`[HAI 2.2] Volume ${volume.id} is ready, attaching to instance`);
        } else {
          console.warn(`[HAI 2.2] Volume ${volume.id} not confirmed ready after 60s, attaching anyway`);
        }

        sharedVolumes.push(volume.id);
      } catch (err) {
        console.error("[HAI 2.2] Failed to create shared volume:", err);
        // Don't block instance creation — proceed without storage
      }
    }

    // === MONTHLY BILLING FLOW ===
    let resolvedBillingType = requestedBillingType as string | undefined;
    let resolvedStripeSubId = stripeSubscriptionId as string | undefined;

    if (!resolvedStripeSubId && gpuProduct.billingType === "monthly" && gpuProduct.stripePriceId) {
      resolvedBillingType = "monthly";
      const customerEmail = customer.email;
      if (customerEmail) {
        const allCustomers = await stripe.customers.list({ email: customerEmail, limit: 10 });
        for (const sc of allCustomers.data) {
          const subs = await stripe.subscriptions.list({ customer: sc.id, status: "active", limit: 20 });
          for (const sub of subs.data) {
            if (sub.items.data.some(item => item.price.id === gpuProduct.stripePriceId)) {
              resolvedStripeSubId = sub.id;
              break;
            }
          }
          if (resolvedStripeSubId) break;
        }
      }
      if (!resolvedStripeSubId) {
        await clearDeployLock();
        return NextResponse.json(
          { error: "No active subscription found for this monthly product." },
          { status: 400 }
        );
      }
    }

    const isMonthlyDeploy = resolvedBillingType === "monthly" && resolvedStripeSubId;

    // === WALLET CHECK (hourly only) ===
    const hourlyRateCents = gpuProduct.pricePerHourCents;
    const prepaidMinutes = MINIMUM_BILLING_MINUTES;
    const prepaidAmountCents = Math.round((prepaidMinutes / 60) * hourlyRateCents * gpuCount);
    let deployTime = new Date();
    let prepaidUntil: Date | null = null;

    if (isMonthlyDeploy) {
      // Validate Stripe subscription
      const stripeSub = await stripe.subscriptions.retrieve(resolvedStripeSubId!);
      if (stripeSub.status !== "active") {
        await clearDeployLock();
        return NextResponse.json(
          { error: "Your subscription is not active." },
          { status: 400 }
        );
      }

      // Entitlement: one pod per subscription slot (qty). Count existing pods
      // whose HAI instance is actually running; delete metadata for pods that
      // are already gone so the freed slot can be redeployed.
      const subQty = stripeSub.items.data[0]?.quantity ?? 1;
      const existingPods = await prisma.podMetadata.findMany({
        where: { stripeSubscriptionId: resolvedStripeSubId },
      });

      if (existingPods.length > 0) {
        let runningIds = new Set<string>();
        try {
          const result = await getUnifiedInstances(teamId);
          runningIds = new Set((result.items ?? []).map((i) => i.id));
        } catch {
          // On HAI lookup failure, treat all metadata as running to be safe
          runningIds = new Set(existingPods.map((p) => p.instanceId).filter((x): x is string => !!x));
        }

        const activePods = existingPods.filter((p) => p.instanceId && runningIds.has(p.instanceId));
        const stalePods = existingPods.filter((p) => !p.instanceId || !runningIds.has(p.instanceId));

        if (activePods.length >= subQty) {
          await clearDeployLock();
          const msg = subQty === 1
            ? "You already have a GPU deployed for this subscription. Terminate it first to redeploy."
            : `You already have ${activePods.length} of ${subQty} GPU(s) deployed for this subscription. Terminate one first to redeploy.`;
          return NextResponse.json({ error: msg }, { status: 409 });
        }

        // Free up stale metadata so the slot can be reused
        for (const stale of stalePods) {
          await prisma.podMetadata.delete({ where: { id: stale.id } });
        }
      }
    } else {
      // Hourly billing — check wallet and pre-charge
      if (hourlyRateCents === 0) {
        await clearDeployLock();
        return NextResponse.json(
          { error: "No valid pricing found." },
          { status: 400 }
        );
      }

      const walletBalance = await getWalletBalance(customer.id);
      if (walletBalance.availableBalance < prepaidAmountCents) {
        await clearDeployLock();
        return NextResponse.json(
          { error: `Insufficient wallet balance. Need $${(prepaidAmountCents / 100).toFixed(2)}, have $${(walletBalance.availableBalance / 100).toFixed(2)}.` },
          { status: 402 }
        );
      }

      deployTime = new Date();
      prepaidUntil = new Date(deployTime.getTime() + prepaidMinutes * 60 * 1000);
      const preDeployId = `predeploy_${customer.id}_${Date.now()}`;

      const deductResult = await deductUsage(
        customer.id,
        (prepaidMinutes / 60) * gpuCount,
        `GPU deploy: ${gpuProduct.name} @ $${(hourlyRateCents / 100).toFixed(2)}/hr`,
        hourlyRateCents,
        preDeployId
      );

      if (!deductResult.success) {
        await clearDeployLock();
        return NextResponse.json(
          { error: "Failed to process payment. Please try again." },
          { status: 402 }
        );
      }
      prechargedCents = prepaidAmountCents;
    }

    // === DEPLOY via create-instance ===
    console.log("[HAI 2.2] Creating instance:", {
      name: name as string,
      service_id: createServiceId,
      infra_service_id: serviceId !== createServiceId ? serviceId : undefined,
      region_id: resolvedRegionId,
      region_id_raw: region_id,
      instance_type_id: selectedInstanceType,
      image_hash: selectedImage,
      root_storage_type_id: selectedStorage,
      team_id: teamId,
      workspace_id: workspaceId,
      shared_volumes: sharedVolumes.length > 0 ? sharedVolumes : undefined,
    });

    // Resolve SSH key IDs to public key strings for deploy-time injection
    let publicKeys: string[] = [];
    if (Array.isArray(ssh_key_ids) && ssh_key_ids.length > 0) {
      const keyIds = (ssh_key_ids as string[]).filter(id => typeof id === "string" && id.length > 0);
      if (keyIds.length > 0) {
        const savedKeys = await prisma.sSHKey.findMany({
          where: { id: { in: keyIds }, stripeCustomerId: customer.id },
          select: { id: true, publicKey: true },
        });
        publicKeys = savedKeys.map(k => k.publicKey);
        if (savedKeys.length < keyIds.length) {
          console.warn(`[SSH Keys] ${keyIds.length - savedKeys.length} SSH key(s) not found, deploying with ${savedKeys.length} key(s)`);
        }
        if (publicKeys.length > 0) {
          console.log(`[SSH Keys] Including ${publicKeys.length} SSH key(s) in instance creation`);
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let instance: any;
    try {
      instance = await createInstance({
        name: name as string,
        service_id: createServiceId,
        region_id: resolvedRegionId,
        instance_type_id: selectedInstanceType,
        image_hash: selectedImage,
        root_storage_type_id: selectedStorage,
        team_id: teamId,
        workspace_id: workspaceId,
        ...(publicKeys.length > 0 ? { public_keys: publicKeys } : {}),
        pod_opts: {
          ...(selectedPoolId ? { pool_id: selectedPoolId } : {}),
          vgpus: 1,
          shared_volumes: sharedVolumes.length > 0 ? sharedVolumes : [],
        },
      });
    } catch (deployError) {
      if (!isMonthlyDeploy && prepaidAmountCents > 0) {
        const errMsg = deployError instanceof Error ? deployError.message : "";
        console.log(`[Billing] Deployment failed, refunding $${(prepaidAmountCents / 100).toFixed(2)}`);
        await refundDeployment(
          customer.id,
          prepaidAmountCents,
          `Refund: deployment failed - ${errMsg.slice(0, 100)}`
        );
        // Refund handled here; signal the outer catch to skip it.
        prechargedCents = 0;
      }
      await clearDeployLock();
      throw deployError;
    }

    await clearDeployLock();

    // create-instance may return the instance ID as a plain string or as { id: "..." }
    const instanceId = typeof instance === "string" ? instance : instance.id;
    const metricsToken = randomBytes(32).toString("hex");

    // Derive poolId for investor revenue attribution
    // Use selectedPoolId from compatible-pools API; sync reconciliation will backfill
    // the real HAI-confirmed pool_id if this is unavailable at deploy time
    const derivedPoolId: string | null = selectedPoolId ? String(selectedPoolId) : null;

    // Save PodMetadata with deployStatus="provisioning". The dashboard polls
    // GET /api/instances and shows a "Provisioning…" badge until the
    // background monitor flips this to "running" (or "failed_refunded" on
    // HAI-side failure — see PA-158).
    let metadataSaved = false;
    try {
      await prisma.podMetadata.create({
        data: {
          subscriptionId: `instance-${instanceId}`, // Unique placeholder for legacy compat
          instanceId,
          stripeCustomerId: customer.id,
          displayName: name as string,
          deployTime,
          prepaidUntil: isMonthlyDeploy ? null : prepaidUntil,
          prepaidAmountCents: isMonthlyDeploy ? 0 : prepaidAmountCents,
          poolId: derivedPoolId,
          productId: gpuProduct.id,
          hourlyRateCents: isMonthlyDeploy ? 0 : hourlyRateCents,
          metricsToken,
          startupScript: (startup_script as string) || null,
          startupScriptStatus: "pending",
          deployStatus: "provisioning",
          billingType: isMonthlyDeploy ? "monthly" : "hourly",
          stripeSubscriptionId: resolvedStripeSubId || null,
          sharedVolumeId: sharedVolumes[0] || null,
        },
      });
      metadataSaved = true;
      console.log(`[HAI 2.2] Saved PodMetadata for instance ${instanceId}`);

      // Install metrics collector and run startup script. Both internally
      // wait for the pod to reach "running" before doing real work, so
      // it's safe to schedule them now.
      installMetricsCollector(instanceId, teamId, metricsToken).catch((err) => {
        console.error(`[Metrics] Failed to install for ${instanceId}:`, err);
      });

      const fullStartup = WORKSPACE_SETUP_SCRIPT + "\n" + ((startup_script as string) || "");
      runStartupScript(instanceId, teamId, fullStartup, startup_script_preset_id as string | undefined).catch((err) => {
        console.error(`[Startup] Failed for ${instanceId}:`, err);
      });
    } catch (metaErr) {
      console.error("[HAI 2.2] Failed to save PodMetadata:", metaErr);
    }

    // Log wallet transaction (hourly only). The pre-charge is real regardless
    // of whether the pod ultimately runs; a refund (if any) appears as its
    // own Stripe balance transaction.
    if (!isMonthlyDeploy && prepaidAmountCents > 0) {
      await prisma.walletTransaction.create({
        data: {
          stripeCustomerId: customer.id,
          teamId,
          type: "gpu_deploy",
          amountCents: prepaidAmountCents,
          description: `GPU deploy: ${gpuProduct.name} @ $${(hourlyRateCents / 100).toFixed(2)}/hr`,
          subscriptionId: instanceId,
          poolId: derivedPoolId ? parseInt(derivedPoolId, 10) || null : null,
          gpuCount,
          hourlyRateCents,
          billingMinutes: prepaidMinutes,
          syncCycleId: `deploy_${instanceId}`,
        },
      }).catch((e) => console.error("[Billing] Failed to log WalletTransaction:", e));
    }

    // PA-158: spawn a fire-and-forget poller that watches HAI for the
    // instance to reach "running". If it never does, the monitor refunds the
    // wallet, marks PodMetadata as failed_refunded, and best-effort-deletes
    // the HAI instance. Success-side effects (email, onboarding, activity)
    // happen here on confirmation so the customer doesn't get a "GPU ready"
    // email for a deploy that ultimately failed.
    if (metadataSaved) {
      const launchedEmail = customer.email!;
      const launchedDisplayName = customer.name || customer.email?.split("@")[0] || "Unknown";
      const launchedProductName = gpuProduct.name;
      const launchedPodName = name as string;
      const launchedIsMonthly = !!isMonthlyDeploy;
      const launchedCustomerId = customer.id;
      const launchedEmailLower = payload.email;
      void (async () => {
        try {
          const result = await monitorDeployStatus({
            instanceId,
            customerId: customer.id,
            prechargedCents: isMonthlyDeploy ? 0 : prepaidAmountCents,
            isMonthlyDeploy: !!isMonthlyDeploy,
          });
          if (!result.ready) return;

          // Confirmed running — fire post-launch side effects.
          try {
            const priorLaunch = await getFirstGpuLaunch(launchedCustomerId);
            await logGPULaunched(launchedCustomerId, launchedProductName, gpuCount, launchedPodName, instanceId);
            sendOnboardingEvent({
              type: "gpu.launched",
              email: launchedEmailLower,
              name: launchedDisplayName,
              metadata: {
                "Stripe Customer ID": launchedCustomerId,
                "GPU Type": launchedProductName,
                "Pod Name": launchedPodName,
                "GPU Count": gpuCount,
                "Billing Type": launchedIsMonthly ? "monthly" : "hourly",
                "Instance ID": instanceId,
                "First GPU": !priorLaunch ? "Yes" : "No",
              },
            });
            const dashboardToken = generateCustomerToken(launchedEmailLower.toLowerCase(), launchedCustomerId);
            const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?token=${dashboardToken}`;
            await sendGpuLaunchedEmail({
              to: launchedEmail,
              customerName: launchedDisplayName,
              poolName: launchedProductName,
              gpuCount,
              dashboardUrl,
            });
          } catch (sideEffectErr) {
            console.error(`[HAI 2.2] Post-launch side effects failed for ${instanceId}:`, sideEffectErr);
          }
        } catch (monitorErr) {
          console.error(`[HAI 2.2] Background deploy monitor crashed for ${instanceId}:`, monitorErr);
        }
      })();
    }

    return NextResponse.json({
      success: true,
      instance_id: instanceId,
      deploy_status: "provisioning",
      message: isMonthlyDeploy
        ? "Monthly GPU deployment started — provisioning."
        : "GPU deployment started — provisioning.",
    });
  } catch (error) {
    await clearDeployLock();
    console.error("[HAI 2.2] Create instance error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to create instance";

    // PA-158 secondary gap: refund if the wallet was already pre-charged.
    // The inner createInstance try/catch handles its own refund; this catches
    // failures between deductUsage and that try (SSH key DB lookup, etc).
    if (prechargedCents > 0) {
      try {
        await refundDeployment(
          customer.id,
          prechargedCents,
          `Refund: deployment aborted before HAI call - ${errorMessage.slice(0, 100)}`
        );
      } catch (refundErr) {
        console.error("[Billing] Outer-catch refund failed:", refundErr);
      }
    }

    if (errorMessage.includes("Insufficient resources") || errorMessage.includes("10189007")) {
      return NextResponse.json(
        { error: "No GPUs currently available. Please try again later." },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
