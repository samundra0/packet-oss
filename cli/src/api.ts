import { getApiKey, getApiUrl } from "./config.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ApiResponse<T> {
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
  };
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Not authenticated. Run 'gpu-cloud login' first.");
  }

  const url = `${getApiUrl()}/api/v1${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      errorData.error || errorData.message || `HTTP ${response.status}`
    );
  }

  const json = (await response.json()) as ApiResponse<T>;
  return json.data;
}

// Type definitions matching API responses (HAI 2.2 unified instances)

export interface Account {
  id: string;
  email: string;
  name?: string;
  teamId?: string;
  createdAt: string;
}

export interface Pool {
  id: number | string;
  name: string;
  gpu_model?: string;
  available_gpus?: number;
  price_per_hour?: number;
}

export interface GpuProduct {
  id: string;
  name: string;
  description: string | null;
  pricePerHourCents: number;
  poolIds: number[];
  displayOrder: number;
  featured: boolean;
  badgeText: string | null;
  vramGb: number | null;
  totalAvailableGpus: number;
}

export interface LaunchOptions {
  regions: Array<{ id: string | number; name?: string }>;
  pools: Pool[];
  products: GpuProduct[];
  instanceTypes: Array<{ id: string; name: string; description?: string }>;
  images: Array<{ id: string; name: string; description?: string }>;
  storageBlocks: unknown[];
  ephemeralStorageBlocks: unknown[];
  persistentStorageBlocks: unknown[];
}

export interface Instance {
  id: string;
  name: string;
  status: string;
  created_at: string;
  region?: {
    id: number;
    name: string;
    city: string;
    country: string;
  } | null;
  gpu?: {
    model: string;
    vendor: string;
    vram_gb: string;
    vgpu_count: number;
  } | null;
  instance_type?: {
    id: string;
    name: string;
    cpu_cores: number;
    ram_mb: number;
  } | null;
  ip: string[];
  metadata?: {
    displayName: string | null;
    notes: string | null;
  } | null;
}

export interface InstanceList {
  instances: Instance[];
}

export interface InstanceDetail {
  instance: Instance;
  metadata: {
    displayName: string | null;
    notes: string | null;
  };
  connectionInfo?: {
    ip: string;
    port: number;
    username: string;
    ssh_command: string | null;
  } | null;
}

export interface ConnectionInfo {
  instance_id: string;
  status: string;
  connection: {
    ip: string;
    port: number;
    username: string;
    password?: string;
    ssh_command: string | null;
  };
}

export interface CreateInstanceResult {
  instance_id: string;
  name: string;
  pool_id: string;
  vgpus: number;
  startup_script_status?: string;
}
