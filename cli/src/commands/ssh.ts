import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { spawn } from "child_process";
import { apiRequest, type ConnectionInfo } from "../api.js";
import { getApiKey } from "../config.js";

/**
 * Parse an SSH command string into components.
 * Handles both "ssh -p PORT user@host" and "ssh user@host -p PORT" formats.
 */
function parseSSHCommand(cmd: string): { user: string; host: string; port: string } | null {
  // Format: ssh -p PORT user@host
  const match1 = cmd.match(/ssh\s+-p\s+(\d+)\s+(\S+)@(\S+)/);
  if (match1) return { user: match1[2], host: match1[3], port: match1[1] };

  // Format: ssh user@host -p PORT
  const match2 = cmd.match(/ssh\s+(\S+)@(\S+)\s+-p\s+(\d+)/);
  if (match2) return { user: match2[1], host: match2[2], port: match2[3] };

  return null;
}

export const sshCommand = new Command("ssh")
  .description("SSH into a GPU instance")
  .argument("<id>", "Instance ID")
  .option("-c, --command <cmd>", "Run a command instead of interactive shell")
  .option("--copy", "Just print the SSH command (don't connect)")
  .action(async (id, options) => {
    if (!getApiKey()) {
      console.log(chalk.yellow("\n  Not logged in. Run 'gpu-cloud login' first.\n"));
      process.exit(1);
    }

    const spinner = ora("Getting connection info...").start();

    try {
      const info = await apiRequest<ConnectionInfo>(
        `/instances/${id}/connection`
      );

      const conn = info.connection;

      if (!conn?.ssh_command) {
        spinner.fail("Instance not ready for SSH");
        console.log(chalk.gray("\n  The instance may still be starting. Try again in a moment.\n"));
        console.log(chalk.gray(`  Check status: gpu-cloud ps\n`));
        process.exit(1);
      }

      spinner.stop();

      const sshCmd = conn.ssh_command;
      const password = conn.password;
      const parsed = parseSSHCommand(sshCmd);

      if (options.copy) {
        console.log(chalk.cyan("\n  SSH Command:\n"));
        console.log(chalk.white(`  ${sshCmd}`));
        if (password) {
          console.log(chalk.gray(`  Password: ${password}`));
        }
        console.log();
        return;
      }

      console.log(chalk.cyan(`\n  Connecting to instance ${id}...`));
      if (password) {
        console.log(chalk.gray(`  Password: ${password}`));
      }
      console.log();

      if (!parsed) {
        // Can't parse the command, just print it
        console.log(chalk.yellow("  Could not auto-connect. Run manually:"));
        console.log(chalk.white(`  ${sshCmd}`));
        if (password) {
          console.log(chalk.gray(`  Password: ${password}`));
        }
        console.log();
        return;
      }

      const { user, host, port } = parsed;

      // Build SSH args
      const sshArgs = [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-p", port,
        `${user}@${host}`,
      ];

      if (options.command) {
        sshArgs.push(options.command);
      }

      // Check if sshpass is available for password auth
      if (password) {
        try {
          const sshpass = spawn("sshpass", ["-p", password, "ssh", ...sshArgs], {
            stdio: "inherit",
          });

          sshpass.on("error", () => {
            console.log(chalk.yellow("  Note: Install 'sshpass' for automatic password entry."));
            console.log(chalk.gray(`  Or manually enter password: ${password}\n`));

            const ssh = spawn("ssh", sshArgs, { stdio: "inherit" });
            ssh.on("close", (code) => process.exit(code || 0));
          });

          sshpass.on("close", (code) => process.exit(code || 0));
        } catch {
          const ssh = spawn("ssh", sshArgs, { stdio: "inherit" });
          ssh.on("close", (code) => process.exit(code || 0));
        }
      } else {
        const ssh = spawn("ssh", sshArgs, { stdio: "inherit" });
        ssh.on("close", (code) => process.exit(code || 0));
      }
    } catch (error) {
      spinner.fail("Failed to get connection info");
      console.log(chalk.red(`\n  ${error instanceof Error ? error.message : "Unknown error"}\n`));
      process.exit(1);
    }
  });
