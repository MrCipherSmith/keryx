// `keryx mcp list|add|remove|enable|disable|doctor` — the CONSUMER surface.
//
// P0 items 7 and 8. `keryx mcp` used to mean "keryx is an MCP server"; that
// spelling is retired (D-04, `./mcp.ts`) and the verb now means "the MCP
// servers keryx connects to". These are the subcommands of that meaning.
//
// Every handler returns an exit code instead of calling `process.exit`, and
// prints through injected sinks instead of `console`. That is what lets the
// tests assert what an operator would actually see — a command that reports
// success it did not achieve is the defect class this package keeps turning
// up, and it is only catchable if the output is a value.

import { optionValue } from "../lib/args";
import { resolveProjectRoot } from "../lib/contained-path";
import { connectStdioMcpServer, type McpServerConnection } from "../mcp-client/client";
import {
  loadMcpServers,
  parseConfigFile,
  type McpServerEntry,
  type ResolvedMcpConfig,
  type ResolvedMcpServer,
} from "../mcp-servers/config";
import {
  formatDoctorReport,
  redactValues,
  runDoctor,
  transportOf,
} from "../mcp-servers/doctor";
import type { ConnectFn } from "../mcp-servers/manager";
import { buildMcpChildEnv } from "../mcp-servers/spawn-env";
import {
  addServer,
  projectConfigFile,
  removeServer,
  setServerEnabled,
  userConfigFile,
  type McpScope,
} from "../mcp-servers/store";

/** The subcommands this module owns. `mcp.ts` routes on exactly this set. */
export const MCP_CONSUMER_SUBCOMMANDS = [
  "list",
  "add",
  "remove",
  "enable",
  "disable",
  "doctor",
] as const;

export type McpConsumerSubcommand = (typeof MCP_CONSUMER_SUBCOMMANDS)[number];

export function isMcpConsumerSubcommand(value: string | undefined): value is McpConsumerSubcommand {
  return (MCP_CONSUMER_SUBCOMMANDS as readonly string[]).includes(value ?? "");
}

export type McpConsumerDeps = {
  readonly cwd: string;
  /** Overridden in tests; otherwise the real user config directory. */
  readonly configDir?: string | undefined;
  /** Overridden in tests; otherwise walked up from `cwd`. */
  readonly projectRoot?: string | undefined;
  /** Overridden in tests; otherwise spawns the server. */
  readonly connect?: ConnectFn | undefined;
  readonly log: (line: string) => void;
  readonly err: (line: string) => void;
};

export async function runMcpConsumerCommand(
  subcommand: McpConsumerSubcommand,
  args: readonly string[],
  deps: McpConsumerDeps,
): Promise<number> {
  switch (subcommand) {
    case "list":
      return listCommand(args, deps);
    case "add":
      return addCommand(args, deps);
    case "remove":
      return removeCommand(args, deps);
    case "enable":
      return toggleCommand(args, deps, true);
    case "disable":
      return toggleCommand(args, deps, false);
    case "doctor":
      return doctorCommand(args, deps);
  }
}

function projectRootOf(deps: McpConsumerDeps): string {
  return deps.projectRoot ?? resolveProjectRoot(deps.cwd);
}

function load(deps: McpConsumerDeps): ResolvedMcpConfig {
  const root = projectRootOf(deps);
  return loadMcpServers({ cwd: deps.cwd, gitRoot: root, configDir: deps.configDir });
}

/** Redacted view of one server, safe to print or paste into an issue. */
function publicView(server: ResolvedMcpServer): Record<string, unknown> {
  return {
    name: server.name,
    source: server.source,
    file: server.file,
    transport: transportOf(server),
    enabled: server.enabled,
    // The same rule `doctor` follows, for the same reason: `env` and `headers`
    // hold tokens, and `--json` output is what gets pasted into a bug report.
    env: redactValues(server.env),
    headers: redactValues(server.headers),
  };
}

function listCommand(args: readonly string[], deps: McpConsumerDeps): number {
  const config = load(deps);
  const wantJson = args.includes("--json");

  if (wantJson) {
    deps.log(JSON.stringify({ servers: config.servers.map(publicView), problems: config.problems }, null, 2));
    return config.problems.length > 0 ? 1 : 0;
  }

  for (const problem of config.problems) {
    deps.err(`config problem — ${problem.file}: ${problem.message}`);
  }

  if (config.servers.length === 0) {
    // Naming the files is the point. "No servers" over a config the operator
    // just wrote, in a path keryx does not read, is the case where an empty
    // list sends them to debug the wrong thing.
    deps.log("No MCP servers configured.");
    deps.log(`  user:    ${userConfigFile(deps.configDir)}`);
    deps.log(`  project: ${projectConfigFile(projectRootOf(deps))}`);
    return config.problems.length > 0 ? 1 : 0;
  }

  for (const server of config.servers) {
    const tags = [`(${server.source})`];
    if (!server.enabled) tags.push("(disabled)");
    deps.log(`${server.name} ${tags.join(" ")} ${transportOf(server)} — ${describeTarget(server)}`);
  }
  return config.problems.length > 0 ? 1 : 0;
}

function describeTarget(server: ResolvedMcpServer): string {
  if (typeof server.url === "string" && server.url.length > 0) return server.url;
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
}

/**
 * `add <name> -- <command…>` or `add --transport http <name> <url>`.
 *
 * The `--` is required for the stdio form and not a convention: the server's
 * own flags are indistinguishable from keryx's without it, and guessing would
 * mean `keryx mcp add fs -- npx pkg --json` silently eats `--json`.
 */
function addCommand(args: readonly string[], deps: McpConsumerDeps): number {
  const scope = parseScope(args);
  if (scope === undefined) {
    deps.err("--scope must be user or project");
    return 1;
  }

  const transport = optionValue(args as string[], "--transport");
  const separator = args.indexOf("--");
  const flagless = (separator === -1 ? args : args.slice(0, separator)).filter(
    (arg, index, all) => !isFlagOrValue(arg, index, all),
  );

  const name = flagless[0];
  if (name === undefined) {
    deps.err("usage: keryx mcp add <name> -- <command…>   |   keryx mcp add --transport http <name> <url>");
    return 1;
  }

  let entry: McpServerEntry;
  if (transport === undefined || transport === "stdio") {
    if (separator === -1 || args.length <= separator + 1) {
      deps.err(`keryx mcp add ${name} needs the server command after \`--\`, e.g. \`-- npx -y some-server\``);
      return 1;
    }
    const [command, ...rest] = args.slice(separator + 1);
    if (command === undefined) {
      deps.err(`keryx mcp add ${name} needs the server command after \`--\``);
      return 1;
    }
    const env = parseEnv(args);
    entry = {
      command,
      ...(rest.length > 0 ? { args: rest } : {}),
      ...(env === undefined ? {} : { env }),
    };
  } else if (transport === "http" || transport === "sse") {
    // sse is an alias of http (D-06): the distinction is a transport detail
    // the client negotiates, not two different servers to configure.
    const url = flagless[1];
    if (url === undefined) {
      deps.err(`keryx mcp add --transport ${transport} ${name} needs a URL`);
      return 1;
    }
    const headers = parseHeaders(args, deps);
    if (headers === undefined) return 1;
    entry = { url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  } else {
    deps.err(`--transport must be stdio, http or sse (got "${transport}")`);
    return 1;
  }

  const result = addServer({
    name,
    entry,
    scope,
    force: args.includes("--force"),
    configDir: deps.configDir,
    projectRoot: projectRootOf(deps),
  });

  if (!result.ok) {
    deps.err(result.error);
    return 1;
  }
  deps.log(`Added "${name}" to ${result.file}${result.created ? " (created)" : ""}.`);
  deps.log(`Run \`keryx mcp doctor ${name}\` to check it connects.`);
  return 0;
}

function removeCommand(args: readonly string[], deps: McpConsumerDeps): number {
  const scope = parseScope(args);
  if (scope === undefined) {
    deps.err("--scope must be user or project");
    return 1;
  }
  const name = positional(args);
  if (name === undefined) {
    deps.err("usage: keryx mcp remove <name> [--scope user|project]");
    return 1;
  }

  const explicit = optionValue(args as string[], "--scope") !== undefined;
  const projectRoot = projectRootOf(deps);

  if (!explicit) {
    // Which scopes actually define it decides whether the omission is safe.
    // Removing from a guessed scope is a delete the operator did not ask for.
    const defining = definingScopes(name, deps, projectRoot);
    if (defining.length === 0) {
      deps.err(`server "${name}" is not defined in either native config file.`);
      deps.err(`  user:    ${userConfigFile(deps.configDir)}`);
      deps.err(`  project: ${projectConfigFile(projectRoot)}`);
      return 1;
    }
    if (defining.length > 1) {
      deps.err(`server "${name}" is defined in both scopes; pass --scope user or --scope project.`);
      return 1;
    }
    return finishRemove(name, defining[0] as McpScope, deps, projectRoot);
  }

  return finishRemove(name, scope, deps, projectRoot);
}

function finishRemove(
  name: string,
  scope: McpScope,
  deps: McpConsumerDeps,
  projectRoot: string,
): number {
  const result = removeServer({ name, scope, configDir: deps.configDir, projectRoot });
  if (!result.ok) {
    deps.err(result.error);
    return 1;
  }
  deps.log(`Removed "${name}" from ${result.file}.`);
  return 0;
}

/** Which native files define this name, read from the resolved layers. */
function definingScopes(name: string, deps: McpConsumerDeps, projectRoot: string): McpScope[] {
  // `loadMcpServers` reports the WINNING layer only, so a name in both files
  // would look like one. The two files are read directly for this question.
  const scopes: McpScope[] = [];
  for (const [scope, file] of [
    ["user", userConfigFile(deps.configDir)],
    ["project", projectConfigFile(projectRoot)],
  ] as const) {
    const parsed = parseServersOf(file);
    if (parsed.has(name)) scopes.push(scope);
  }
  return scopes;
}

function parseServersOf(file: string): Set<string> {
  return new Set(Object.keys(parseConfigFile(file).servers));
}

function toggleCommand(args: readonly string[], deps: McpConsumerDeps, enabled: boolean): number {
  const name = positional(args);
  const verb = enabled ? "enable" : "disable";
  if (name === undefined) {
    deps.err(`usage: keryx mcp ${verb} <name>`);
    return 1;
  }

  const config = load(deps);
  if (!config.servers.some((server) => server.name === name)) {
    // A toggle for a name nothing defines writes an overlay entry that will
    // never apply to anything. Saying so beats writing it and reporting
    // success.
    deps.err(
      config.servers.length === 0
        ? `no server named "${name}" — no MCP servers are configured`
        : `no server named "${name}". Configured: ${config.servers.map((s) => s.name).join(", ")}`,
    );
    return 1;
  }

  const result = setServerEnabled({ name, enabled, configDir: deps.configDir });
  if (!result.ok) {
    deps.err(result.error);
    return 1;
  }
  deps.log(`${enabled ? "Enabled" : "Disabled"} "${name}" for this account (${result.file}).`);
  return 0;
}

async function doctorCommand(args: readonly string[], deps: McpConsumerDeps): Promise<number> {
  const config = load(deps);
  const only = positional(args);
  const report = await runDoctor(config, {
    only,
    connect: deps.connect ?? defaultConnect,
  });

  if (args.includes("--json")) {
    deps.log(JSON.stringify(report, null, 2));
  } else {
    deps.log(formatDoctorReport(report));
  }
  return report.healthy ? 0 : 1;
}

async function defaultConnect(server: ResolvedMcpServer): Promise<McpServerConnection> {
  const command = server.command;
  if (command === undefined || command === "") {
    throw new Error(`server "${server.name}" has no command; only stdio servers are dialled in this release`);
  }
  return connectStdioMcpServer([command, ...(server.args ?? [])], {
    cwd: server.cwd ?? process.cwd(),
    env: buildMcpChildEnv({ parent: process.env, serverEnv: server.env }),
  });
}

function parseScope(args: readonly string[]): McpScope | undefined {
  const raw = optionValue(args as string[], "--scope");
  if (raw === undefined) return "user";
  return raw === "user" || raw === "project" ? raw : undefined;
}

/** Repeatable `-e KEY=value`. Returns undefined when none were given. */
function parseEnv(args: readonly string[]): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "-e" && args[index] !== "--env") continue;
    const pair = args[index + 1];
    if (pair === undefined) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/** Repeatable `--header "K: V"`. Undefined signals a malformed one, already reported. */
function parseHeaders(
  args: readonly string[],
  deps: McpConsumerDeps,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--header") continue;
    const raw = args[index + 1];
    if (raw === undefined) continue;
    const colon = raw.indexOf(":");
    if (colon <= 0) {
      deps.err(`--header "${raw}" must be in "Name: value" form`);
      return undefined;
    }
    headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
  }
  return headers;
}

/** Flags this module consumes, so the first bare word is the server name. */
const VALUE_FLAGS = new Set(["--scope", "--transport", "-e", "--env", "--header"]);
const BARE_FLAGS = new Set(["--json", "--force"]);

function isFlagOrValue(arg: string, index: number, all: readonly string[]): boolean {
  if (VALUE_FLAGS.has(arg) || BARE_FLAGS.has(arg)) return true;
  if (arg.startsWith("--") && arg.includes("=")) return true;
  const previous = all[index - 1];
  return previous !== undefined && VALUE_FLAGS.has(previous);
}

function positional(args: readonly string[]): string | undefined {
  const stop = args.indexOf("--");
  const scanned = stop === -1 ? args : args.slice(0, stop);
  return scanned.filter((arg, index, all) => !isFlagOrValue(arg, index, all))[0];
}
