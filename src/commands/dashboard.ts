import { spawn } from "node:child_process";
import path from "node:path";
import { buildDashboard } from "./update";
import { parseBooleanFlags } from "../lib/args";
import { helpOptions, helpTitle, helpUsage, note, style, symbols } from "../lib/ui";

type DashboardOptions = {
  help: boolean;
  positionals: string[];
};

export async function dashboardCommand(args: string[] = []): Promise<void> {
  const options = parseOptions(args);
  const subcommand = options.positionals[0];
  if (!subcommand || options.help) {
    printHelp();
    return;
  }

  if (subcommand === "build") {
    const result = await buildDashboard();
    const rel = path.relative(process.cwd(), result.path);
    console.log(`  ${style.green(symbols.ok)} Dashboard built ${style.cyan(symbols.arrow)} ${style.cyan(rel)}`);
    note(`Open it: gd-metapro dashboard open`);
    return;
  }

  if (subcommand === "open") {
    const result = await buildDashboard();
    await openFile(result.path);
    const rel = path.relative(process.cwd(), result.path);
    console.log(`  ${style.green(symbols.ok)} Opened ${style.cyan(rel)}`);
    return;
  }

  console.log(`  ${style.red(symbols.cross)} Unknown dashboard command: ${subcommand}`);
  printHelp();
  process.exitCode = 1;
}

function parseOptions(args: string[]): DashboardOptions {
  const parsed = parseBooleanFlags(args, ["help"] as const);
  return {
    help: parsed.values.help,
    positionals: parsed.positionals,
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
  helpTitle("gd-metapro dashboard", "build and open the human dashboard");
  helpUsage([
    "gd-metapro dashboard build",
    "gd-metapro dashboard open",
    "gd-metapro dash",
  ]);
  helpOptions([
    { flag: "build", desc: "Rebuild .metaproject/gd-metapro-dashboard.html from existing service/data files." },
    { flag: "open", desc: "Rebuild and open .metaproject/gd-metapro-dashboard.html." },
  ]);
}
