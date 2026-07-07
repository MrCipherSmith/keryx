import { spawn } from "node:child_process";
import path from "node:path";
import { buildDashboard } from "./update";

type DashboardOptions = {
  help: boolean;
};

export async function dashboardCommand(args: string[] = []): Promise<void> {
  const subcommand = args[0];
  const options = parseOptions(args.slice(1));
  if (!subcommand || options.help || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  if (subcommand === "build") {
    const result = await buildDashboard();
    console.log(`dashboard: ${path.relative(process.cwd(), result.path)}`);
    return;
  }

  if (subcommand === "open") {
    const result = await buildDashboard();
    await openFile(result.path);
    console.log(`dashboard: ${path.relative(process.cwd(), result.path)}`);
    return;
  }

  console.error(`Unknown dashboard command: ${subcommand}`);
  printHelp();
  process.exitCode = 1;
}

function parseOptions(args: string[]): DashboardOptions {
  return {
    help: args.includes("--help") || args.includes("-h"),
  };
}

async function openFile(filePath: string): Promise<void> {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed with exit code ${code}`));
    });
  });
}

function printHelp(): void {
  console.log(`gd-metapro dashboard

Usage:
  gd-metapro dashboard build
  gd-metapro dashboard open

Commands:
  build   Rebuild .metaproject/gd-metapro-dashboard.html from existing service/data files
  open    Rebuild and open .metaproject/gd-metapro-dashboard.html
`);
}
