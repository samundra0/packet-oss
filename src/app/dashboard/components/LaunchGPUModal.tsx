"use client";

import { useState, useEffect } from "react";
import { STARTUP_SCRIPT_PRESETS, type StartupScriptPreset } from "@/lib/startup-scripts";
import { deriveMinStep, clampStep, backAction } from "./launch-stepper";

// MAINTENANCE MODE — set to false when hosted.ai instance creation is fixed
const DEPLOY_MAINTENANCE = false;

// Types matching the new launch-options API response
interface LaunchProduct {
  id: string;
  name: string;
  description: string | null;
  pricePerHourCents: number;
  pricePerMonthCents: number | null;
  billingType: string;
  stripePriceId: string | null;
  serviceId: string | null;
  displayOrder: number;
  active: boolean;
  featured: boolean;
  badgeText: string | null;
  vramGb: number | null;
  cudaCores: number | null;
  categoryIds?: string[];
  gpuFamily: string | null;
  available: boolean | null; // null = not yet checked (deferred to category-check)
  regions?: Array<{ id: number; region_name: string; name?: string }>;
}

interface SharedVolume {
  id: number;
  name: string;
  size_in_gb: number;
  region_id: number;
  status: string;
  mount_point: string;
  cost: string | number;
}

interface StorageBlockOption {
  id: string;
  name: string;
  size: number;
  cost: string;
}

interface SSHKeyOption {
  id: string;
  name: string;
  fingerprint: string;
  createdAt: string;
}

interface LaunchCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  displayOrder: number;
  icon: string | null;
  scenarioConfigured: boolean;
  products: LaunchProduct[];
}

interface LaunchOptionsData {
  categories?: LaunchCategory[];
  products: LaunchProduct[];
  existingSharedVolumes: SharedVolume[];
  sshKeys: SSHKeyOption[];
  teamId: string;
  walletBalanceCents: number;
}

export interface DeployContext {
  type: "huggingface" | "app";
  title: string;              // e.g. "Deploy Mistral 7B"
  subtitle?: string;          // e.g. model description
  modelId: string;            // HF model ID
  hfToken?: string;           // pre-filled token
  isGated?: boolean;          // show token input
  openWebUI?: boolean;        // show Open WebUI checkbox
  vramGb?: number;            // model VRAM requirement (for display)
  onDeploy: (params: {
    product_id: string;
    region_id: number;
    name: string;
    hfToken?: string;
    openWebUI?: boolean;
    ssh_key_ids?: string[];
    new_storage_block_id?: string;
    existing_shared_volume_id?: number;
  }) => Promise<void>;
}

interface LaunchGPUModalProps {
  isOpen: boolean;
  onClose: () => void;
  token: string;
  customerEmail?: string;
  onSuccess: (launchInfo: { name: string; poolName: string }) => void;
  onError?: (message: string) => void;
  gpuDashboardUrl?: string | null;
  onTopup?: (amount: number, voucherCode?: string, launchProductId?: string) => void;
  topupLoading?: boolean;
  initialProductId?: string;
  /** Pre-select a GPU category by slug (deep-link). Lands the user on the
   *  product step with the family chosen; the first compatible product is
   *  auto-selected. Ignored when initialProductId/lockedProductId is set. */
  initialCategorySlug?: string;
  /** When set, the product picker is locked to this product — used when
   *  deploying against an existing monthly subscription. */
  lockedProductId?: string;
  /** Stripe subscription ID to bill the deploy against (monthly flow). */
  stripeSubscriptionId?: string;
  deployContext?: DeployContext;
}

export function LaunchGPUModal({
  isOpen,
  onClose,
  token,
  customerEmail,
  onSuccess,
  onError,
  gpuDashboardUrl,
  onTopup,
  topupLoading,
  initialProductId,
  initialCategorySlug,
  lockedProductId,
  stripeSubscriptionId,
  deployContext,
}: LaunchGPUModalProps) {
  const [loading, setLoading] = useState(true);
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [launching, setLaunching] = useState(false);
  const [launchSeconds, setLaunchSeconds] = useState(0);
  const [error, setError] = useState("");
  const [options, setOptions] = useState<LaunchOptionsData | null>(null);

  // Step state: 1 = pick category, 2 = pick product + region, 3 = configure + launch
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Form state
  const [selectedProduct, setSelectedProduct] = useState<string>("");
  const [selectedGpuFamily, setSelectedGpuFamily] = useState<string | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<number | null>(null);
  const [categoryCheckLoading, setCategoryCheckLoading] = useState(false);
  // Stores compatibility + regions per service after category-check
  const [categoryCheckResult, setCategoryCheckResult] = useState<{
    categoryId: string;
    compatibleServiceIds: string[];
    serviceRegions: Record<string, Array<{ id: number; region_name: string; city?: string; country?: string; country_code?: string }>>;
  } | null>(null);
  const [instanceName, setInstanceName] = useState(
    deployContext?.modelId
      ? deployContext.modelId.split("/").pop()?.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 30) || "gpu-instance"
      : ""
  );
  const [storageMode, setStorageMode] = useState<"none" | "create" | "existing">("none");
  const [selectedExistingVolume, setSelectedExistingVolume] = useState<number | null>(null);
  const [storageBlocks, setStorageBlocks] = useState<StorageBlockOption[]>([]);
  const [selectedStorageBlock, setSelectedStorageBlock] = useState<string>("");
  const [storageBlocksLoading, setStorageBlocksLoading] = useState(false);
  const [selectedStartupScript, setSelectedStartupScript] = useState<string>("");
  const [customScript, setCustomScript] = useState("");
  const [showCustomScript, setShowCustomScript] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showFundWallet, setShowFundWallet] = useState(false);
  const [selectedSSHKeyIds, setSelectedSSHKeyIds] = useState<Set<string>>(new Set());

  // Deploy context state (HF-specific)
  const [hfToken, setHfToken] = useState(deployContext?.hfToken || "");
  const [addOpenWebUI, setAddOpenWebUI] = useState(deployContext?.openWebUI ?? false);

  // Check category compatibility when a category is selected
  const checkCategoryAvailability = async (categoryId: string) => {
    setCategoryCheckLoading(true);
    setCategoryCheckResult(null);
    try {
      const res = await fetch(`/api/instances/category-check?categoryId=${categoryId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setCategoryCheckResult(data);
        // Auto-select first available product
        const cat = options?.categories?.find(c => c.id === categoryId);
        if (cat) {
          // Don't clobber a locked product — the user is deploying against a
          // specific subscription and must stay on that product.
          if (lockedProductId) {
            setSelectedProduct(lockedProductId);
          } else {
            const firstAvailable = cat.products
              .filter(p => data.compatibleServiceIds.includes(p.serviceId))
              .sort((a, b) => a.displayOrder - b.displayOrder)[0];
            if (firstAvailable) setSelectedProduct(firstAvailable.id);
            else setSelectedProduct("");
          }
        }
      }
    } catch (err) {
      console.error("Category check failed:", err);
    } finally {
      setCategoryCheckLoading(false);
    }
  };

  // Derive product availability and regions from category check result
  const getProductAvailability = (product: LaunchProduct) => {
    if (!categoryCheckResult) return product.available ?? false;
    return product.serviceId ? categoryCheckResult.compatibleServiceIds.includes(product.serviceId) : false;
  };

  const getProductRegions = (product: LaunchProduct) => {
    if (!categoryCheckResult || !product.serviceId) return product.regions || [];
    const byService = categoryCheckResult.serviceRegions[product.serviceId] || [];
    // Locked products (deploying against a monthly subscription) must always
    // offer at least one region. When the product's own service has no
    // regions (e.g. the monthly SKU isn't wired for direct instance creation),
    // fall back to the union of regions across every compatible service in
    // the category — the subscription-to-pool binding on the backend
    // determines where it actually lands.
    if (byService.length === 0 && lockedProductId === product.id) {
      const seen = new Set<number>();
      const union: Array<{ id: number; region_name: string; city?: string; country?: string; country_code?: string }> = [];
      for (const regions of Object.values(categoryCheckResult.serviceRegions)) {
        if (!Array.isArray(regions)) continue;
        for (const r of regions) {
          if (r && typeof r.id === "number" && !seen.has(r.id)) {
            seen.add(r.id);
            union.push(r);
          }
        }
      }
      return union;
    }
    return byService;
  };

  const selectedProductDetails = options?.products?.find((p) => p.id === selectedProduct);

  // Use categories from API if available, fall back to gpuFamily derivation
  const hasCategories = (options?.categories?.length ?? 0) > 0;

  // Lowest reachable step for this session. A locked subscription deploy (or a
  // legacy no-category catalog) must never expose the GPU-type step. All step
  // changes (footer Back + indicator pills) funnel through goToStep so the floor
  // is enforced in exactly one place.
  const minStep = deriveMinStep({ lockedProductId, hasCategories });
  const goToStep = (n: number) => setStep(clampStep(n, minStep));

  const gpuFamilies: string[] = hasCategories
    ? (options?.categories ?? []).map(c => c.name)
    : options?.products
      ? [...new Set(
          [...options.products]
            .sort((a, b) => a.displayOrder - b.displayOrder)
            .map((p) => p.gpuFamily)
            .filter((f): f is string => !!f)
        )]
      : [];

  // Products filtered to the selected GPU family/category.
  // When a product is locked (deploying against a specific subscription),
  // narrow the list to just that product. Otherwise, hide monthly-billed
  // products entirely — they can only be deployed via an existing
  // subscription entitlement (the "Deploy GPU" button on a sub card), not
  // picked from the general on-demand list.
  const filteredProducts = (() => {
    if (!options?.products) return [];
    if (lockedProductId) {
      const locked = options.products.find(p => p.id === lockedProductId);
      return locked ? [locked] : [];
    }
    const onDemand = options.products.filter(p => p.billingType !== "monthly");
    if (!selectedGpuFamily) return onDemand;
    if (hasCategories) {
      const cat = options.categories?.find(c => c.name === selectedGpuFamily);
      const list = cat ? cat.products : onDemand;
      return list.filter(p => p.billingType !== "monthly");
    }
    return onDemand.filter(p => p.gpuFamily === selectedGpuFamily);
  })();

  // Derive regions for selected product from category check result
  const selectedProductRegions = selectedProductDetails
    ? getProductRegions(selectedProductDetails)
    : [];

  // Auto-select first region when product or category check changes
  useEffect(() => {
    if (selectedProductRegions.length) {
      setSelectedRegion(selectedProductRegions[0].id);
    } else {
      setSelectedRegion(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProduct, categoryCheckResult]);

  // Fetch storage blocks when region changes — reset storage selection
  useEffect(() => {
    setStorageMode("none");
    setSelectedExistingVolume(null);
    if (!selectedRegion || !token) {
      setStorageBlocks([]);
      setSelectedStorageBlock("");
      return;
    }
    let cancelled = false;
    async function fetchStorageBlocks() {
      setStorageBlocksLoading(true);
      try {
        const res = await fetch(
          `/api/instances/shared-volumes/storage-blocks?region_id=${selectedRegion}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          setStorageBlocks(data.blocks || []);
          // Auto-select the smallest block
          if (data.blocks?.length > 0) {
            setSelectedStorageBlock(data.blocks[0].id);
          }
        }
      } catch {
        if (!cancelled) setStorageBlocks([]);
      } finally {
        if (!cancelled) setStorageBlocksLoading(false);
      }
    }
    fetchStorageBlocks();
    return () => { cancelled = true; };
  }, [selectedRegion, token]);

  // Countdown timer while loading GPU options
  useEffect(() => {
    if (!loading) {
      setLoadingSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      setLoadingSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [loading]);

  // Track elapsed time during launch
  useEffect(() => {
    if (!launching) {
      setLaunchSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      setLaunchSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [launching]);

  // Fetch launch options when modal opens
  useEffect(() => {
    if (!isOpen) return;
    async function fetchOptions() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/instances/launch-options", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          const data: LaunchOptionsData = await response.json();
          setOptions(data);

          // Auto-select all SSH keys
          if (data.sshKeys?.length > 0) {
            setSelectedSSHKeyIds(new Set(data.sshKeys.map(k => k.id)));
          }

          // With categories: start at step 1, user picks category first
          // Without categories (legacy): auto-select product like before
          if (data.categories?.length) {
            setStep(1);
            // If initialProductId or lockedProductId provided, find its
            // category and skip to step 2. Locked takes priority — it's used
            // when deploying a specific subscription entitlement.
            const preselectId = lockedProductId || initialProductId;
            if (preselectId) {
              const targetProduct = data.products?.find(p => p.id === preselectId);
              if (targetProduct?.categoryIds?.length) {
                const cat = data.categories.find(c => c.id === targetProduct.categoryIds![0]);
                if (cat) {
                  setSelectedGpuFamily(cat.name);
                  setSelectedProduct(preselectId);
                  setStep(2);
                  // Trigger category check
                  checkCategoryAvailability(cat.id);
                }
              }
            } else if (initialCategorySlug) {
              // Deep-link to a GPU category (?gpu=<slug>). Land on the product
              // step with the family chosen; leave the product empty so
              // checkCategoryAvailability auto-selects the first compatible one.
              // Unknown slug falls through to the normal step-1 picker.
              const cat = data.categories.find(c => c.slug === initialCategorySlug);
              if (cat) {
                setSelectedGpuFamily(cat.name);
                setStep(2);
                checkCategoryAvailability(cat.id);
              } else {
                console.warn("[LaunchGPU] unknown category slug:", initialCategorySlug);
              }
            }
          } else if (data.products?.length > 0) {
            // Legacy: no categories, auto-select product
            setStep(2); // skip category step
            const featured = data.products.find((p) => p.available && p.featured);
            const firstAvailable = data.products.find((p) => p.available);
            const targetProduct = featured || firstAvailable || data.products[0];
            if (targetProduct) {
              setSelectedProduct(targetProduct.id);
              if (targetProduct.gpuFamily) {
                setSelectedGpuFamily(targetProduct.gpuFamily);
              }
            }
          }
        } else {
          const errData = await response.json();
          setError(errData.error || "Failed to load GPU options");
        }
      } catch {
        setError("Failed to load GPU options");
      } finally {
        setLoading(false);
      }
    }
    fetchOptions();
  }, [isOpen, token]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setStep(1);
      setInstanceName("");
      setError("");
      setLaunching(false);
      setSelectedProduct("");
      setSelectedGpuFamily(null);
      setCategoryCheckResult(null);
      setSelectedStartupScript("");
      setCustomScript("");
      setShowCustomScript(false);
      setShowAdvanced(false);
      setShowFundWallet(false);
      setStorageMode("none");
      setSelectedExistingVolume(null);
      setStorageBlocks([]);
      setSelectedStorageBlock("");
      setSelectedSSHKeyIds(new Set());
    }
  }, [isOpen]);

  // Wallet balance check — returns true if sufficient (or monthly billing)
  const checkWalletBalance = (): boolean => {
    if (!selectedProductDetails) return false;

    // Monthly products are billed via Stripe subscription, no wallet check needed
    if (selectedProductDetails.billingType === "monthly") return true;

    const MINIMUM_BILLING_MINUTES = 30;
    const hourlyRateCents = selectedProductDetails.pricePerHourCents;
    const requiredCents = Math.round((MINIMUM_BILLING_MINUTES / 60) * hourlyRateCents * 1);
    const walletCents = options?.walletBalanceCents ?? 0;

    return requiredCents <= 0 || walletCents >= requiredCents;
  };

  const getMinimumRequired = (): string => {
    const MINIMUM_BILLING_MINUTES = 30;
    const hourlyRateCents = selectedProductDetails?.pricePerHourCents ?? 0;
    const requiredCents = Math.round((MINIMUM_BILLING_MINUTES / 60) * hourlyRateCents * 1);
    return (requiredCents / 100).toFixed(2);
  };

  const handleLaunch = async () => {
    if (!options || !selectedProduct || !instanceName.trim()) {
      setError("Please select a GPU and enter a name");
      return;
    }

    if (!selectedProductDetails || !getProductAvailability(selectedProductDetails)) {
      setError("This GPU is not currently available");
      return;
    }

    // Wallet balance gate (skip for monthly billing)
    if (!checkWalletBalance()) {
      setShowFundWallet(true);
      return;
    }

    const productName = selectedProductDetails?.name || "GPU";

    // Determine startup script
    let startupScript: string | undefined;
    let startupScriptPresetId: string | undefined;
    if (selectedStartupScript === "custom" && customScript.trim()) {
      startupScript = customScript.trim();
    } else if (selectedStartupScript) {
      const preset = STARTUP_SCRIPT_PRESETS.find((p) => p.id === selectedStartupScript);
      startupScript = preset?.script;
      startupScriptPresetId = preset?.id;
    }

    setLaunching(true);
    setError("");

    try {
      // Optimistic close — modal closes immediately
      import("@/lib/plerdy")
        .then(({ trackPlerdy, PLERDY_EVENTS }) => trackPlerdy(PLERDY_EVENTS.GPU_DEPLOYED))
        .catch(() => {});
      if (typeof (window as any).my_analytics !== "undefined") {
        (window as any).my_analytics.goal("dc2zgi7efaqu6o3h");
      }
      if (typeof (window as any).lintrk === "function") {
        (window as any).lintrk("track", { conversion_id: 24436340 });
      }
      onSuccess({ name: instanceName.trim(), poolName: productName });
      onClose();

      if (deployContext?.onDeploy) {
        // Custom deploy handler (HF, apps, etc.)
        await deployContext.onDeploy({
          product_id: selectedProduct,
          region_id: selectedRegion!,
          name: instanceName.trim(),
          hfToken: hfToken || undefined,
          openWebUI: addOpenWebUI || undefined,
          ssh_key_ids: selectedSSHKeyIds.size > 0 ? Array.from(selectedSSHKeyIds) : undefined,
          new_storage_block_id: storageMode === "create" && selectedStorageBlock ? selectedStorageBlock : undefined,
          existing_shared_volume_id: storageMode === "existing" && selectedExistingVolume ? selectedExistingVolume : undefined,
        });
      } else {
        // Standard GPU launch
        const response = await fetch("/api/instances", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: instanceName.trim(),
            product_id: selectedProduct,
            region_id: selectedRegion,
            startup_script: startupScript || undefined,
            startup_script_preset_id: startupScriptPresetId || undefined,
            new_storage_block_id: storageMode === "create" && selectedStorageBlock ? selectedStorageBlock : undefined,
            existing_shared_volume_id: storageMode === "existing" && selectedExistingVolume ? selectedExistingVolume : undefined,
            ssh_key_ids: selectedSSHKeyIds.size > 0 ? Array.from(selectedSSHKeyIds) : undefined,
            billingType: selectedProductDetails?.billingType || undefined,
            stripeSubscriptionId: stripeSubscriptionId || undefined,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          onError?.(data.error || "Failed to launch GPU");
        }
      }
    } catch (err) {
      console.warn("Launch request error:", err);
      onError?.(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setLaunching(false);
    }
  };

  if (!isOpen) return null;

  const walletBalanceDollars = ((options?.walletBalanceCents ?? 0) / 100).toFixed(2);
  const canLaunch =
    !!selectedProduct &&
    !!selectedRegion &&
    !!instanceName.trim() &&
    !!(selectedProductDetails && getProductAvailability(selectedProductDetails)) &&
    !launching;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="border-b border-[var(--line)] px-6 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-[var(--ink)]">
                {deployContext?.title || "New GPU"}
              </h2>
              {deployContext?.subtitle && (
                <p className="text-sm text-[var(--muted)] mt-1 line-clamp-2">{deployContext.subtitle}</p>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-zinc-400 hover:text-zinc-600 transition-colors shrink-0"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1 min-h-0">
          {DEPLOY_MAINTENANCE ? (
            <div className="text-center py-8">
              <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg
                  className="w-6 h-6 text-amber-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
              </div>
              <h3 className="font-semibold text-[var(--ink)] mb-2">Scheduled Maintenance</h3>
              <p className="text-sm text-[var(--muted)] mb-4">
                New GPU deployments are temporarily unavailable while we perform infrastructure
                upgrades. Your existing GPUs are not affected.
              </p>
              <p className="text-xs text-zinc-400">Please check back shortly.</p>
              <button
                onClick={onClose}
                className="mt-4 px-6 py-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-medium rounded-xl transition-colors text-sm"
              >
                Close
              </button>
            </div>
          ) : loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-zinc-900"></div>
              <p className="text-sm text-[var(--muted)]">Loading GPU options...</p>
            </div>
          ) : error && !options ? (
            <div className="text-center py-8">
              {error.includes("No team") ? (
                <>
                  <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg
                      className="w-6 h-6 text-amber-600"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                      />
                    </svg>
                  </div>
                  <h3 className="font-semibold text-[var(--ink)] mb-2">Unlock GPU Access</h3>
                  <p className="text-sm text-[var(--muted)] mb-4">
                    Add funds to deploy GPU instances.
                  </p>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {[50, 100, 250, 500].map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        disabled={topupLoading}
                        onClick={() =>
                          onTopup?.(amount * 100, undefined, selectedProduct || undefined)
                        }
                        className="px-4 py-3 border-2 border-[var(--line)] rounded-xl text-center font-semibold text-[var(--ink)] hover:border-teal-500 hover:bg-teal-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {topupLoading ? "..." : `$${amount}`}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-[var(--muted)]">Minimum $50 deposit required</p>
                </>
              ) : (
                <>
                  <p className="text-sm text-[var(--muted)] mb-4">{error}</p>
                  <button
                    onClick={onClose}
                    className="text-sm text-zinc-600 hover:text-[var(--ink)]"
                  >
                    Close
                  </button>
                </>
              )}
            </div>
          ) : showFundWallet ? (
            <div className="text-center py-6">
              <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg
                  className="w-6 h-6 text-amber-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <h3 className="font-semibold text-[var(--ink)] mb-2">Fund Your Wallet</h3>
              <p className="text-sm text-[var(--muted)] mb-1">
                You need at least{" "}
                <span className="font-semibold text-[var(--ink)]">${getMinimumRequired()}</span> to
                launch this GPU.
              </p>
              <p className="text-sm text-[var(--muted)] mb-5">
                Your current balance is{" "}
                <span className="font-semibold text-[var(--ink)]">${walletBalanceDollars}</span>.
              </p>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {[50, 100, 250, 500].map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    disabled={topupLoading}
                    onClick={() =>
                      onTopup?.(amount * 100, undefined, selectedProduct || undefined)
                    }
                    className="px-4 py-3 border-2 border-[var(--line)] rounded-xl text-center font-semibold text-[var(--ink)] hover:border-teal-500 hover:bg-teal-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {topupLoading ? "..." : `$${amount}`}
                  </button>
                ))}
              </div>
              <p className="text-xs text-[var(--muted)]">Minimum $50 deposit required</p>
            </div>
          ) : (
            <>
              {/* Step indicator */}
              {hasCategories && (
                <div className="flex items-center gap-2 mb-5">
                  {[
                    { n: 1, label: "GPU Type" },
                    { n: 2, label: "Product" },
                    { n: 3, label: "Configure" },
                  ].map(({ n, label }, i) => (
                    <div key={n} className="flex items-center gap-2">
                      {i > 0 && <div className={`w-8 h-px ${step >= n ? "bg-teal-400" : "bg-zinc-200"}`} />}
                      <button
                        type="button"
                        onClick={() => { if (n >= minStep && n < step) goToStep(n); }}
                        disabled={n > step || n < minStep}
                        className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
                          step === n
                            ? "text-teal-700"
                            : step > n
                              ? (n >= minStep
                                  ? "text-teal-500 cursor-pointer hover:text-teal-600"
                                  : "text-teal-500 cursor-default")
                              : "text-zinc-300 cursor-default"
                        }`}
                      >
                        <span className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center ${
                          step > n
                            ? "bg-teal-500 text-white"
                            : step === n
                              ? "bg-teal-100 text-teal-700 ring-2 ring-teal-500"
                              : "bg-zinc-100 text-zinc-400"
                        }`}>
                          {step > n ? "✓" : n}
                        </span>
                        {label}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* ====== STEP 1: GPU Category ====== */}
              {step === 1 && hasCategories && (
                <>
                  <div className="mb-4">
                    <label className="block text-xs font-medium text-[var(--muted)] mb-2 uppercase tracking-wide">
                      Select GPU Type
                    </label>
                    <div className="space-y-2">
                      {gpuFamilies.map((family) => {
                        const cat = options?.categories?.find(c => c.name === family);
                        const isPending = cat && !cat.scenarioConfigured;
                        const productCount = cat?.products?.length ?? 0;
                        return (
                          <button
                            key={family}
                            type="button"
                            disabled={!!isPending}
                            onClick={() => {
                              setSelectedGpuFamily(family);
                              setSelectedProduct("");
                              setCategoryCheckResult(null);
                              setStep(2);
                              if (cat) checkCategoryAvailability(cat.id);
                            }}
                            className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all ${
                              isPending
                                ? "border-dashed border-gray-200 text-gray-400 cursor-not-allowed"
                                : "border-[var(--line)] hover:border-teal-400 hover:bg-teal-50/50"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium text-[var(--ink)]">{family}</span>
                              <span className="text-xs text-[var(--muted)]">
                                {isPending ? "Pending setup" : `${productCount} product${productCount !== 1 ? "s" : ""}`}
                              </span>
                            </div>
                            {cat?.description && (
                              <p className="text-xs text-[var(--muted)] mt-0.5">{cat.description}</p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}

              {/* ====== STEP 2: Product + Region ====== */}
              {step === 2 && (
                <>
                  {/* GPU Product Selection */}
                  {categoryCheckLoading ? (
                    <div className="flex flex-col items-center justify-center py-8 gap-2">
                      <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" /><path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
                        Checking GPU availability...
                      </div>
                      <p className="text-xs text-zinc-400">This can take a few seconds</p>
                    </div>
                  ) : filteredProducts.length > 0 ? (
                <div className="mb-5">
                  <label className="block text-xs font-medium text-[var(--muted)] mb-3 uppercase tracking-wide">
                    Select a GPU
                  </label>
                  <div className="mb-3 p-3 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-900 leading-relaxed">
                    <span className="font-semibold">Dedicated GPU</span> is the whole card, yours alone. <span className="font-semibold">Dynamic GPU</span> is shared infrastructure that delivers the same peak performance and VRAM capacity.
                  </div>
                  <div className="space-y-2">
                    {filteredProducts.map((product) => {
                      const isSelected = selectedProduct === product.id;
                      const isAvailable = getProductAvailability(product);
                      const pricePerHour = (product.pricePerHourCents / 100).toFixed(2);
                      const hasMonthly =
                        product.pricePerMonthCents && product.pricePerMonthCents > 0;
                      const monthlyHourlyRate = hasMonthly
                        ? (product.pricePerMonthCents! / 100 / 730).toFixed(2)
                        : null;
                      // Savings vs on-demand only makes sense when the product
                      // carries a non-zero hourly "list" rate. Monthly-only
                      // products store pricePerHourCents = 0, which would
                      // produce a -Infinity% savings display.
                      const hasListHourly = product.pricePerHourCents > 0;
                      const savingsPercent = hasMonthly && hasListHourly
                        ? Math.round(
                            (1 -
                              product.pricePerMonthCents! /
                                100 /
                                730 /
                                (product.pricePerHourCents / 100)) *
                              100
                          )
                        : 0;

                      return (
                        <button
                          key={product.id}
                          type="button"
                          disabled={!isAvailable}
                          onClick={() => {
                            if (isAvailable) setSelectedProduct(product.id);
                          }}
                          className={`w-full p-4 rounded-xl border-2 text-left transition-all ${
                            !isAvailable
                              ? "border-[var(--line)] bg-zinc-50 opacity-60 cursor-not-allowed"
                              : isSelected
                                ? "border-teal-500 bg-teal-50"
                                : "border-[var(--line)] hover:border-teal-300 hover:bg-zinc-50"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {product.featured && (
                                  <svg
                                    className="w-4 h-4 text-amber-500 flex-shrink-0"
                                    fill="currentColor"
                                    viewBox="0 0 20 20"
                                  >
                                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                                  </svg>
                                )}
                                <span className="font-medium text-[var(--ink)]">
                                  {product.name}
                                </span>
                                {product.badgeText && (
                                  <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full">
                                    {product.badgeText}
                                  </span>
                                )}
                              </div>
                              <div className="text-sm text-[var(--muted)] mt-1">
                                {product.vramGb && `${product.vramGb}GB VRAM`}
                                {product.description && ` · ${product.description}`}
                              </div>
                            </div>
                            <div className="text-right flex-shrink-0 ml-3">
                              {!isAvailable ? (
                                <span className="text-xs font-medium text-zinc-400">
                                  No GPUs available
                                </span>
                              ) : hasMonthly ? (
                                <>
                                  <div className="flex items-baseline gap-1.5 justify-end">
                                    <span className="text-lg font-bold text-teal-600">
                                      ${monthlyHourlyRate}
                                    </span>
                                    <span className="text-xs text-[var(--muted)]">eff/hr</span>
                                  </div>
                                  {hasListHourly && savingsPercent > 0 && (
                                    <div className="flex items-center gap-1.5 justify-end">
                                      <span className="text-xs text-[var(--muted)] line-through">
                                        ${pricePerHour}/hr
                                      </span>
                                      <span className="text-xs font-medium text-teal-600">
                                        Save {savingsPercent}%
                                      </span>
                                    </div>
                                  )}
                                  <div className="text-xs text-[var(--muted)] mt-0.5">
                                    ${(product.pricePerMonthCents! / 100).toFixed(0)}/mo commitment
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div className="text-lg font-bold text-[var(--ink)]">
                                    ${pricePerHour}
                                  </div>
                                  <div className="text-xs text-[var(--muted)]">per hour</div>
                                </>
                              )}
                            </div>
                            {isSelected && isAvailable && (
                              <div className="ml-3 w-6 h-6 bg-teal-500 rounded-full flex items-center justify-center flex-shrink-0">
                                <svg
                                  className="w-4 h-4 text-white"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M5 13l4 4L19 7"
                                  />
                                </svg>
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="mb-5">
                  <div className="p-4 rounded-xl border border-amber-200 bg-amber-50">
                    <div className="flex items-start gap-3">
                      <svg
                        className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                        />
                      </svg>
                      <div>
                        <p className="font-medium text-amber-800">No GPUs Available</p>
                        <p className="text-sm text-amber-700 mt-1">
                          There are currently no GPU products configured. Please contact support.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Region Picker */}
              {selectedProductDetails && selectedProductRegions.length > 0 && (
                <div className="mb-5">
                  <label className="block text-xs font-medium text-[var(--muted)] mb-2 uppercase tracking-wide">
                    Region
                  </label>
                  <div className="space-y-2">
                    {selectedProductRegions.map((region) => {
                      const cc = (region as { country_code?: string }).country_code?.toLowerCase();
                      const flag = cc
                        ? String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 97))
                        : "";
                      return (
                        <button
                          key={region.id}
                          type="button"
                          onClick={() => setSelectedRegion(region.id)}
                          className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all ${
                            selectedRegion === region.id
                              ? "border-teal-500 bg-teal-50"
                              : "border-[var(--line)] hover:border-teal-300"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            {flag && <span className="text-xl">{flag}</span>}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-[var(--ink)]">
                                {(region as { city?: string }).city || region.region_name}
                                {(region as { country?: string }).country && (
                                  <span className="text-[var(--muted)] font-normal">, {(region as { country?: string }).country}</span>
                                )}
                              </div>
                              <div className="text-xs text-[var(--muted)]">{region.region_name}</div>
                            </div>
                            {selectedRegion === region.id && (
                              <svg className="w-5 h-5 text-teal-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

                  {/* Next button for step 2 → step 3 */}
                  {selectedProduct && selectedRegion && (
                    <button
                      type="button"
                      onClick={() => setStep(3)}
                      className="w-full mt-4 px-4 py-3 bg-teal-600 text-white rounded-xl font-medium hover:bg-teal-700 transition-colors"
                    >
                      Continue to Configuration
                    </button>
                  )}
                </>
              )}

              {/* ====== STEP 3: Configure + Launch ====== */}
              {step === 3 && (
                <>
              {/* Instance Name */}
              <div className="mb-5">
                <label className="block text-xs font-medium text-[var(--muted)] mb-2 uppercase tracking-wide">
                  Name
                </label>
                <input
                  type="text"
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                  placeholder="my-gpu-workspace"
                  className="w-full px-4 py-3 rounded-xl border border-[var(--line)] focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none transition-all text-sm"
                />
              </div>

              {/* Persistent Storage (visible by default) */}
              {selectedRegion && (
                <div className="mb-5">
                  <label className="block text-xs font-medium text-[var(--muted)] mb-2 uppercase tracking-wide">
                    Persistent Storage
                  </label>
                  {storageBlocksLoading ? (
                    <div className="flex items-center gap-2 p-3 text-sm text-[var(--muted)]">
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Loading storage options...
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <label className="flex items-center gap-3 p-3 rounded-xl border border-[var(--line)] cursor-pointer hover:border-teal-300 transition-colors">
                        <input type="radio" name="storage-mode-top" checked={storageMode === "none"} onChange={() => { setStorageMode("none"); setSelectedExistingVolume(null); }} className="w-4 h-4 accent-teal-500" />
                        <div>
                          <span className="text-sm font-medium text-[var(--ink)]">None</span>
                          <p className="text-xs text-[var(--muted)]">Ephemeral storage only (data lost on termination)</p>
                        </div>
                      </label>
                      {storageBlocks.length > 0 && (
                        <label className="flex items-center gap-3 p-3 rounded-xl border border-[var(--line)] cursor-pointer hover:border-teal-300 transition-colors">
                          <input type="radio" name="storage-mode-top" checked={storageMode === "create"} onChange={() => { setStorageMode("create"); setSelectedExistingVolume(null); if (storageBlocks.length > 0 && !selectedStorageBlock) setSelectedStorageBlock(storageBlocks[0].id); }} className="w-4 h-4 accent-teal-500" />
                          <div>
                            <span className="text-sm font-medium text-[var(--ink)]">Create new volume</span>
                            <p className="text-xs text-[var(--muted)]">Persistent storage that survives termination</p>
                          </div>
                        </label>
                      )}
                      {(() => {
                        const regionVolumes = options?.existingSharedVolumes?.filter(v => v.region_id === selectedRegion) || [];
                        if (regionVolumes.length === 0) return null;
                        return (
                          <label className="flex items-center gap-3 p-3 rounded-xl border border-[var(--line)] cursor-pointer hover:border-teal-300 transition-colors">
                            <input type="radio" name="storage-mode-top" checked={storageMode === "existing"} onChange={() => { setStorageMode("existing"); setSelectedExistingVolume(regionVolumes[0].id); }} className="w-4 h-4 accent-teal-500" />
                            <div className="flex-1">
                              <span className="text-sm font-medium text-[var(--ink)]">Use existing volume</span>
                              <p className="text-xs text-[var(--muted)]">Attach a volume you already own</p>
                            </div>
                            <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">{regionVolumes.length} available</span>
                          </label>
                        );
                      })()}
                    </div>
                  )}
                  {storageMode === "create" && storageBlocks.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {storageBlocks.map(block => (
                        <button key={block.id} type="button" onClick={() => setSelectedStorageBlock(block.id)} className={`px-3 py-2 text-sm rounded-lg border transition-colors ${selectedStorageBlock === block.id ? "border-teal-500 bg-teal-50 text-teal-700 font-medium" : "border-[var(--line)] text-[var(--muted)] hover:border-zinc-300"}`}>
                          {block.size}GB{block.cost !== "0" && block.cost !== "0.00" && <span className="text-xs ml-1">(${block.cost}/hr)</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  {storageMode === "existing" && options?.existingSharedVolumes && (
                    <select value={selectedExistingVolume || ""} onChange={e => setSelectedExistingVolume(Number(e.target.value))} className="w-full mt-2 px-4 py-3 rounded-xl border border-[var(--line)] bg-white text-sm focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none">
                      {options.existingSharedVolumes.filter(v => v.region_id === selectedRegion).map(vol => (
                        <option key={vol.id} value={vol.id}>{vol.name} ({vol.size_in_gb}GB) - {vol.status}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Advanced Options (collapsible) — Startup scripts only, hidden for deploy contexts */}
              {!deployContext && (
              <div className="mb-5">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-2 text-sm text-teal-600 hover:text-teal-700 transition-colors group"
                >
                  <svg
                    className={`w-4 h-4 transition-transform ${showAdvanced ? "rotate-90" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  <span>Advanced options</span>
                  {!showAdvanced && selectedStartupScript && (
                    <span className="px-2 py-0.5 text-xs bg-teal-100 text-teal-700 rounded-full">
                      {STARTUP_SCRIPT_PRESETS.find((p) => p.id === selectedStartupScript)?.name || "Custom script"}
                    </span>
                  )}
                </button>

                {showAdvanced && (
                  <div className="mt-3 space-y-4 animate-in slide-in-from-top-2 duration-200">
                    {/* Startup Script */}
                    <div>
                      <label className="block text-xs font-medium text-[var(--muted)] mb-2">
                        Startup script
                      </label>
                      <div className="space-y-1">
                        {/* None option */}
                        <label className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-zinc-50 cursor-pointer transition-colors">
                          <input
                            type="radio"
                            name="startup-script"
                            checked={!selectedStartupScript}
                            onChange={() => {
                              setSelectedStartupScript("");
                              setShowCustomScript(false);
                            }}
                            className="w-4 h-4 accent-teal-500"
                          />
                          <span className="text-sm text-[var(--muted)]">None (bare GPU)</span>
                        </label>

                        {/* Preset options */}
                        {STARTUP_SCRIPT_PRESETS.map((preset) => (
                          <label
                            key={preset.id}
                            className={`flex items-start gap-3 p-2.5 rounded-lg cursor-pointer transition-colors ${
                              selectedStartupScript === preset.id
                                ? "bg-teal-50"
                                : "hover:bg-zinc-50"
                            }`}
                          >
                            <input
                              type="radio"
                              name="startup-script"
                              checked={selectedStartupScript === preset.id}
                              onChange={() => {
                                setSelectedStartupScript(preset.id);
                                setShowCustomScript(false);
                              }}
                              className="w-4 h-4 mt-0.5 accent-teal-500"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span>{preset.icon}</span>
                                <span className="text-sm font-medium text-[var(--ink)]">
                                  {preset.name}
                                </span>
                                <span className="text-xs text-[var(--muted)]">
                                  ~{preset.estimatedMinutes}m
                                </span>
                              </div>
                              <p className="text-xs text-[var(--muted)] mt-0.5">
                                {preset.description}
                              </p>
                            </div>
                          </label>
                        ))}

                        {/* Custom script option */}
                        <label
                          className={`flex items-start gap-3 p-2.5 rounded-lg cursor-pointer transition-colors ${
                            showCustomScript ? "bg-teal-50" : "hover:bg-zinc-50"
                          }`}
                        >
                          <input
                            type="radio"
                            name="startup-script"
                            checked={showCustomScript}
                            onChange={() => {
                              setShowCustomScript(true);
                              setSelectedStartupScript("custom");
                            }}
                            className="w-4 h-4 mt-0.5 accent-teal-500"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span>📝</span>
                              <span className="text-sm font-medium text-[var(--ink)]">
                                Custom script
                              </span>
                            </div>
                            <p className="text-xs text-[var(--muted)] mt-0.5">
                              Run your own bash script on startup
                            </p>
                          </div>
                        </label>

                        {showCustomScript && (
                          <div className="ml-7 mt-2">
                            <textarea
                              value={customScript}
                              onChange={(e) => setCustomScript(e.target.value)}
                              placeholder="#!/bin/bash&#10;# Your startup script..."
                              className="w-full px-3 py-2 rounded-lg border border-[var(--line)] focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none text-sm font-mono h-20 resize-none"
                            />
                          </div>
                        )}
                      </div>
                    </div>

                  </div>
                )}
              </div>
              )}

              {/* Wallet + Cost Summary */}
              {selectedProductDetails && getProductAvailability(selectedProductDetails) && (
                <div className="p-4 bg-zinc-50 border border-[var(--line)] rounded-xl">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-[var(--muted)]">
                      Wallet:{" "}
                      <span className="font-medium text-[var(--ink)]">${walletBalanceDollars}</span>
                    </div>
                    <div className="text-sm text-[var(--muted)]">
                      Est:{" "}
                      <span className="font-bold text-[var(--ink)]">
                        ${(selectedProductDetails.pricePerHourCents / 100).toFixed(2)}/hr
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Deploy context fields (HF token, Open WebUI, etc.) */}
              {deployContext?.type === "huggingface" && (
                <div className="space-y-4 mb-5">
                  {/* HF Token (for gated models) */}
                  {deployContext.isGated && (
                    <div>
                      <label className="block text-xs font-medium text-[var(--muted)] mb-2 uppercase tracking-wide">
                        HuggingFace Token
                      </label>
                      <input
                        type="password"
                        value={hfToken}
                        onChange={e => setHfToken(e.target.value)}
                        placeholder="hf_..."
                        className="w-full px-4 py-3 rounded-xl border border-[var(--line)] focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 outline-none text-sm font-mono"
                      />
                      <p className="text-xs text-[var(--muted)] mt-1">
                        Required for gated models. Get yours at{" "}
                        <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline">
                          huggingface.co/settings/tokens
                        </a>
                      </p>
                    </div>
                  )}

                  {/* Open WebUI checkbox */}
                  <label className="flex items-start gap-3 p-3 rounded-xl border border-[var(--line)] cursor-pointer hover:border-teal-300 transition-colors">
                    <input
                      type="checkbox"
                      checked={addOpenWebUI}
                      onChange={e => setAddOpenWebUI(e.target.checked)}
                      className="w-4 h-4 mt-0.5 accent-teal-500"
                    />
                    <div>
                      <span className="text-sm font-medium text-[var(--ink)]">Add Chat UI (Open WebUI)</span>
                      <p className="text-xs text-[var(--muted)]">Deploy a ChatGPT-like interface alongside your model</p>
                    </div>
                  </label>
                </div>
              )}

              {/* SSH Keys (optional) */}
              <div className="mt-5">
                <label className="block text-sm font-medium text-zinc-700 mb-2">
                  SSH Keys <span className="text-zinc-400 font-normal">(optional)</span>
                </label>
                {!options?.sshKeys ? (
                  <div className="space-y-2">
                    <div className="h-4 bg-zinc-100 rounded animate-pulse" />
                    <div className="h-4 bg-zinc-100 rounded animate-pulse w-3/4" />
                  </div>
                ) : options.sshKeys.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    No SSH keys saved.{" "}
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        const url = new URL(window.location.href);
                        url.searchParams.set("tab", "settings");
                        window.location.href = url.toString();
                      }}
                      className="text-teal-600 hover:text-teal-700 hover:underline"
                    >
                      Add keys in Account Settings &rarr;
                    </button>
                  </p>
                ) : (
                  <div className="space-y-2">
                    {options.sshKeys.map((key) => (
                      <label
                        key={key.id}
                        className="flex items-center gap-3 p-3 bg-zinc-50 rounded-lg cursor-pointer hover:bg-zinc-100 transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={selectedSSHKeyIds.has(key.id)}
                          onChange={(e) => {
                            const next = new Set(selectedSSHKeyIds);
                            if (e.target.checked) {
                              next.add(key.id);
                            } else {
                              next.delete(key.id);
                            }
                            setSelectedSSHKeyIds(next);
                          }}
                          className="w-4 h-4 accent-teal-500 rounded"
                        />
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-medium text-zinc-900">{key.name}</span>
                          <span className="text-xs text-zinc-400 font-mono ml-2 truncate">{key.fingerprint}</span>
                        </div>
                      </label>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        const url = new URL(window.location.href);
                        url.searchParams.set("tab", "settings");
                        window.location.href = url.toString();
                      }}
                      className="block text-xs text-teal-600 hover:text-teal-700 hover:underline mt-1"
                    >
                      Manage keys in Account Settings &rarr;
                    </button>
                  </div>
                )}
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 mt-4">
                  <p className="text-sm text-red-600">{error}</p>
                </div>
              )}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!DEPLOY_MAINTENANCE && !loading && options && !showFundWallet && !(error && !options) && (
          <div className="border-t border-[var(--line)] p-6 flex gap-3">
            <button
              onClick={() => {
                const next = backAction(step, minStep);
                if (next === "close") onClose();
                else goToStep(next);
              }}
              className="flex-1 py-3 px-4 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-medium rounded-xl transition-colors"
            >
              {step > minStep ? "Back" : "Cancel"}
            </button>
            {step === 3 && (
              <button
                onClick={handleLaunch}
                disabled={!canLaunch}
                className="flex-1 py-3 px-4 bg-[var(--blue)] hover:bg-[var(--blue-dark)] text-white font-medium rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                {deployContext ? "Deploy" : "Launch GPU"}
              </button>
            )}
          </div>
        )}

        {/* Footer for fund wallet state */}
        {showFundWallet && (
          <div className="border-t border-[var(--line)] p-6 flex gap-3">
            <button
              onClick={() => setShowFundWallet(false)}
              className="flex-1 py-3 px-4 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-medium rounded-xl transition-colors"
            >
              Back
            </button>
            <button
              onClick={onClose}
              className="flex-1 py-3 px-4 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-medium rounded-xl transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
