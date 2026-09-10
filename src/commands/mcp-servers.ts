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
import { defaultServerCwd, handshakeBudgetMs, KILL_GRACE_MS } from "../mcp-servers/runtime";
import {
  addServer,
  projectConfigFile,
  removeServer,
  setServerEnabled,
  userConfigFile,
  type McpScope,
} from "../mcp-servers/store";
import {
  approveServer,
  describeForApproval,
  loadTrustStore,
  requiresApproval,
  revokeServer,
} from "../mcp-servers/trust";

/** The subcommands this module owns. `mcp.ts` routes on exactly this set. */
export const MCP_CONSUMER_SUBCOMMANDS = [
  "list",
  "add",
  "remove",
  "enable",
  "disable",
  "trust",
  "untrust",
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
    case "trust":
      return trustCommand(args, deps, true);
    case "untrust":
      return trustCommand(args, deps, false);
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
  const wantJson = splitAtSeparator(args).own.includes("--json");

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

  const approvals = loadTrustStore(deps.configDir);
  let held = 0;
  for (const server of config.servers) {
    const tags = [`(${server.source})`];
    if (!server.enabled) tags.push("(disabled)");
    if (requiresApproval(server, approvals)) {
      tags.push("(needs approval)");
      held++;
    }
    deps.log(`${server.name} ${tags.join(" ")} ${transportOf(server)} — ${describeTarget(server)}`);
  }
  if (held > 0) {
    // Said once, at the bottom, rather than left for the operator to work
    // out from a tag: a server that is configured and silently not running
    // is the state they will otherwise debug as "it does not connect".
    deps.log("");
    deps.log(
      `${held} project server(s) are not started until approved — a committed config is code someone else wrote.`,
    );
    deps.log("Read what it launches above, then: keryx mcp trust <name>");
  }
  return config.problems.length > 0 ? 1 : 0;
}

/**
 * The one-line summary `list` prints — from the RAW entry, never the
 * expanded one.
 *
 * `{"args": ["--token=${GITHUB_TOKEN}"]}` printed expanded put a live token
 * on the terminal and into whatever the operator pastes. `doctor` already
 * followed the redaction rule for `env`/`headers`; `command`, `args` and
 * `url` expand too, and `list` followed it nowhere.
 */
function describeTarget(server: ResolvedMcpServer): string {
  const raw = server.raw;
  if (typeof raw.url === "string" && raw.url.length > 0) return raw.url;
  return [raw.command, ...(raw.args ?? [])].filter(Boolean).join(" ");
}

/**
 * `add <name> -- <command…>` or `add --transport http <name> <url>`.
 *
 * The `--` is required for the stdio form and not a convention: the server's
 * own flags are indistinguishable from keryx's without it, and guessing would
 * mean `keryx mcp add fs -- npx pkg --json` silently eats `--json`.
 */
function addCommand(argv: readonly string[], deps: McpConsumerDeps): number {
  // EVERY keryx flag is read from `own` — the part BEFORE `--`. Reading them
  // from the whole argv is the bug this separator exists to prevent, and the
  // one this function used to have: `keryx mcp add fs -- mycmd --scope
  // project` put the server in the committed project file because the CHILD
  // command happened to take a `--scope`. Same for `--force` (silently
  // overwriting an existing server), `-e` (inventing an environment variable
  // from the child's own flag) and `--transport` (failing with an error
  // naming flags the operator never typed).
  const { own, rest: afterSeparator, hasSeparator } = splitAtSeparator(argv);

  const scope = parseScope(own);
  if (scope === undefined) {
    deps.err("--scope must be user or project");
    return 1;
  }

  const transport = optionValue(own as string[], "--transport");
  const flagless = own.filter((arg, index, all) => !isFlagOrValue(arg, index, all));
  const unknown = own.filter((arg, index, all) => isUnknownFlag(arg, index, all));
  if (unknown.length > 0) {
    // Otherwise `--verbose` survives the positional filter, matches
    // SERVER_NAME_PATTERN (hyphens are legal) and becomes the server NAME,
    // while the name the operator typed is dropped. Exit 0, wrong result.
    deps.err(`unknown option ${unknown[0]}. keryx flags go before \`--\`; the server's own flags go after it.`);
    return 1;
  }
  const repeated = repeatedFlags(own);
  if (repeated.length > 0) {
    // `--scope user --scope project` silently used the FIRST — a scope the
    // operator did not ask for, chosen in silence, exit 0. Same class as
    // the typo above.
    deps.err(`${repeated[0]} was given more than once; it takes a single value`);
    return 1;
  }

  const name = flagless[0];
  if (name === undefined) {
    deps.err("usage: keryx mcp add <name> -- <command…>   |   keryx mcp add --transport http <name> <url>");
    return 1;
  }

  let entry: McpServerEntry;
  if (transport === undefined || transport === "stdio") {
    if (!hasSeparator || afterSeparator.length === 0) {
      deps.err(`keryx mcp add ${name} needs the server command after \`--\`, e.g. \`-- npx -y some-server\``);
      return 1;
    }
    const [command, ...rest] = afterSeparator;
    if (command === undefined) {
      deps.err(`keryx mcp add ${name} needs the server command after \`--\``);
      return 1;
    }
    const env = parseEnv(own, deps);
    if (env === null) return 1;
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
    const headers = parseHeaders(own, deps);
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
    force: own.includes("--force"),
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
  const own = splitAtSeparator(args).own;
  const unknown = own.filter((arg, index, all) => isUnknownFlag(arg, index, all));
  if (unknown.length > 0) {
    deps.err(`unknown option ${unknown[0]}`);
    return 1;
  }
  const scope = parseScope(own);
  if (scope === undefined) {
    deps.err("--scope must be user or project");
    return 1;
  }
  const name = positional(args);
  if (name === undefined) {
    deps.err("usage: keryx mcp remove <name> [--scope user|project]");
    return 1;
  }

  const explicit = optionValue(own as string[], "--scope") !== undefined;
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
  const server = config.servers.find((candidate) => candidate.name === name);
  if (server === undefined) {
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

  // The layer that WON the merge is the one being toggled, and the only
  // one whose sticky flag it may touch.
  const result = setServerEnabled({ name, enabled, source: server.source, configDir: deps.configDir });
  if (!result.ok) {
    deps.err(result.error);
    return 1;
  }
  deps.log(`${enabled ? "Enabled" : "Disabled"} "${name}" for this account (${result.file}).`);
  return 0;
}

/**
 * `trust <name>` / `untrust <name>` — approve the exact command a committed
 * config would launch.
 *
 * Prints what will run BEFORE recording anything. An approval prompt whose
 * subject the operator cannot see is a formality.
 */
function trustCommand(args: readonly string[], deps: McpConsumerDeps, approve: boolean): number {
  const name = positional(args);
  if (name === undefined) {
    deps.err(`usage: keryx mcp ${approve ? "trust" : "untrust"} <name>`);
    return 1;
  }

  const config = load(deps);
  const server = config.servers.find((candidate) => candidate.name === name);
  if (server === undefined) {
    deps.err(
      config.servers.length === 0
        ? `no server named "${name}" — no MCP servers are configured`
        : `no server named "${name}". Configured: ${config.servers.map((s) => s.name).join(", ")}`,
    );
    return 1;
  }

  if (server.source !== "project") {
    // Nothing to approve: the operator wrote this file themselves, on this
    // machine. Asking them to confirm their own `keryx mcp add` would train
    // them to say yes without reading.
    deps.err(`"${name}" is a user-scope server; only project-scope servers need approval.`);
    return 1;
  }

  const result = approve ? approveServer(server, deps.configDir) : revokeServer(server, deps.configDir);
  if (!result.ok) {
    deps.err(result.error);
    return 1;
  }

  if (approve) {
    deps.log(`Approved "${name}" from ${server.file}:`);
    deps.log(`  ${describeForApproval(server)}`);
    deps.log("It will start with the next shell. Editing that command revokes this approval.");
  } else {
    deps.log(`Withdrew approval for "${name}". It will not be started.`);
  }
  return 0;
}

async function doctorCommand(args: readonly string[], deps: McpConsumerDeps): Promise<number> {
  const config = load(deps);
  const only = positional(args);

  // `doctor` is the command most likely to be interrupted — it is the one
  // that sits for the whole startup budget — and it had no cancellation
  // path whatsoever: no signal handler, and `defaultConnect` passed no
  // `AbortSignal`. Ctrl-C left the child reparented to init.
  const dialling = new AbortController();
  const kills: Array<Promise<void>> = [];
  const onSignal = (): void => {
    dialling.abort();
    void Promise.race([Promise.all(kills), new Promise((r) => setTimeout(r, KILL_GRACE_MS))]).then(() => {
      process.exit(130);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const approvals = loadTrustStore(deps.configDir);
  let report;
  try {
    report = await runDoctor(config, {
      only,
      connect: deps.connect ?? ((server) => defaultConnect(server, dialling.signal, kills)),
      heldForApproval: (server) => requiresApproval(server, approvals),
    });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  if (splitAtSeparator(args).own.includes("--json")) {
    deps.log(JSON.stringify(report, null, 2));
  } else {
    deps.log(formatDoctorReport(report));
  }
  return report.healthy ? 0 : 1;
}

async function defaultConnect(
  server: ResolvedMcpServer,
  signal?: AbortSignal,
  kills?: Array<Promise<void>>,
): Promise<McpServerConnection> {
  const command = server.command;
  if (command === undefined || command === "") {
    throw new Error(`server "${server.name}" has no command; only stdio servers are dialled in this release`);
  }
  return connectStdioMcpServer(
    [command, ...(server.args ?? [])],
    {
      // The SAME resolution the shell uses (`defaultServerCwd`). These two
      // disagreed: the shell ran a project server from its project root and
      // `doctor` ran it from the process cwd, so a server that resolves
      // relative paths behaved differently under the command whose whole job
      // is to tell you whether it will work.
      cwd: server.cwd ?? defaultServerCwd(server),
      env: buildMcpChildEnv({ parent: process.env, serverEnv: server.env }),
    },
    handshakeBudgetMs(server),
    signal,
    kills,
  );
}

/**
 * `--scope user|project`, defaulting to user.
 *
 * A PRESENT `--scope` with no usable value is an error, not the default.
 * `optionValue` returns undefined both when the flag is absent and when it
 * is last on the line, so `add fs --scope -- mycmd` silently wrote the user
 * file — indistinguishable from not passing `--scope` at all, which is the
 * one thing the operator was trying not to do by typing it.
 */
function parseScope(args: readonly string[]): McpScope | undefined {
  const present = args.some((arg) => arg === "--scope" || arg.startsWith("--scope="));
  const raw = optionValue(args as string[], "--scope");
  if (raw === undefined) return present ? undefined : "user";
  return raw === "user" || raw === "project" ? raw : undefined;
}

/**
 * Repeatable `-e KEY=value`.
 *
 * `undefined` = none given. `null` = one was malformed and has been reported;
 * the caller must abort. Dropping a malformed pair silently is how
 * `-e PATH` (no `=`) used to add the server with no `env` at all and exit 0 —
 * the operator believes they configured something they did not.
 */
function parseEnv(args: readonly string[], deps: McpConsumerDeps): Record<string, string> | undefined | null {
  const env: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "-e" && args[index] !== "--env") continue;
    const pair = args[index + 1];
    if (pair === undefined) {
      deps.err(`${args[index]} needs a KEY=value argument`);
      return null;
    }
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      deps.err(`-e "${pair}" must be in KEY=value form`);
      return null;
    }
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
    if (raw === undefined) {
      // Silently dropping this is a silent auth drop when it is an
      // Authorization header.
      deps.err("--header needs a \"Name: value\" argument");
      return undefined;
    }
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

/**
 * Split argv at the first bare `--`.
 *
 * Everything BEFORE it is keryx's; everything after belongs to the server
 * being launched and must never be read for keryx's own flags. Both halves
 * are returned, plus whether the separator was actually present — absent and
 * empty are different (`add x --` has a separator and no command, which is
 * an error worth naming rather than the same error as forgetting it).
 */
function splitAtSeparator(argv: readonly string[]): {
  own: readonly string[];
  rest: readonly string[];
  hasSeparator: boolean;
} {
  const at = argv.indexOf("--");
  if (at === -1) return { own: argv, rest: [], hasSeparator: false };
  return { own: argv.slice(0, at), rest: argv.slice(at + 1), hasSeparator: true };
}

function isFlagOrValue(arg: string, index: number, all: readonly string[]): boolean {
  if (VALUE_FLAGS.has(arg) || BARE_FLAGS.has(arg)) return true;
  if (arg.startsWith("--") && arg.includes("=")) return true;
  const previous = all[index - 1];
  return previous !== undefined && VALUE_FLAGS.has(previous);
}

/**
 * A dash-led token this module does not know.
 *
 * Without this, `--verbose` is not recognised as a flag, so it survives the
 * positional filter — and because `SERVER_NAME_PATTERN` allows hyphens it is
 * then a perfectly valid server NAME. `keryx mcp add --verbose vv -- cmd`
 * created a server called `--verbose` and dropped `vv`, exit 0.
 */
/** A keryx flag given more than once. `optionValue` takes the first and says nothing. */
function repeatedFlags(args: readonly string[]): string[] {
  const seen = new Map<string, number>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    const previous = args[index - 1];
    if (previous !== undefined && VALUE_FLAGS.has(previous)) continue;
    if (!arg.startsWith("-")) continue;
    const name = arg.startsWith("--") && arg.includes("=") ? (arg.split("=")[0] as string) : arg;
    // Repeatable by design; the rest are not.
    if (name === "-e" || name === "--env" || name === "--header") continue;
    if (!VALUE_FLAGS.has(name) && !BARE_FLAGS.has(name)) continue;
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
}

function isUnknownFlag(arg: string, index: number, all: readonly string[]): boolean {
  if (!arg.startsWith("-") || arg === "-") return false;
  const previous = all[index - 1];
  // A value that merely happens to look like a flag (`-e -x=1`) is not one.
  if (previous !== undefined && VALUE_FLAGS.has(previous)) return false;

  // The equals form is checked by NAME, not by shape. `isFlagOrValue`
  // returns true for any `--x=y`, so routing this through it let
  // `--scop=project` — a typo — be silently ignored: exit 0, server
  // written to the default scope, nothing said. `--verbose` was refused
  // and `--verbose=1` was not.
  const name = arg.startsWith("--") && arg.includes("=") ? (arg.split("=")[0] as string) : arg;
  return !VALUE_FLAGS.has(name) && !BARE_FLAGS.has(name);
}

function positional(args: readonly string[]): string | undefined {
  return splitAtSeparator(args).own.filter((arg, index, all) => !isFlagOrValue(arg, index, all))[0];
}
