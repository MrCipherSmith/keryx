// Native MCP-server configuration: user file, project files, personal overlay.
//
// P0 of `docs/requirements/keryx-mcp-servers/`. Native JSON only — the compat
// readers for Cursor/Claude/`.mcp.json`/Grok TOML are P3 and deliberately
// absent here rather than stubbed, so nothing reports a source it never read.
//
// Reads only. `keryx mcp add|enable|disable` writes through a separate seam;
// this module never touches `.metaproject/core/mcp/mcp.config.json`, which
// belongs to the inbound `keryx serve-mcp` surface.

import path from "node:path";
import { keryxConfigDir, isDefiniteAbsence, readConfigFile } from "../lib/config-dir";

/** One server as written in a config file. Shape mirrors the package schema. */
export type McpServerEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: "stdio" | "http" | "sse";
  headers?: Record<string, string>;
  bearer_token_env_var?: string;
  enabled?: boolean;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  tool_timeouts?: Record<string, number>;
};

export type McpServerSource = "project" | "user";

export type ResolvedMcpServer = McpServerEntry & {
  name: string;
  /** Which layer won this name. */
  source: McpServerSource;
  /** The file it came from, so `doctor` can name it. */
  file: string;
  /** After the entry's own `enabled` and the personal overlay. */
  enabled: boolean;
};

/**
 * Something wrong with a file, carried rather than thrown.
 *
 * A malformed project config must not take the session down — the same rule
 * AC8 states for a server that fails to start. It must also not vanish: a
 * config the operator wrote and this code could not read is the case where
 * silence sends them to debug the server instead of the JSON.
 */
export type McpConfigProblem = {
  file: string;
  message: string;
};

export type ResolvedMcpConfig = {
  servers: ResolvedMcpServer[];
  problems: McpConfigProblem[];
};

/**
 * The personal enable/disable overlay.
 *
 * A map, not a list of disabled names, and the difference is required rather
 * than stylistic. The specification says `enable` must clear a sticky
 * `enabled: false` "only in the user native file, never in a committed project
 * file" — so an operator has to be able to ENABLE a server a project file
 * disabled, which a disabled-names list cannot express. `true` and `false` are
 * both real entries; absent means "no personal opinion, take the file's".
 */
export type McpDisableOverlay = { overrides?: Record<string, boolean> };

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * The subset of legal server names that can actually be qualified.
 *
 * §3 allows a leading digit or hyphen; `catalog.ts`'s `FQN_PATTERN` requires
 * `^[a-zA-Z_]`. Both are right for their own job, and the gap between them is
 * a server that loads and connects while none of its tools can be named.
 * Enforced at load so the report names the cause.
 */
const FQN_SAFE_NAME = /^[A-Za-z_]/;

/**
 * `${VAR}` and `${VAR:-default}`, expanded at load.
 *
 * An unset variable with no default expands to the empty string rather than
 * throwing or leaving the literal `${VAR}` in place. Leaving the literal is
 * the worse of the three: it would be passed to a subprocess or sent as a
 * header, and the failure would surface far from the config that caused it.
 * The empty result is visible to `doctor`, which reports set/unset without
 * echoing the value.
 */
export function expandVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(VAR_PATTERN, (_match, name: string, fallback?: string) => {
    const found = env[name];
    if (found !== undefined && found !== "") {
      return found;
    }
    return fallback ?? "";
  });
}

/** Expansion applied to every field the specification names, and no others. */
function expandEntry(
  entry: McpServerEntry,
  env: Record<string, string | undefined>,
): McpServerEntry {
  const expanded: McpServerEntry = { ...entry };
  if (entry.command !== undefined) expanded.command = expandVars(entry.command, env);
  if (entry.url !== undefined) expanded.url = expandVars(entry.url, env);
  if (entry.args !== undefined) expanded.args = entry.args.map((arg) => expandVars(arg, env));
  if (entry.env !== undefined) {
    expanded.env = Object.fromEntries(
      Object.entries(entry.env).map(([key, value]) => [key, expandVars(value, env)]),
    );
  }
  if (entry.headers !== undefined) {
    expanded.headers = Object.fromEntries(
      Object.entries(entry.headers).map(([key, value]) => [key, expandVars(value, env)]),
    );
  }
  return expanded;
}

/**
 * Structural validation, in code rather than by loading the schema file.
 *
 * The schema in `docs/requirements/keryx-mcp-servers/schemas/` is the
 * specification. Shipping a second copy for the runtime to read is how two
 * copies drift; `config.schema-parity.test.ts` asserts these rules and that
 * file agree instead, so the specification stays the one that is authored and
 * this stays the one that runs.
 */
function entryProblems(name: string, entry: McpServerEntry): string[] {
  const problems: string[] = [];
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    problems.push(`server name "${name}" must match ^[A-Za-z0-9_-]+$`);
  } else if (!FQN_SAFE_NAME.test(name)) {
    // The name is legal per §3 but cannot be qualified: `catalog.ts` requires
    // an FQN starting with a letter or underscore, so `1password` would
    // connect, report a tool count, and have every one of its tools silently
    // dropped from the catalog. Said here, at load, instead of leaving the
    // operator to notice that a server they can see has no usable tools.
    problems.push(
      `server "${name}" must start with a letter or underscore; "${name}__<tool>" is not a usable tool name, so none of its tools could be offered`,
    );
  }

  const hasCommand = typeof entry.command === "string" && entry.command.length > 0;
  const hasUrl = typeof entry.url === "string" && entry.url.length > 0;
  if (hasCommand && hasUrl) {
    problems.push(`server "${name}" sets both command and url; it is stdio or HTTP, never both`);
  }
  if (!hasCommand && !hasUrl) {
    problems.push(`server "${name}" sets neither command nor url`);
  }

  // TYPES, not just presence. `expandEntry` calls `.map` on `args` and
  // `.replace` on every `env`/`headers` value; a config that says
  // `"args": "oops"` used to throw a TypeError straight out of
  // `loadMcpServers`, through `createMcpRuntime` — which is documented never
  // to throw — and take the whole shell down. One committed typo bricked
  // `keryx shell` for everyone who checked the repository out.
  if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string"))) {
    problems.push(`server "${name}" args must be an array of strings`);
  }
  for (const field of ["env", "headers"] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`server "${name}" ${field} must be an object of string values`);
      continue;
    }
    if (!Object.values(value).every((v) => typeof v === "string")) {
      problems.push(`server "${name}" ${field} values must all be strings`);
    }
  }
  for (const field of ["command", "url", "cwd", "bearer_token_env_var"] as const) {
    if (entry[field] !== undefined && typeof entry[field] !== "string") {
      problems.push(`server "${name}" ${field} must be a string`);
    }
  }
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
    // `"enabled": "false"` is a string, and every non-empty string is truthy
    // — so the server the operator meant to switch off used to start.
    problems.push(`server "${name}" enabled must be true or false, not ${JSON.stringify(entry.enabled)}`);
  }

  for (const [field, value] of [
    ["startup_timeout_sec", entry.startup_timeout_sec],
    ["tool_timeout_sec", entry.tool_timeout_sec],
  ] as const) {
    if (value !== undefined && !(typeof value === "number" && value > 0)) {
      problems.push(`server "${name}" ${field} must be a number greater than 0`);
    }
  }
  if (entry.tool_timeouts !== undefined) {
    const map = entry.tool_timeouts;
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      problems.push(`server "${name}" tool_timeouts must be an object`);
    } else if (!Object.values(map).every((v) => typeof v === "number" && v > 0)) {
      problems.push(`server "${name}" tool_timeouts values must all be numbers greater than 0`);
    }
  }
  return problems;
}

type ParsedFile = { servers: Record<string, McpServerEntry>; problems: McpConfigProblem[] };

/**
 * Read one config file.
 *
 * An ABSENT file yields no servers and no problem — not configuring MCP is
 * the normal case. Anything else that stopped the read is a problem carried
 * forward: `isDefiniteAbsence` exists precisely so "there is nothing there"
 * and "something is there and I could not read it" stay distinguishable.
 */
export function parseConfigFile(file: string): ParsedFile {
  const read = readConfigFile(file);
  if (!read.ok) {
    return isDefiniteAbsence(read.reason)
      ? { servers: {}, problems: [] }
      : { servers: {}, problems: [{ file, message: `could not be read (${read.reason})` }] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch (error) {
    return {
      servers: {},
      problems: [
        { file, message: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}` },
      ],
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { servers: {}, problems: [{ file, message: "must be a JSON object" }] };
  }
  const doc = parsed as { servers?: unknown };
  if (doc.servers === undefined) {
    return { servers: {}, problems: [{ file, message: "has no `servers` object" }] };
  }
  if (typeof doc.servers !== "object" || doc.servers === null || Array.isArray(doc.servers)) {
    return { servers: {}, problems: [{ file, message: "`servers` must be an object keyed by name" }] };
  }

  const servers: Record<string, McpServerEntry> = {};
  const problems: McpConfigProblem[] = [];
  for (const [name, value] of Object.entries(doc.servers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push({ file, message: `server "${name}" must be an object` });
      continue;
    }
    const entry = value as McpServerEntry;
    const found = entryProblems(name, entry);
    if (found.length > 0) {
      // Rejected, and said so. A malformed entry that is silently skipped is
      // indistinguishable from one that was never written.
      for (const message of found) problems.push({ file, message });
      continue;
    }
    servers[name] = entry;
  }
  return { servers, problems };
}

/**
 * Project config files from `cwd` up to and including the git root.
 *
 * Ordered SHALLOWEST first, so a later merge lets the deepest win by simple
 * overwrite. Stops at the git root when one is given; without it, walks to the
 * filesystem root, which is what a non-repository directory should do rather
 * than refusing to look at all.
 */
export function projectConfigFiles(cwd: string, gitRoot?: string): string[] {
  const files: string[] = [];
  let dir = path.resolve(cwd);
  const stop = gitRoot === undefined ? undefined : path.resolve(gitRoot);
  for (;;) {
    files.push(path.join(dir, ".keryx", "mcp-servers.json"));
    if (stop !== undefined && dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files.reverse();
}

export type LoadOptions = {
  cwd: string;
  gitRoot?: string | undefined;
  /** Overridden in tests; defaults to the real user config directory. */
  configDir?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
};

/**
 * Resolve every native config layer into one list.
 *
 * Merge is REPLACE per name, not a field merge, and project beats user. A
 * field merge would let a project file inherit half a user server's
 * definition — a command from one and args from another — which is a shape
 * nobody wrote and nobody could debug.
 */
export function loadMcpServers(options: LoadOptions): ResolvedMcpConfig {
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? keryxConfigDir();
  const problems: McpConfigProblem[] = [];

  const userFile = path.join(configDir, "mcp-servers.json");
  const user = parseConfigFile(userFile);
  problems.push(...user.problems);

  const winner = new Map<string, { entry: McpServerEntry; source: McpServerSource; file: string }>();
  for (const [name, entry] of Object.entries(user.servers)) {
    winner.set(name, { entry, source: "user", file: userFile });
  }

  for (const file of projectConfigFiles(options.cwd, options.gitRoot)) {
    const parsed = parseConfigFile(file);
    problems.push(...parsed.problems);
    for (const [name, entry] of Object.entries(parsed.servers)) {
      winner.set(name, { entry, source: "project", file });
    }
  }

  const overlayFile = path.join(configDir, "mcp-servers-disabled.json");
  const overlay = readOverlay(overlayFile);
  problems.push(...overlay.problems);

  const servers = [...winner.entries()]
    .map(([name, { entry, source, file }]) => {
      const expanded = expandEntry(entry, env);
      const personal = overlay.overrides[name];
      return {
        ...expanded,
        name,
        source,
        file,
        // The personal overlay wins over the file, in both directions. That is
        // what lets `enable` lift a committed `enabled: false` without editing
        // the project file.
        enabled: personal ?? entry.enabled ?? true,
      } satisfies ResolvedMcpServer;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { servers, problems };
}

function readOverlay(file: string): { overrides: Record<string, boolean>; problems: McpConfigProblem[] } {
  const read = readConfigFile(file);
  if (!read.ok) {
    return isDefiniteAbsence(read.reason)
      ? { overrides: {}, problems: [] }
      : { overrides: {}, problems: [{ file, message: `could not be read (${read.reason})` }] };
  }
  try {
    const parsed = JSON.parse(read.text) as McpDisableOverlay;
    const overrides = parsed.overrides;
    if (overrides === undefined) return { overrides: {}, problems: [] };
    const clean: Record<string, boolean> = {};
    for (const [name, value] of Object.entries(overrides)) {
      if (typeof value === "boolean") clean[name] = value;
    }
    return { overrides: clean, problems: [] };
  } catch {
    // Not fatal: a broken personal overlay must not hide the servers, it must
    // report itself and leave the files' own `enabled` in force.
    return { overrides: {}, problems: [{ file, message: "is not valid JSON; personal overrides ignored" }] };
  }
}
