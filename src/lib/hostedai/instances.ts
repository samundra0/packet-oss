/**
 * Instance management functions for hosted.ai
 */

import { hostedaiRequest } from "./client";
import type {
  Instance,
  CreateInstanceParams,
  InstanceCredentials,
  InstanceType,
  Image,
  ImagePolicy,
  ImagePolicyObject,
  StorageBlock,
  VNCSession,
  ServiceScenario,
  CompatibleScenariosResponse,
} from "./types";

// Get compatible service scenarios for a team
export async function getCompatibleServiceScenarios(
  teamId: string
): Promise<CompatibleScenariosResponse> {
  return hostedaiRequest<CompatibleScenariosResponse>(
    "GET",
    `/compatible-service-scenarios?team_id=${teamId}`
  );
}

// Get available instance types for a service
export async function getInstanceTypes(
  serviceId: string,
  teamId: string
): Promise<InstanceType[]> {
  return hostedaiRequest<InstanceType[]>(
    "GET",
    `/service/i/instance-types?service_id=${serviceId}&team_id=${teamId}`
  );
}

// Get compatible images for a service
export async function getCompatibleImages(
  serviceId: string,
  teamId: string
): Promise<Image[]> {
  return hostedaiRequest<Image[]>(
    "GET",
    `/service/i/compatible-images?service_id=${serviceId}&team_id=${teamId}`
  );
}

// Get all image policies (for GPUaaS image selection)
export async function getImagePolicies(): Promise<ImagePolicy[]> {
  return hostedaiRequest<ImagePolicy[]>("GET", "/policy/image");
}

// Get images for a specific team from image policies
export async function getGPUaaSImages(teamId: string): Promise<ImagePolicyObject[]> {
  const policies = await getImagePolicies();

  // Find policies that include this team
  for (const policy of policies) {
    const hasTeam = policy.teams?.some(t => t.id === teamId);
    if (hasTeam && policy.objects && policy.objects.length > 0) {
      console.log(`Found images for team ${teamId} in policy ${policy.name}:`, policy.objects);
      return policy.objects;
    }
  }

  // Fall back to default GPUaaS Policy if no team-specific policy found
  const gpuaasPolicy = policies.find(p => p.name === "GPUaaS Policy");
  if (gpuaasPolicy?.objects) {
    console.log("Using default GPUaaS Policy images:", gpuaasPolicy.objects);
    return gpuaasPolicy.objects;
  }

  return [];
}

// Get available storage blocks
export async function getStorageBlocks(): Promise<StorageBlock[]> {
  return hostedaiRequest<StorageBlock[]>("GET", "/storage-blocks");
}

// Get instance details
export async function getInstance(instanceId: string): Promise<Instance> {
  return hostedaiRequest<Instance>("GET", `/instance/${instanceId}`);
}

// HAI 2.2 unified instance shape (from GET /instances/unified)
export interface UnifiedInstance {
  id: string;
  name: string;
  created_at: string;
  status: string;
  nature: string;
  ip: string[];
  service?: { id: string; name: string; type: string };
  team?: { id: string; name: string };
  region?: {
    id: number;
    region_name: string;
    city?: string;
    country?: string;
    country_code?: string;
  };
  workspace?: { id: string; name: string };
  pod_info?: {
    model?: string;
    vendor?: string;
    pool_name?: string;
    pool_label?: string;
    pool_display_mode?: string;
    provisioned_service_name?: string;
    exposed_count?: number;
    vram_gb?: string;
    max_tflops?: string;
    vgpu_count?: number;
  };
  instance_type?: {
    id: string;
    name: string;
    cpu_cores: number;
    ram_mb: number;
    scale?: number;
  };
}

// HAI 2.2 detailed instance (from GET /instances/unified/{id})
export interface UnifiedInstanceDetail extends UnifiedInstance {
  region?: {
    id: number;
    region_name: string;
    city?: string;
    country?: string;
    country_code?: string;
    has_shared_storage_support?: boolean;
  };
  root_disk?: { id: string; name: string; size_gb: number };
  shared_volumes?: Array<{
    id: number;
    name: string;
    mount_point: string;
    size_in_gb: number;
    status: string;
    mount_operation?: string;
    mount_status?: string;
    mount_error?: string;
  }>;
}

// Get a single unified instance by ID (HAI 2.2)
export async function getUnifiedInstanceDetail(
  instanceId: string
): Promise<UnifiedInstanceDetail> {
  return hostedaiRequest<UnifiedInstanceDetail>(
    "GET",
    `/instances/unified/${instanceId}`
  );
}

// Attach or detach shared volumes on a running pod
export async function podVolumeAction(
  podName: string,
  action: "attach_volume" | "detach_volume",
  volumeIds: number[]
): Promise<void> {
  await hostedaiRequest("POST", "/pods/volume-action", {
    pod_name: podName,
    action,
    volumes: volumeIds,
  });
}

// Get unified instances for a team (HAI 2.2)
export async function getUnifiedInstances(
  teamId: string,
  page = 0,
  perPage = 100
): Promise<{ items: UnifiedInstance[]; total_items: number }> {
  return hostedaiRequest<{ items: UnifiedInstance[]; total_items: number }>(
    "GET",
    `/instances/unified?page=${page}&per_page=${perPage}&team_id=${teamId}`,
    undefined,
    60000
  );
}

// Status count entry from HAI 2.2 /instances/unified response
export interface InstanceStatusCount {
  status: string;
  count: number;
}

// Global instance summary (no team_id filter)
export interface GlobalInstanceSummary {
  statusCounts: InstanceStatusCount[];
  totalItems: number;
}

// Get global instance summary from HAI 2.2 (all teams, all statuses)
// Uses per_page=1 to minimize payload — we only need status_counts and total_items
export async function getGlobalInstanceSummary(): Promise<GlobalInstanceSummary> {
  const response = await hostedaiRequest<{
    items: unknown[];
    status_counts: InstanceStatusCount[];
    total_items: number;
  }>(
    "GET",
    `/instances/unified?page=0&per_page=1`,
    undefined,
    30000
  );
  return {
    statusCounts: response.status_counts || [],
    totalItems: response.total_items || 0,
  };
}

// Get ALL unified instances globally (paginated, no team filter)
// Used by admin pods to get actual running/stopped instances
export async function getAllUnifiedInstances(): Promise<UnifiedInstance[]> {
  const all: UnifiedInstance[] = [];
  let page = 0;
  const perPage = 100;
  while (true) {
    const res = await hostedaiRequest<{ items: UnifiedInstance[]; total_items: number }>(
      "GET",
      `/instances/unified?page=${page}&per_page=${perPage}`,
      undefined,
      60000
    );
    if (res.items && res.items.length > 0) {
      all.push(...res.items);
    }
    if (!res.items || res.items.length < perPage || all.length >= res.total_items) break;
    page++;
  }
  return all;
}

// Get workspaces for a team (every team has at least one default workspace)
export async function getTeamWorkspaces(
  teamId: string
): Promise<Array<{ id: string; name: string }>> {
  const res = await hostedaiRequest<{
    workspaces: Array<{ id: string; name: string }>;
  }>("GET", `/workspace?page=0&itemsPerPage=10&teamId=${teamId}`);
  return res.workspaces || [];
}

// Create a new instance
export async function createInstance(
  params: CreateInstanceParams
): Promise<Instance> {
  return hostedaiRequest<Instance>("POST", "/service/i/create-instance", params as unknown as Record<string, unknown>);
}

// Start an instance
export async function startInstance(instanceId: string): Promise<void> {
  await hostedaiRequest("PUT", `/instance/${instanceId}/start`);
}

// Stop an instance
export async function stopInstance(instanceId: string): Promise<void> {
  await hostedaiRequest("PUT", `/instance/${instanceId}/stop`);
}

// Restart an instance
export async function restartInstance(instanceId: string): Promise<void> {
  await hostedaiRequest("PUT", `/instance/${instanceId}/restart`);
}

// Delete an instance
export async function deleteInstance(instanceId: string): Promise<void> {
  await hostedaiRequest("DELETE", `/instance/${instanceId}`);
}

// Get SSH credentials for an instance
export async function getInstanceCredentials(
  instanceId: string
): Promise<InstanceCredentials> {
  return hostedaiRequest<InstanceCredentials>(
    "GET",
    `/instance/${instanceId}/credentials`
  );
}

// Get GPUaaS compatible instances for a team (lists running instances)
export async function getTeamInstances(teamId: string): Promise<Instance[]> {
  return hostedaiRequest<Instance[]>(
    "GET",
    `/gpuaas/compatible-instances/${teamId}`,
    undefined,
    60000 // 60s timeout — teams with many GPUs can be slow
  );
}

// ============================================
// VNC Console Access
// ============================================

// Start VNC session for an instance
export async function startVNCSession(instanceId: string): Promise<VNCSession> {
  // VNC is only supported for traditional VM instances, not GPUaaS pods
  return hostedaiRequest<VNCSession>("POST", `/instance/${instanceId}/vnc`);
}

// Stop VNC session for an instance
export async function stopVNCSession(instanceId: string): Promise<void> {
  // VNC is only supported for traditional VM instances, not GPUaaS pods
  await hostedaiRequest("DELETE", `/instance/${instanceId}/vnc`);
}

// Rename an instance
export async function renameInstance(instanceId: string, newName: string): Promise<void> {
  await hostedaiRequest("PUT", `/instance/${instanceId}/rename`, { name: newName });
}

// Factory reset an instance
export async function factoryResetInstance(instanceId: string): Promise<void> {
  await hostedaiRequest("PUT", `/instance/${instanceId}/factory_reset`);
}

// ============================================
// Storage Management
// ============================================

export interface AddDiskParams {
  storage_block_id: string;
  disk_position?: number;
}

export interface AddDiskPricing {
  hourly_cost: number;
  monthly_cost: number;
  currency: string;
  storage_block: {
    id: string;
    name: string;
    size_gb: number;
  };
}

// Get pricing for adding a disk to an instance
export async function getAddDiskPricing(
  instanceId: string,
  storageBlockId: string
): Promise<AddDiskPricing> {
  return hostedaiRequest<AddDiskPricing>(
    "GET",
    `/instance/${instanceId}/add-disk/pricing?storage_block_id=${storageBlockId}`
  );
}

// Add disks to a traditional instance
export async function addDisksToInstance(
  instanceId: string,
  disks: AddDiskParams[]
): Promise<void> {
  await hostedaiRequest("POST", `/instance/${instanceId}/add-disks`, {
    disks,
  });
}

// ============================================
// Scenario Management
// ============================================

// List all scenarios in HAI
export async function listScenarios(): Promise<ServiceScenario[]> {
  const res = await hostedaiRequest<{ scenarios: ServiceScenario[] } | ServiceScenario[]>(
    "GET",
    "/scenario"
  );
  return Array.isArray(res) ? res : res.scenarios;
}

// Create a scenario in HAI
export async function createScenario(opts: {
  name: string;
  description: string;
}): Promise<{ id: string }> {
  return hostedaiRequest<{ id: string }>("POST", "/scenario", opts as unknown as Record<string, unknown>);
}

// Assign a service to a scenario
export async function assignServiceToScenario(
  serviceId: string,
  scenarioId: string
): Promise<void> {
  await hostedaiRequest("POST", "/scenario/assign-service", {
    service_id: serviceId,
    scenario_id: scenarioId,
  });
}

// Unassign a service from a scenario
export async function unassignServiceFromScenario(
  serviceId: string,
  scenarioId: string
): Promise<void> {
  await hostedaiRequest("POST", "/scenario/unassign-service", {
    service_id: serviceId,
    scenario_id: scenarioId,
  });
}

export type CompatibleService = {
  id: string;
  name: string;
  description: string;
  service_type: string;
  regions: Array<{ id: number; name: string }>;
  tags?: string[];
};

// Get compatible services under a scenario for a team
// HAI may return { services: [...] } or a bare array depending on version
export async function getScenarioCompatibleServices(
  scenarioId: string,
  teamId: string,
  limit = 50,
  offset = 0
): Promise<
  | { services: CompatibleService[]; has_more_batches: boolean; next_offset: number }
  | CompatibleService[]
> {
  return hostedaiRequest(
    "GET",
    `/service/i/scenario-compatible-services?scenario_id=${scenarioId}&team_id=${teamId}&limit=${limit}&offset=${offset}`
  );
}

// ============================================
// Service Provisioning APIs
// ============================================

// Get compatible regions for a service
export async function getServiceCompatibleRegions(
  serviceId: string,
  teamId: string
): Promise<Array<{ id: number; region_name: string; name?: string; country?: string; city?: string }>> {
  return hostedaiRequest(
    "GET",
    `/service/i/compatible-regions?service_id=${serviceId}&team_id=${teamId}`
  );
}

// Get compatible GPU pools for a service in a region
export async function getServiceCompatibleGPUPools(
  serviceId: string,
  teamId: string,
  regionId: number
): Promise<Array<{
  id: number;
  name: string;
  gpu_model?: string;
  available_vgpus?: number;
  total_vgpus?: number;
}>> {
  return hostedaiRequest(
    "GET",
    `/service/i/compatible-gpu-pools?service_id=${serviceId}&team_id=${teamId}&region_id=${regionId}`
  );
}

// Get provisioning info for a service (returns locked defaults)
export async function getServiceProvisioningInfo(
  serviceId: string,
  teamId: string,
  regionId: number
): Promise<Record<string, unknown>> {
  return hostedaiRequest(
    "GET",
    `/service/i/provisioning-info?service_id=${serviceId}&team_id=${teamId}&region_id=${regionId}`
  );
}

// Get a HAI service by ID (returns the full service object including gpu_config)
export async function getHAIService(
  serviceId: string
): Promise<Record<string, unknown>> {
  return hostedaiRequest<Record<string, unknown>>(
    "GET",
    `/service/${serviceId}`
  );
}

// Update a HAI service (read-modify-write since PUT requires full body)
export async function updateHAIService(
  serviceId: string,
  opts: Record<string, unknown>
): Promise<void> {
  // GET current service to get the full object
  const current = await hostedaiRequest<Record<string, unknown>>(
    "GET",
    `/service/${serviceId}`
  );

  // Deep-merge opts into current — supports nested objects like gpu_config
  const merged = { ...current };
  for (const [key, value] of Object.entries(opts)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === "object" &&
      !Array.isArray(merged[key])
    ) {
      // Merge nested object (e.g., gpu_config)
      merged[key] = { ...(merged[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      merged[key] = value;
    }
  }

  await hostedaiRequest("PUT", `/service/${serviceId}`, merged);
}
