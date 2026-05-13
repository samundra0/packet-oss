import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import Table from "cli-table3";
import { apiRequest, type InstanceList } from "../api.js";
import { getApiKey } from "../config.js";

export const psCommand = new Command("ps")
  .description("List running GPU instances")
  .option("-a, --all", "Include terminated instances")
  .action(async (options) => {
    if (!getApiKey()) {
      console.log(chalk.yellow("\n  Not logged in. Run 'gpu-cloud login' first.\n"));
      process.exit(1);
    }

    const spinner = ora("Fetching instances...").start();

    try {
      const data = await apiRequest<InstanceList>("/instances");
      spinner.stop();

      let instances = data.instances || [];

      // Filter out terminated unless --all
      if (!options.all) {
        instances = instances.filter(
          (s) => !["terminated", "deleted", "cancelled", "un_subscribed"].includes(
            (s.status || "").toLowerCase()
          )
        );
      }

      if (instances.length === 0) {
        console.log(chalk.gray("\n  No running instances.\n"));
        console.log(chalk.gray("  Launch one with: gpu-cloud launch --gpu <type>\n"));
        return;
      }

      console.log(chalk.cyan("\n  GPU Instances\n"));

      const table = new Table({
        head: [
          chalk.white("ID"),
          chalk.white("Name"),
          chalk.white("GPU"),
          chalk.white("Status"),
          chalk.white("Uptime"),
        ],
        style: {
          head: [],
          border: ["gray"],
        },
      });

      for (const inst of instances) {
        const gpuType = inst.gpu?.model || "Unknown";
        const displayName = inst.metadata?.displayName || inst.name || "-";

        // Calculate uptime
        const created = inst.created_at ? new Date(inst.created_at) : null;
        let uptime = "-";
        if (created) {
          const diffMs = Date.now() - created.getTime();
          const hours = Math.floor(diffMs / (1000 * 60 * 60));
          const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
          uptime = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        }

        // Status with color
        let statusDisplay: string;
        const status = (inst.status || "").toLowerCase();
        if (status === "running" || status === "active") {
          statusDisplay = chalk.green("running");
        } else if (status === "starting" || status === "subscribing" || status === "pending") {
          statusDisplay = chalk.yellow("starting");
        } else if (status === "stopping" || status === "un_subscribing" || status === "terminating") {
          statusDisplay = chalk.yellow("terminating");
        } else if (status === "terminated" || status === "deleted" || status === "un_subscribed" || status === "stopped") {
          statusDisplay = chalk.gray("terminated");
        } else if (status === "error") {
          statusDisplay = chalk.red("error");
        } else {
          statusDisplay = chalk.gray(inst.status);
        }

        table.push([
          chalk.white(String(inst.id)),
          chalk.white(displayName),
          chalk.white(gpuType),
          statusDisplay,
          chalk.gray(uptime),
        ]);
      }

      console.log(table.toString());
      console.log(chalk.gray("\n  SSH: gpu-cloud ssh <id>  |  Terminate: gpu-cloud terminate <id>\n"));
    } catch (error) {
      spinner.fail("Failed to fetch instances");
      console.log(chalk.red(`\n  ${error instanceof Error ? error.message : "Unknown error"}\n`));
      process.exit(1);
    }
  });
