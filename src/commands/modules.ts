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

/**
 * A module as this command understands it.
 *
 * `defaultEnabled` exists because a toggle re-invokes `init`, and what the
 * ABSENCE of a flag means depends on it — which is the whole of defect D1. For a
 * default-ON module, sending no flag keeps it. For a default-OFF module, sending
 * no flag REMOVES it: `init` writes the `mcp` manifest entry only when `--mcp`
 * is passed (`init.ts:595`). So a default-off module must re-send `enableFlag`
 * to survive an unrelated toggle, and before this field existed, enabling MCP
 * and then switching any other module silently dropped it.
 */
type ModuleDef = {
  name: string;
  /** The `--no-<name>` flag that disables it. */
  flag: string;
  desc: string;
  /** Does `init` scaffold this module unless told otherwise? */
  defaultEnabled: boolean;
  /** Required for a default-OFF module: the flag that keeps it enabled. */
  enableFlag?: string;
};

// name === the metaproject.json module key for every module.
const MODULES: ModuleDef[] = [
  { name: "gdgraph", flag: "--no-gdgraph", desc: "code graph, symbols, affected context", defaultEnabled: true },
  { name: "gdctx", flag: "--no-gdctx", desc: "token-aware command/read output", defaultEnabled: true },
  { name: "gdwiki", flag: "--no-gdwiki", desc: "project knowledge base", defaultEnabled: true },
  { name: "gdskills", flag: "--no-gdskills", desc: "bundled working skills", defaultEnabled: true },
  { name: "health", flag: "--no-health", desc: "quality scoring & gate", defaultEnabled: true },
  { name: "testing", flag: "--no-testing", desc: "test context & intelligence", defaultEnabled: true },
  { name: "memory", flag: "--no-memory", desc: "lessons, decisions, constraints", defaultEnabled: true },
  { name: "tasks", flag: "--no-tasks", desc: "agent-first flow lifecycle", defaultEnabled: true },
  { name: "security", flag: "--no-security", desc: "secrets, PII, injection, egress gate", defaultEnabled: true },
  {
    name: "mcp",
    flag: "--no-mcp",
    desc: "read-only MCP server (opt-in, off by default)",
    defaultEnabled: false,
    enableFlag: "--mcp",
  },
  {
    name: "sac",
    flag: "--no-sac",
    desc: "shared agent context: cross-session workspace propose/review (opt-in, off by default)",
    defaultEnabled: false,
    enableFlag: "--sac",
  },
];

/** The module table, for tests that assert its coverage. */
export function modulesForTest(): readonly ModuleDef[] {
  return MODULES;
}

/**
 * Build the `init` argv that reproduces `next` exactly.
 *
 * Both directions are stated, because the absence of a flag is not a neutral
 * value: for a default-off module it is a removal.
 */
export function buildInitFlags(next: Set<string>, profile: string): string[] {
  const flags = ["--yes", "--gdskills-profile", profile];
  for (const module of MODULES) {
    if (!next.has(module.name)) {
      flags.push(module.flag);
      continue;
    }
    if (!module.defaultEnabled && module.enableFlag !== undefined) {
      flags.push(module.enableFlag);
    }
  }
  return flags;
}

type Manifest = { modules?: Record<string, { enabled?: boolean; profile?: string }> };

export async function modulesCommand(args: string[] = []): Promise<void> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }

  // `--json` only ever describes state. It must never stand in for a
  // subcommand: `modules enable x --json` previously printed the UNCHANGED
  // state and exited 0 without enabling anything, which looks exactly like a
  // successful confirmation.
  const wantsJson = args.includes("--json") && (sub === undefined || sub === "status" || sub === "list" || sub === "--json");

  const metaprojectRoot = path.join(process.cwd(), ".metaproject");
  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    // A caller that asked for JSON gets JSON, including for the failure. Prose
    // on stdout would reach it as a parse error rather than a usable signal.
    if (wantsJson) {
      console.log(JSON.stringify({ schemaVersion: 1, error: "not-initialized", modules: [] }, null, 2));
    } else {
      console.log(`  ${style.red(symbols.cross)} Metaproject is not initialized.`);
      console.log(`  ${style.cyan(symbols.arrow)} Run ${style.cyan("keryx init")} first.`);
    }
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

  // `--json` is a pure projection of the state `printStatus` already renders,
  // sorted by module name so two runs are byte-identical and diffable — the
  // determinism `keryx commands --json` also guarantees.
  if (wantsJson) {
    console.log(emitModulesJson(enabled));
    return;
  }

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
  const flags = buildInitFlags(next, String(profile));
  heading("Applying");
  await initCommand(flags);
}

/**
 * Deterministic machine-readable module state, sorted by module name so the
 * payload is byte-stable regardless of `MODULES` authoring order — which is
 * what makes it safe to diff and to consume from a harness.
 */
export function emitModulesJson(enabled: Set<string>): string {
  const modules = [...MODULES]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((module) => ({
      name: module.name,
      enabled: enabled.has(module.name),
      description: module.desc,
    }));
  return JSON.stringify({ schemaVersion: 1, modules }, null, 2);
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
    "keryx modules --json",
    "keryx modules enable <name>",
    "keryx modules disable <name>",
  ]);
  helpOptions([
    { flag: "(no args)", desc: "Interactive enable/disable in a terminal; status view when piped." },
    { flag: "status, list", desc: "Show which modules are enabled." },
    { flag: "--json", desc: "Deterministic machine-readable module state." },
    { flag: "enable <name>", desc: `Enable and scaffold a module (${MODULES.map((module) => module.name).join(", ")}).` },
    { flag: "disable <name>", desc: "Disable a module." },
  ]);
}
