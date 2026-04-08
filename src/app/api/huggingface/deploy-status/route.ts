import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { getUnifiedInstances, getInstanceCredentials } from "@/lib/hostedai";
// import { exposeService } from "@/lib/hostedai/services"; // TODO: need HAI 2.2 expose API
import { prisma } from "@/lib/prisma";
import { sendHfDeploymentEmail } from "@/lib/email";
import { generateCustomerToken } from "@/lib/customer-auth";
import { logActivity } from "@/lib/activity";
import {
  generateDeployScript,
  getDefaultPort,
} from "@/lib/huggingface-deploy-scripts";
import { getCatalogItem, DeployScriptType } from "@/lib/huggingface-catalog";
import {
  executeRemoteCommand,
  executeRemoteScript,
  parseStatusOutput,
  ERROR_MESSAGES,
  STATUS_CHECK_SCRIPT,
  type DeploymentStatus,
} from "@/lib/huggingface-status";

// Track in-flight deploy triggers to prevent duplicate script executions
const deployTriggersInFlight = new Set<string>();

// Simple view - what most users need
interface SimpleStatus {
  status: DeploymentStatus;
  message: string;
  progressPercent?: number; // 0-100
  error?: string; // Error code for quick identification
}

// Advanced view - for power users
interface AdvancedStatus {
  logs: string;
  sshCommand?: string;
  apiEndpoint?: string;
  podName?: string;
  podStatus?: string;
  startedAt?: string;
  elapsedSeconds?: number;
  errorCode?: string;
  gpuInfo?: {
    memoryUsedMB?: number;
    memoryTotalMB?: number;
    utilization?: number;
  };
  modelInfo?: {
    modelId?: string;
    modelSize?: string;
    loadProgress?: string;
  };
}

interface StatusResponse extends SimpleStatus {
  advanced?: AdvancedStatus;
}

/**
 * GET /api/huggingface/deploy-status
 *
 * Query params:
 * - subscriptionId: GPU subscription ID
 *
 * Returns deployment status by checking install.log and vLLM server status
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;
    const { payload, customer, teamId } = auth;

    const { searchParams } = new URL(request.url);
    const subscriptionId = searchParams.get("subscriptionId");

    if (!subscriptionId) {
      return NextResponse.json(
        { error: "subscriptionId is required" },
        { status: 400 }
      );
    }

    if (!teamId) {
      return NextResponse.json(
        { error: "No team associated with this account" },
        { status: 400 }
      );
    }

    // HAI 2.2: Verify instance belongs to this team via unified instances
    const resolvedSubscriptionId = subscriptionId;
    const unifiedResult = await getUnifiedInstances(teamId);
    const instance = unifiedResult.items?.find(i => i.id === subscriptionId);

    if (!instance) {
      console.log(`[HF Status] Instance ${subscriptionId} not found for team ${teamId}`);
      return NextResponse.json({ error: "Instance not found" }, { status: 404 });
    }

    const instanceStatus = instance.status?.toLowerCase() || "";

    // Instance has terminated
    if (["succeeded", "failed", "terminated", "error", "crashloopbackoff"].includes(instanceStatus)) {
      console.log(`[HF Status] Instance ${subscriptionId} terminated with status: ${instance.status}`);

      const deployment = await prisma.huggingFaceDeployment.findFirst({
        where: { subscriptionId: resolvedSubscriptionId },
        orderBy: { createdAt: "desc" },
      });

      if (deployment && deployment.status !== "failed") {
        await prisma.huggingFaceDeployment.update({
          where: { id: deployment.id },
          data: {
            status: "failed",
            errorMessage: `Pod terminated unexpectedly (${instance.status}). Please terminate this GPU and launch a new one.`,
          },
        });

        await logActivity(
          payload.customerId,
          "hf_deployment_pod_terminated",
          `HuggingFace deployment pod terminated: ${deployment.hfItemName}`,
          { deploymentId: deployment.id, podStatus: instance.status }
        );
      }

      return NextResponse.json<StatusResponse>({
        status: "failed",
        message: `Pod terminated unexpectedly (${instance.status}). Please terminate this GPU and launch a new one.`,
        error: "POD_TERMINATED",
      });
    }

    // Instance is not running yet
    if (instanceStatus !== "running") {
      return NextResponse.json<StatusResponse>({
        status: "not_started",
        message: `Pod status: ${instance.status}. Waiting for it to start...`,
      });
    }

    // Get SSH credentials via HAI 2.2 credentials API
    let host: string, port: number, username: string, password: string;
    try {
      const creds = await getInstanceCredentials(subscriptionId);
      if (!creds.ip || !creds.port || !creds.username || !creds.password) {
        return NextResponse.json<StatusResponse>({
          status: "not_started",
          message: "Pod is running, waiting for SSH access...",
        });
      }
      host = creds.ip;
      port = creds.port;
      username = creds.username;
      password = creds.password;
    } catch {
      return NextResponse.json<StatusResponse>({
        status: "not_started",
        message: "Pod is running, waiting for SSH access...",
      });
    }

    // Check status by examining install.log and server status
    // Uses shared status check script + additional GPU/model info for advanced view
    const statusCommand = STATUS_CHECK_SCRIPT + `
      # Get GPU info for advanced view (if nvidia-smi available)
      echo "---GPUINFO---"
      if command -v nvidia-smi &> /dev/null; then
        nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "N/A"
      else
        echo "N/A"
      fi

      # Get model loading progress from vLLM log
      echo "---MODELINFO---"
      if [ -f "$WORKSPACE/vllm.log" ]; then
        grep -E "Loading model|Downloading|Loading weights|Model loaded" "$WORKSPACE/vllm.log" 2>/dev/null | tail -1 || echo "N/A"
      else
        echo "N/A"
      fi

      # Show recent logs
      echo "---LOGS---"
      if [ -f "$WORKSPACE/vllm.log" ] && [ -s "$WORKSPACE/vllm.log" ]; then
        tail -30 "$WORKSPACE/vllm.log" 2>/dev/null
      else
        tail -25 "$WORKSPACE/install.log" 2>/dev/null
      fi
    `;

    const result = await executeRemoteCommand(
      host,
      port,
      username,
      password,
      statusCommand
    );

    if (!result.success) {
      console.log(`[HF Status] SSH command failed for ${instance.name}: ${result.output.slice(-200)}`);
      return NextResponse.json<StatusResponse>({
        status: "not_started",
        message: "Connecting to GPU... (SSH may still be starting)",
        error: result.output.slice(-500),
      });
    }

    // Parse output
    const { status, progressPercent, errorType } = parseStatusOutput(result.output);

    // PRIMARY TRIGGER: If the pod is running and SSH works but install.log doesn't
    // exist yet, this means the deploy script hasn't been executed. The deploy route
    // only creates the subscription + DB record — this endpoint is responsible for
    // triggering the actual script once the pod is ready (polled every ~10s by dashboard).
    if (status === "not_started") {
      const pendingDeployment = await prisma.huggingFaceDeployment.findFirst({
        where: { subscriptionId: resolvedSubscriptionId, status: { in: ["pending", "failed"] } },
        orderBy: { createdAt: "desc" },
      });

      if (pendingDeployment && !deployTriggersInFlight.has(resolvedSubscriptionId)) {
        deployTriggersInFlight.add(resolvedSubscriptionId);
        console.log(`[HF Status] Triggering deploy script for ${pendingDeployment.hfItemName} (deployment ${pendingDeployment.id}, status was ${pendingDeployment.status})`);

        // Fire-and-forget: run deploy script in background
        (async () => {
          try {
            const catalogItem = getCatalogItem(pendingDeployment.hfItemId);
            const deployScriptType = pendingDeployment.deployScript as DeployScriptType;

            const script = generateDeployScript(deployScriptType, {
              modelId: pendingDeployment.hfItemType !== "docker" ? pendingDeployment.hfItemId : undefined,
              dockerImage: catalogItem?.dockerImage,
              port: pendingDeployment.servicePort || getDefaultPort(deployScriptType),
              hfToken: pendingDeployment.hfToken || undefined,
              gpuCount: 1,
              openWebUI: pendingDeployment.openWebUI || false,
              netdata: pendingDeployment.netdata || false,
            });

            await prisma.huggingFaceDeployment.update({
              where: { id: pendingDeployment.id },
              data: { status: "deploying", errorMessage: null },
            });

            const scriptResult = await executeRemoteScript(
              host, port, username, password, script,
            );

            if (scriptResult.success) {
              console.log(`[HF Status] Deploy script started successfully for ${pendingDeployment.hfItemName}`);
              await prisma.huggingFaceDeployment.update({
                where: { id: pendingDeployment.id },
                data: { status: "deploying", deployOutput: scriptResult.output.slice(-5000) },
              });
            } else {
              console.error(`[HF Status] Deploy script failed (exit ${scriptResult.exitCode}): ${scriptResult.output.slice(-500)}`);
              await prisma.huggingFaceDeployment.update({
                where: { id: pendingDeployment.id },
                data: {
                  status: "failed",
                  errorMessage: `Deploy script failed with exit code ${scriptResult.exitCode}`,
                  deployOutput: scriptResult.output.slice(-5000),
                },
              });
            }
          } catch (triggerErr) {
            console.error(`[HF Status] Deploy trigger error:`, triggerErr);
          } finally {
            deployTriggersInFlight.delete(resolvedSubscriptionId);
          }
        })();
      }
    }

    // Parse GPU info
    const gpuInfoStart = result.output.indexOf("---GPUINFO---");
    const gpuInfoEnd = result.output.indexOf("---MODELINFO---");
    let gpuInfo: { memoryUsedMB?: number; memoryTotalMB?: number; utilization?: number } | undefined;
    if (gpuInfoStart > -1 && gpuInfoEnd > -1) {
      const gpuLine = result.output.slice(gpuInfoStart + 13, gpuInfoEnd).trim();
      if (gpuLine && gpuLine !== "N/A") {
        const parts = gpuLine.split(",").map(s => s.trim());
        if (parts.length >= 3) {
          gpuInfo = {
            memoryUsedMB: parseInt(parts[0], 10) || undefined,
            memoryTotalMB: parseInt(parts[1], 10) || undefined,
            utilization: parseInt(parts[2], 10) || undefined,
          };
        }
      }
    }

    // Parse model info
    const modelInfoStart = result.output.indexOf("---MODELINFO---");
    const logsStart = result.output.indexOf("---LOGS---");
    let modelLoadProgress: string | undefined;
    if (modelInfoStart > -1 && logsStart > -1) {
      const modelLine = result.output.slice(modelInfoStart + 15, logsStart).trim();
      if (modelLine && modelLine !== "N/A") {
        modelLoadProgress = modelLine;
      }
    }

    const logs = logsStart > -1 ? result.output.slice(logsStart + 10).trim() : "";

    // Build response with specific messages
    const statusMessages: Record<DeploymentStatus, string> = {
      not_started: "Deployment not started yet. Initializing...",
      installing: "Installing vLLM and dependencies... (5-10 minutes)",
      downloading: "Downloading model from HuggingFace... (depends on model size)",
      install_complete: "Installation complete, starting model server...",
      starting: "Loading model into GPU memory... (may take a few minutes)",
      running: "Model is running and ready to accept requests!",
      failed: "Deployment failed",
    };

    let message = statusMessages[status] || "Unknown status";
    if (status === "failed" && errorType && ERROR_MESSAGES[errorType]) {
      message = ERROR_MESSAGES[errorType];
    }

    // Get deployment record for additional info
    const deployment = await prisma.huggingFaceDeployment.findFirst({
      where: { subscriptionId: resolvedSubscriptionId },
      orderBy: { createdAt: "desc" },
    });

    // Calculate elapsed time
    const elapsedSeconds = deployment
      ? Math.floor((Date.now() - deployment.createdAt.getTime()) / 1000)
      : undefined;

    // Build response with simple and advanced views
    const response: StatusResponse = {
      // Simple view - always included
      status,
      message,
      progressPercent,
      error: errorType, // Include error code at top level for easy access

      // Advanced view - for power users
      advanced: {
        logs: logs.slice(-3000), // Last 3000 chars of logs
        sshCommand: `ssh ${username}@${host} -p ${port}`,
        podName: instance.name,
        podStatus: instance.status,
        startedAt: deployment?.createdAt?.toISOString(),
        elapsedSeconds,
        errorCode: errorType,
        gpuInfo,
        modelInfo: {
          modelId: deployment?.hfItemId,
          loadProgress: modelLoadProgress,
        },
      },
    };

    if (status === "running") {
      response.advanced!.apiEndpoint = `http://localhost:8000/v1`;
    }

    // TODO: Auto-expose vLLM port 8000 when model is ready
    // The legacy exposeService uses pool_subscription_id which doesn't work for unified instances.
    // Need HAI 2.2 expose API for instance-based port exposure.

    // Update database and send email if status has changed to final state
    if ((status === "running" || status === "failed") && deployment) {
      try {
        if (deployment.status !== status) {
          const previousStatus = deployment.status;
          console.log(`[HF Status] Updating deployment ${deployment.id}: ${previousStatus} -> ${status}`);

          // Update the deployment record
          await prisma.huggingFaceDeployment.update({
            where: { id: deployment.id },
            data: {
              status: status === "running" ? "running" : "failed",
              errorMessage: status === "failed" ? message : null,
            },
          });

          // Log activity
          await logActivity(
            payload.customerId,
            status === "running" ? "hf_deployment_running" : "hf_deployment_failed",
            `HuggingFace deployment ${status}: ${deployment.hfItemName}`,
            {
              deploymentId: deployment.id,
              hfItemId: deployment.hfItemId,
              errorType: errorType,
            }
          );

          // Send email when transitioning from in-progress state
          const wasInProgress = ["pending", "installing", "starting", "deploying", "downloading"].includes(previousStatus);
          if (wasInProgress && customer.email) {
            try {
              const dashboardToken = generateCustomerToken(payload.email.toLowerCase(), payload.customerId);
              const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?token=${dashboardToken}`;

              await sendHfDeploymentEmail({
                to: customer.email,
                customerName: customer.name || customer.email.split("@")[0],
                modelName: deployment.hfItemName,
                status: status === "running" ? "success" : "failed",
                errorMessage: status === "failed" ? message : undefined,
                dashboardUrl,
              });

              console.log(`[HF Status] Sent deployment email to ${customer.email} for ${deployment.hfItemName} (${status})`);
            } catch (emailError) {
              console.error("[HF Status] Failed to send email:", emailError);
            }
          }
        }
      } catch (dbError) {
        console.error("[HF Status] Failed to update database:", dbError);
      }
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error("[HF Status] Error:", error);
    return NextResponse.json(
      { error: "Failed to get deployment status" },
      { status: 500 }
    );
  }
}
