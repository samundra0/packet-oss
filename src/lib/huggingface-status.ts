/**
 * Shared HuggingFace deployment status helpers
 * Used by both /api/huggingface/deploy-status and /api/cron/check-hf-deployments
 */

import { spawn } from "child_process";
import { validateSSHParams } from "@/lib/ssh-validation";

const MAX_SSH_RETRIES = 2;

export type DeploymentStatus =
  | "not_started"
  | "installing"
  | "downloading"
  | "install_complete"
  | "starting"
  | "running"
  | "failed";

export interface ParsedStatus {
  status: DeploymentStatus;
  progressPercent?: number;
  errorType?: string;
}

/**
 * Execute a quick command on a remote pod via SSH with retry logic
 */
export async function executeRemoteCommand(
  host: string,
  port: number,
  username: string,
  password: string,
  command: string,
  timeoutMs: number = 20000,
  retryCount: number = 0
): Promise<{ success: boolean; output: string }> {
  validateSSHParams({ host, port, username });

  return new Promise((resolve) => {
    const args = [
      "-e",
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=15",
      "-o", "ServerAliveInterval=10",
      "-o", "ServerAliveCountMax=2",
      "-p", String(port),
      `${username}@${host}`,
      command,
    ];

    let stdout = "";
    let stderr = "";

    const proc = spawn("sshpass", args, {
      timeout: timeoutMs,
      env: { ...process.env, SSHPASS: password },
    });

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", async (code) => {
      if (code !== 0 && retryCount < MAX_SSH_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
        const retryResult = await executeRemoteCommand(host, port, username, password, command, timeoutMs, retryCount + 1);
        resolve(retryResult);
        return;
      }
      resolve({ success: code === 0, output: stdout + stderr });
    });

    proc.on("error", async (err) => {
      if (retryCount < MAX_SSH_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
        const retryResult = await executeRemoteCommand(host, port, username, password, command, timeoutMs, retryCount + 1);
        resolve(retryResult);
        return;
      }
      resolve({ success: false, output: `Failed: ${err.message}` });
    });
  });
}

/**
 * Execute a deploy script on a remote pod via SSH (longer timeout)
 */
export async function executeRemoteScript(
  host: string,
  port: number,
  username: string,
  password: string,
  script: string,
  timeoutMs: number = 300000
): Promise<{ success: boolean; output: string; exitCode: number }> {
  validateSSHParams({ host, port, username });

  return new Promise((resolve) => {
    const encodedScript = Buffer.from(script).toString("base64");
    const remoteCommand = `echo '${encodedScript}' | base64 -d | bash`;

    const args = [
      "-e",
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=30",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-p", String(port),
      `${username}@${host}`,
      remoteCommand,
    ];

    let stdout = "";
    let stderr = "";

    const proc = spawn("sshpass", args, {
      timeout: timeoutMs,
      env: { ...process.env, SSHPASS: password },
    });

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      resolve({
        success: code === 0,
        output: stdout + (stderr ? `\nSTDERR: ${stderr}` : ""),
        exitCode: code || 0,
      });
    });

    proc.on("error", (err) => {
      resolve({
        success: false,
        output: `Failed to execute: ${err.message}`,
        exitCode: -1,
      });
    });
  });
}

/**
 * Parse SSH command string to extract connection details
 */
export function parseSSHCommand(cmd: string): { host: string; port: number; username: string } {
  const userHostMatch = cmd.match(/(\w+)@([^\s]+)/);
  const username = userHostMatch ? userHostMatch[1] : "ubuntu";
  const host = userHostMatch ? userHostMatch[2] : "localhost";

  const portMatch = cmd.match(/-p\s+(\d+)/);
  const port = portMatch ? parseInt(portMatch[1], 10) : 22;

  return { host, port, username };
}

/**
 * Shell script that checks vLLM deployment status on a remote pod.
 * Returns STATUS:xxx, PROGRESS:xxx, and optionally ERROR:xxx lines.
 */
export const STATUS_CHECK_SCRIPT = `
  WORKSPACE="$HOME/hf-workspace"

  if [ ! -f "$WORKSPACE/install.log" ]; then
    echo "STATUS:not_started"
    echo "PROGRESS:0"
    exit 0
  fi

  INSTALL_DONE=false
  if grep -q "INSTALL_COMPLETE" "$WORKSPACE/install.log" 2>/dev/null; then
    INSTALL_DONE=true
  fi

  DOWNLOADING=false
  if grep -E -q "Downloading|Fetching.*files|download.*model" "$WORKSPACE/install.log" 2>/dev/null; then
    if ! grep -q "INSTALL_COMPLETE" "$WORKSPACE/install.log" 2>/dev/null; then
      DOWNLOADING=true
    fi
  fi

  SERVER_RUNNING=false
  if pgrep -f "vllm.entrypoints" > /dev/null 2>&1; then
    SERVER_RUNNING=true
  fi

  SERVER_HEALTHY=false
  if curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/health 2>/dev/null | grep -q "200"; then
    SERVER_HEALTHY=true
  elif curl -s http://localhost:8000/v1/models 2>/dev/null | grep -q "data"; then
    SERVER_HEALTHY=true
  fi

  HAS_NVSHARE_ERROR=false
  HAS_CUDA_OOM=false
  HAS_GPU_MEMORY_LOW=false
  HAS_ENGINE_INIT_FAILED=false
  HAS_MODEL_NOT_FOUND=false
  HAS_AUTH_ERROR=false

  if [ -f "$WORKSPACE/vllm.log" ]; then
    if grep -E -q "nvshare_connect|haishare|scheduler.sock|No such file or directory.*haishare" "$WORKSPACE/vllm.log" 2>/dev/null; then
      HAS_NVSHARE_ERROR=true
    fi
    if grep -E -q "CUDA out of memory|OutOfMemoryError|torch.OutOfMemoryError|torch.cuda.OutOfMemoryError" "$WORKSPACE/vllm.log" 2>/dev/null; then
      HAS_CUDA_OOM=true
    fi
    if grep -q "Free memory on device.*less than desired" "$WORKSPACE/vllm.log" 2>/dev/null; then
      HAS_GPU_MEMORY_LOW=true
    fi
    if grep -E -q "Engine core initialization failed|Failed core proc|EngineCore failed to start|Failed to initialize engine" "$WORKSPACE/vllm.log" 2>/dev/null; then
      HAS_ENGINE_INIT_FAILED=true
    fi
    if grep -E -q "Model.*not found|repository.*not found|Could not find model" "$WORKSPACE/vllm.log" 2>/dev/null; then
      HAS_MODEL_NOT_FOUND=true
    fi
    if grep -E -q "401 Client Error|Access denied|Unauthorized|gated repo" "$WORKSPACE/vllm.log" 2>/dev/null; then
      HAS_AUTH_ERROR=true
    fi
  fi

  if [ "$SERVER_HEALTHY" = true ]; then
    echo "STATUS:running"
    echo "PROGRESS:100"
  elif [ "$HAS_AUTH_ERROR" = true ]; then
    echo "STATUS:failed"
    echo "PROGRESS:0"
    echo "ERROR:AUTH_ERROR"
  elif [ "$HAS_MODEL_NOT_FOUND" = true ]; then
    echo "STATUS:failed"
    echo "PROGRESS:0"
    echo "ERROR:MODEL_NOT_FOUND"
  elif [ "$HAS_NVSHARE_ERROR" = true ]; then
    echo "STATUS:failed"
    echo "PROGRESS:0"
    echo "ERROR:GPU_SCHEDULER_ERROR"
  elif [ "$HAS_CUDA_OOM" = true ]; then
    echo "STATUS:failed"
    echo "PROGRESS:0"
    echo "ERROR:CUDA_OOM"
  elif [ "$HAS_ENGINE_INIT_FAILED" = true ]; then
    echo "STATUS:failed"
    echo "PROGRESS:0"
    echo "ERROR:ENGINE_INIT_FAILED"
  elif [ "$HAS_GPU_MEMORY_LOW" = true ]; then
    echo "STATUS:failed"
    echo "PROGRESS:0"
    echo "ERROR:GPU_MEMORY_LOW"
  elif [ "$SERVER_RUNNING" = true ]; then
    echo "STATUS:starting"
    echo "PROGRESS:80"
  elif [ "$DOWNLOADING" = true ]; then
    echo "STATUS:downloading"
    echo "PROGRESS:50"
  elif [ "$INSTALL_DONE" = true ]; then
    echo "STATUS:install_complete"
    echo "PROGRESS:70"
  else
    echo "STATUS:installing"
    echo "PROGRESS:20"
  fi
`;

/**
 * Parse the output of the status check script into structured data
 */
export function parseStatusOutput(output: string): ParsedStatus {
  const statusMatch = output.match(/STATUS:(\w+)/);
  const status = (statusMatch?.[1] || "not_started") as DeploymentStatus;

  const progressMatch = output.match(/PROGRESS:(\d+)/);
  const progressPercent = progressMatch ? parseInt(progressMatch[1], 10) : undefined;

  const errorMatch = output.match(/ERROR:(\w+)/);
  const errorType = errorMatch?.[1];

  return { status, progressPercent, errorType };
}

/**
 * Error messages for known failure types
 */
export const ERROR_MESSAGES: Record<string, string> = {
  GPU_SCHEDULER_ERROR: "GPU scheduler service unavailable. This is a temporary infrastructure issue. Please terminate this GPU and launch a new one.",
  ENGINE_INIT_FAILED: "Failed to initialize GPU. The model could not start on this GPU. Try terminating and launching a new GPU.",
  CUDA_OOM: "Not enough GPU memory for this model. Try a smaller model or a GPU with more VRAM.",
  GPU_MEMORY_LOW: "Insufficient GPU memory available. The model is too large for this GPU. Try a smaller model or a GPU with more VRAM.",
  POD_TERMINATED: "The GPU pod terminated unexpectedly. Please terminate this deployment and try again.",
  MODEL_NOT_FOUND: "Model not found on HuggingFace. Please check the model ID is correct.",
  AUTH_ERROR: "Authentication failed. This model may require a HuggingFace token. Please add your token and try again.",
  DEPLOYMENT_TIMEOUT: "Deployment timed out after 2 hours. The model may be too large or encountered an issue. Please terminate and try again.",
};
