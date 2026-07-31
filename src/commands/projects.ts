// `keryx projects` — inspect and maintain the user-global project registry
// (flow 127 / roadmap R4a).
//
// The registry answers which projects this install was initialized in. It is
// populated by `keryx init`; this command is how an operator sees it, adds a
// project that predates the registry, and removes one deliberately.

import path from "node:path";
import {
  emitProjectsJson,
  forgetProject,
  listProjects,
  projectRegistryPath,
  registerProject,
  sanitizeForDisplay,
} from "../lib/project-registry";
import { helpOptions, helpTitle, helpUsage, note, statusLine, style, symbols } from "../lib/ui";

export async function projectsCommand(args: string[] = []): Promise<void> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }

  // A KNOWN leading flag means the default subcommand: `keryx projects --json`
  // otherwise fell through to the unknown-subcommand branch and printed help
  // with exit 1, which is not what a machine consumer that omits `list` expects.
  //
  // Only known flags, deliberately: accepting anything dash-leading made
  // `projects --jsonn` print human output with exit 0, so a typo looked like
  // success and produced unparseable stdout.
  const LIST_FLAGS = new Set(["--json"]);
  if (sub === undefined || sub === "list" || LIST_FLAGS.has(sub)) {
    // Every flag is validated, not just a leading one. Guarding only the
    // shortcut left the DOCUMENTED form open: `projects list --jsonn` still
    // printed human output with exit 0, which is the defect this check exists
    // for, on the form the help text tells people to use.
    const unknown = args.filter(
      (arg) => arg.startsWith("-") && !LIST_FLAGS.has(arg) && arg !== "--help" && arg !== "-h",
    );
    if (unknown.length > 0) {
      console.error(`Unknown option: ${sanitizeForDisplay(unknown[0]!)}`);
      printHelp();
      process.exitCode = 1;
      return;
    }
    runList(args.includes("--json"));
    return;
  }

  if (sub === "register") {
    runRegister(args[1]);
    return;
  }

  if (sub === "forget") {
    runForget(args[1]);
    return;
  }

  console.error(`Unknown projects command: ${sanitizeForDisplay(sub)}`);
  printHelp();
  process.exitCode = 1;
}

function runList(asJson: boolean): void {
  const warnings: string[] = [];
  const entries = listProjects(undefined, (message) => warnings.push(message));

  if (asJson) {
    // Warnings travel in the payload: without them a machine consumer cannot
    // tell a corrupt registry from an empty one — both would be an empty list
    // with a success exit code.
    console.log(emitProjectsJson(entries, warnings));
    return;
  }

  for (const warning of warnings) {
    console.log(`  ${style.yellow(symbols.bullet)} ${warning}`);
  }

  if (entries.length === 0) {
    note("No projects registered yet. `keryx init` registers a project; `keryx projects register <path>` adds one explicitly.");
    return;
  }

  const missing = entries.filter((entry) => entry.state === "missing").length;
  console.log(`  ${entries.length} project(s) registered${missing > 0 ? `, ${missing} missing` : ""}`);
  console.log("");
  for (const entry of entries) {
    // A missing project is shown, not hidden: the operator decides whether the
    // path is gone for good or merely not mounted right now.
    //
    // Both fields come from directory names, so they are stripped of control
    // characters before printing — otherwise a directory name containing ANSI
    // escapes rewrites the operator's terminal.
    statusLine(sanitizeForDisplay(entry.displayName), entry.state === "active", sanitizeForDisplay(entry.path));
  }
  console.log("");
  console.log(`  registry: ${projectRegistryPath()}`);
}

function runRegister(target: string | undefined): void {
  if (target === undefined) {
    console.error("Usage: keryx projects register <path>");
    process.exitCode = 1;
    return;
  }
  const result = registerProject(target, {
    onWarn: (message) => console.log(`  ${style.yellow(symbols.bullet)} ${message}`),
  });
  if (!result.ok) {
    console.error(`  ${style.red(symbols.cross)} ${result.message}`);
    process.exitCode = 1;
    return;
  }
  const verb = result.created ? "registered" : "already registered (refreshed)";
  console.log(`  ${style.green(symbols.ok)} ${sanitizeForDisplay(result.entry.displayName)} ${verb}`);
  console.log(`    ${style.dim(sanitizeForDisplay(result.entry.path))}`);
}

function runForget(projectId: string | undefined): void {
  if (projectId === undefined) {
    console.error("Usage: keryx projects forget <id>   (see `keryx projects list --json` for ids)");
    process.exitCode = 1;
    return;
  }
  // The two failures are reported distinctly. Telling the operator "no such id"
  // when the removal merely failed to persist leaves them believing the project
  // is gone while it is still registered.
  const outcome = forgetProject(projectId, undefined, (message) =>
    console.log(`  ${style.yellow(symbols.bullet)} ${message}`),
  );
  if (outcome === "not-found") {
    console.error(`  ${style.red(symbols.cross)} No registered project with id ${sanitizeForDisplay(projectId)}.`);
    process.exitCode = 1;
    return;
  }
  if (outcome === "write-failed") {
    console.error(
      `  ${style.red(symbols.cross)} ${sanitizeForDisplay(projectId)} is still registered: the registry could not be written.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  ${style.green(symbols.ok)} Forgotten: ${sanitizeForDisplay(projectId)}`);
}

function printHelp(): void {
  helpTitle("keryx projects", "inspect the user-global registry of initialized projects");
  helpUsage([
    "keryx projects list [--json]",
    "keryx projects register <path>",
    "keryx projects forget <id>",
  ]);
  helpOptions([
    { flag: "list", desc: "Show every registered project and whether its path still exists." },
    { flag: "--json", desc: "Deterministic machine-readable output." },
    { flag: "register <path>", desc: "Register an already-initialized project explicitly (idempotent)." },
    { flag: "forget <id>", desc: "Remove one entry. The only way an entry is ever removed." },
  ]);
  note(`Registry: ${projectRegistryPath()} — addressing only, never credentials.`);
}

/**
 * Register the project `keryx init` just created. Best-effort by design: a
 * registry that cannot be written must not fail the init it was recording, so a
 * failure is reported and init continues.
 */
export function registerInitializedProject(projectRoot: string, log: (message: string) => void): void {
  const result = registerProject(projectRoot, {
    displayName: path.basename(path.resolve(projectRoot)),
    onWarn: (message) => log(`  ${style.yellow(symbols.bullet)} ${message}`),
  });
  if (!result.ok) {
    log(`  ${style.yellow(symbols.bullet)} project registry: ${result.message}`);
    return;
  }
  if (result.created) {
    log(`  ${style.green(symbols.ok)} registered in the project registry`);
  }
}
