// `keryx external on|off|status|list` — flow 346's CLI surface for the
// EXTERNAL switch (`src/lib/external-switch.ts`, `src/lib/external-
// providers.ts`). ADAPTER: the CLI-zone glue over the SHARED-zone state and
// the CLIENT-zone credential check, mirroring every other `commands/*.ts`
// file's split.

import { resolveJevApiKey } from "../harness/decision/jev-client";
import {
  resolveExternalSetting,
  writeProjectExternalSetting,
  writeUserExternalSetting,
  type ExternalSetting,
} from "../lib/external-switch";
import { isProviderIdExternal, loadExternalProvidersConfig } from "../lib/external-providers";

function printExternalHelp(): void {
  console.log(
    [
      "Usage: keryx external <subcommand>",
      "",
      "  keryx external on [--project]",
      "                              Allow keryx to send private work to Jev/TypeSafe and other connected",
      "                              providers/models again (per-user by default, or this project's own override).",
      "  keryx external off [--project]",
      "                              Block every destination listed in external-providers.json before any",
      "                              network I/O (per-user by default, or this project's own override).",
      "  keryx external status [--json]",
      "                              The effective on/off state, which layer (project/user/default) set it,",
      "                              whether a Jev credential resolves, and what is blocked right now.",
      "  keryx external list [--json]",
      "                              The effective block list — every provider id and model pattern, with its",
      "                              reason — and where the list itself came from (default / user-edited file).",
    ].join("\n"),
  );
}

function parseOnOff(args: readonly string[], verb: "on" | "off"): { value: ExternalSetting; project: boolean } {
  const unknown = args.filter((arg) => arg !== "--project" && arg !== "--user");
  if (unknown.length > 0) {
    throw new Error(`Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx external ${verb}\`: ${unknown.join(", ")}. Accepted: --project.`);
  }
  return { value: verb, project: args.includes("--project") };
}

async function runOnOff(verb: "on" | "off", args: readonly string[]): Promise<void> {
  const { value, project } = parseOnOff(args, verb);
  const cwd = process.cwd();
  if (project) {
    await writeProjectExternalSetting(cwd, value);
    console.log(`external: ${value} (this project — .metaproject/tasks.config.json)`);
    return;
  }
  writeUserExternalSetting(value);
  console.log(`external: ${value} (this user — every project, unless a project sets its own override)`);
}

async function runStatus(args: readonly string[]): Promise<void> {
  const cwd = process.cwd();
  const resolved = await resolveExternalSetting({ cwd });
  const key = resolveJevApiKey(process.env);
  const jevAvailable = key !== undefined && key.length > 0;
  const { config, origin } = loadExternalProvidersConfig();
  const jevBlocked = resolved.value === "off" && isProviderIdExternal("jev", config);

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          external: resolved.value,
          source: resolved.source,
          jevCredentialAvailable: jevAvailable,
          jevBlocked,
          providersBlocked: resolved.value === "off" ? config.providers.map((p) => p.id) : [],
          modelPatternsBlocked: resolved.value === "off" ? config.modelPatterns.map((p) => p.pattern) : [],
          providersConfigOrigin: origin,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`external: ${resolved.value} (source: ${resolved.source})`);
  console.log(`jev credential: ${jevAvailable ? "available" : "not resolved (OPENROUTER_API_KEY / saved key)"}`);
  if (resolved.value === "off") {
    console.log(`jev: ${jevBlocked ? "blocked" : "not on the block list — would still run"}`);
    console.log(
      `blocked right now: ${config.providers.length} provider id(s), ${config.modelPatterns.length} model pattern(s) — see \`keryx external list\`.`,
    );
  } else {
    console.log("blocked right now: nothing — external is on.");
  }
}

async function runList(args: readonly string[]): Promise<void> {
  const { config, origin, path: file, warning } = loadExternalProvidersConfig();
  if (warning !== undefined) {
    console.error(warning);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify({ path: file, origin, config }, null, 2));
    return;
  }
  console.log(`# external providers — ${file}`);
  console.log("");
  console.log(
    origin === "user-file"
      ? "source: this file (edited or previously created)"
      : origin === "default-created"
        ? "source: built-in defaults (just created at this path)"
        : "source: built-in defaults (this run only — the file could not be used, see the warning above)",
  );
  console.log("");
  console.log("## providers");
  console.log("");
  if (config.providers.length === 0) {
    console.log("(none)");
  }
  for (const entry of config.providers) {
    console.log(`- ${entry.id}${entry.reason.length > 0 ? ` — ${entry.reason}` : ""}`);
  }
  console.log("");
  console.log("## model patterns");
  console.log("");
  if (config.modelPatterns.length === 0) {
    console.log("(none)");
  }
  for (const entry of config.modelPatterns) {
    console.log(`- ${entry.pattern}${entry.reason.length > 0 ? ` — ${entry.reason}` : ""}`);
  }
  console.log("");
  console.log(config.notes);
}

export async function externalCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printExternalHelp();
    return;
  }
  if (command === "on" || command === "off") {
    await runOnOff(command, args.slice(1));
    return;
  }
  if (command === "status") {
    await runStatus(args.slice(1));
    return;
  }
  if (command === "list") {
    await runList(args.slice(1));
    return;
  }
  console.error(`Unknown external command: ${command}`);
  printExternalHelp();
  process.exitCode = 1;
}
