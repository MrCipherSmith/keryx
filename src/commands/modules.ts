import { readFile } from "node:fs/promises";
import { stdin } from "node:process";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { confirm } from "../lib/prompt";
import { initCommand } from "./init";
import {
  banner,
  heading,
  helpOptions,
  helpTitle,
  helpUsage,
  nextSteps,
  note,
  statusLine,
  style,
  symbols,
} from "../lib/ui";

type ModuleDef = { name: string; flag: string; desc: string };

// name === the metaproject.json module key for every module.
const MODULES: ModuleDef[] = [
  { name: "gdgraph", flag: "--no-gdgraph", desc: "code graph, symbols, affected context" },
  { name: "gdctx", flag: "--no-gdctx", desc: "token-aware command/read output" },
  { name: "gdwiki", flag: "--no-gdwiki", desc: "project knowledge base" },
  { name: "gdskills", flag: "--no-gdskills", desc: "bundled working skills" },
  { name: "health", flag: "--no-health", desc: "quality scoring & gate" },
  { name: "testing", flag: "--no-testing", desc: "test context & intelligence" },
  { name: "memory", flag: "--no-memory", desc: "lessons, decisions, constraints" },
  { name: "tasks", flag: "--no-tasks", desc: "agent-first flow lifecycle" },
];

type Manifest = { modules?: Record<string, { enabled?: boolean; profile?: string }> };

export async function modulesCommand(args: string[] = []): Promise<void> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }

  const metaprojectRoot = path.join(process.cwd(), ".metaproject");
  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    console.log(`  ${style.red(symbols.cross)} Metaproject is not initialized.`);
    console.log(`  ${style.cyan(symbols.arrow)} Run ${style.cyan("keryx init")} first.`);
    process.exitCode = 1;
    return;
  }

  let manifest: Manifest = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  } catch {
    // treat an unreadable manifest as empty; init will rebuild it
  }
  const enabled = new Set(
    MODULES.filter((module) => manifest.modules?.[module.name]?.enabled === true).map((module) => module.name),
  );

  if (sub === "status" || sub === "list" || (!sub && !stdin.isTTY)) {
    printStatus(enabled);
    return;
  }

  const next = new Set(enabled);

  if (sub === "enable" || sub === "on" || sub === "disable" || sub === "off") {
    const name = args[1];
    const def = MODULES.find((module) => module.name === name);
    if (!def) {
      console.log(
        `  ${style.red(symbols.cross)} Unknown module: ${name ?? "(none)"}. Known: ${MODULES.map((module) => module.name).join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
    const turnOn = sub === "enable" || sub === "on";
    if (turnOn) {
      next.add(def.name);
    } else {
      next.delete(def.name);
    }
  } else if (!sub || sub === "interactive" || sub === "-i") {
    banner("keryx modules", "Toggle Metaproject modules for this project");
    note("Press Enter to keep each module's current state.");
    heading("Modules");
    for (const module of MODULES) {
      const on = await confirm(`Enable ${module.name}? (${module.desc})`, enabled.has(module.name));
      if (on) {
        next.add(module.name);
      } else {
        next.delete(module.name);
      }
    }
  } else {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (setsEqual(enabled, next)) {
    note("No changes.");
    printStatus(next);
    return;
  }

  // Apply through init so newly enabled modules are fully scaffolded and the
  // manifest, index, and dashboard are regenerated consistently.
  const profile = manifest.modules?.gdskills?.profile ?? "recommended";
  const flags = ["--yes", "--gdskills-profile", String(profile)];
  for (const module of MODULES) {
    if (!next.has(module.name)) {
      flags.push(module.flag);
    }
  }
  heading("Applying");
  await initCommand(flags);
}

function printStatus(enabled: Set<string>): void {
  banner("keryx modules", `${enabled.size} of ${MODULES.length} modules enabled`);
  for (const module of MODULES) {
    statusLine(module.name, enabled.has(module.name), module.desc);
  }
  nextSteps([
    `Toggle one: ${style.cyan("keryx modules enable|disable <name>")}.`,
    `Interactive: run ${style.cyan("keryx modules")} in a terminal.`,
  ]);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

function printHelp(): void {
  helpTitle("keryx modules", "view and toggle Metaproject modules");
  helpUsage([
    "keryx modules",
    "keryx modules status",
    "keryx modules enable <name>",
    "keryx modules disable <name>",
  ]);
  helpOptions([
    { flag: "(no args)", desc: "Interactive enable/disable in a terminal; status view when piped." },
    { flag: "status, list", desc: "Show which modules are enabled." },
    { flag: "enable <name>", desc: `Enable and scaffold a module (${MODULES.map((module) => module.name).join(", ")}).` },
    { flag: "disable <name>", desc: "Disable a module." },
  ]);
}
