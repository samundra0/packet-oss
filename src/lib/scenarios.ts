/**
 * Packet Scenario Management
 *
 * Manages two HAI scenarios that Packet uses for service discovery:
 * - packet-gpu-provisioning: bare GPU services (one per GpuProduct)
 * - packet-apps: recipe-backed app services (one per deployable GpuApp)
 *
 * Scenarios are auto-created on first use and stored in SystemSetting.
 * Services are auto-assigned/unassigned when admin configures products or apps.
 */

import { getSetting, setSetting } from "@/lib/settings";
import {
  listScenarios,
  createScenario,
  assignServiceToScenario,
  unassignServiceFromScenario,
} from "@/lib/hostedai";

const GPU_SCENARIO_KEY = "packet_gpu_scenario_id";
const APPS_SCENARIO_KEY = "packet_apps_scenario_id";

/**
 * Find an existing scenario by name via the HAI list endpoint.
 * Returns the scenario ID if found, null otherwise.
 */
async function findScenarioByName(name: string): Promise<string | null> {
  const scenarios = await listScenarios();
  const match = scenarios.find((s) => s.name === name);
  return match?.id ?? null;
}

/**
 * Get or create a scenario, handling the case where the scenario
 * already exists in HAI but our DB lost the reference.
 */
async function getOrCreateScenario(
  settingKey: string,
  name: string,
  description: string,
  label: string
): Promise<string> {
  const existing = await getSetting(settingKey);
  if (existing) return existing;

  console.log(`[Scenarios] Creating ${label} scenario in HAI...`);
  try {
    const result = await createScenario({ name, description });
    await setSetting(settingKey, result.id);
    console.log(`[Scenarios] Created ${label} scenario: ${result.id}`);
    return result.id;
  } catch (error) {
    // If the scenario already exists in HAI, look it up by name
    if (error instanceof Error && error.message.includes("invalid scenario name")) {
      console.log(`[Scenarios] ${label} scenario already exists in HAI, looking up by name...`);
      const id = await findScenarioByName(name);
      if (id) {
        await setSetting(settingKey, id);
        console.log(`[Scenarios] Found existing ${label} scenario: ${id}`);
        return id;
      }
    }
    console.error(`[Scenarios] Failed to create ${label} scenario:`, error);
    throw error;
  }
}

/**
 * Get or create the GPU provisioning scenario.
 * Returns the scenario UUID.
 */
export async function getGpuScenarioId(): Promise<string> {
  return getOrCreateScenario(
    GPU_SCENARIO_KEY,
    "Packet GPU Provisioning",
    "Bare GPU pod services managed by Packet.ai dashboard",
    "GPU"
  );
}

/**
 * Get or create the Apps scenario.
 * Returns the scenario UUID.
 */
export async function getAppsScenarioId(): Promise<string> {
  return getOrCreateScenario(
    APPS_SCENARIO_KEY,
    "Packet Apps",
    "Recipe-backed app services managed by Packet.ai dashboard",
    "Apps"
  );
}

/**
 * Assign a service to the GPU provisioning scenario.
 * Called when admin links a serviceId to a GpuProduct.
 */
export async function assignGpuService(serviceId: string): Promise<void> {
  try {
    const scenarioId = await getGpuScenarioId();
    await assignServiceToScenario(serviceId, scenarioId);
    console.log(`[Scenarios] Assigned service ${serviceId} to GPU scenario`);
  } catch (error) {
    // Log but don't fail — scenario assignment is best-effort
    // The service still works via direct serviceId, just won't appear in scenario queries
    console.error(`[Scenarios] Failed to assign GPU service ${serviceId}:`, error);
  }
}

/**
 * Unassign a service from the GPU provisioning scenario.
 * Called when admin removes serviceId from a GpuProduct.
 */
export async function unassignGpuService(serviceId: string): Promise<void> {
  try {
    const scenarioId = await getGpuScenarioId();
    await unassignServiceFromScenario(serviceId, scenarioId);
    console.log(`[Scenarios] Unassigned service ${serviceId} from GPU scenario`);
  } catch (error) {
    console.error(`[Scenarios] Failed to unassign GPU service ${serviceId}:`, error);
  }
}

/**
 * Assign a service to the Apps scenario.
 * Called when admin links a serviceId to a GpuApp.
 */
export async function assignAppService(serviceId: string): Promise<void> {
  try {
    const scenarioId = await getAppsScenarioId();
    await assignServiceToScenario(serviceId, scenarioId);
    console.log(`[Scenarios] Assigned service ${serviceId} to Apps scenario`);
  } catch (error) {
    console.error(`[Scenarios] Failed to assign App service ${serviceId}:`, error);
  }
}

/**
 * Unassign a service from the Apps scenario.
 * Called when admin removes serviceId from a GpuApp.
 */
export async function unassignAppService(serviceId: string): Promise<void> {
  try {
    const scenarioId = await getAppsScenarioId();
    await unassignServiceFromScenario(serviceId, scenarioId);
    console.log(`[Scenarios] Unassigned service ${serviceId} from Apps scenario`);
  } catch (error) {
    console.error(`[Scenarios] Failed to unassign App service ${serviceId}:`, error);
  }
}
