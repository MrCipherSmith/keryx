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
import { compatFiles, readCompatFile } from "./compat";

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
  /**
   * OAuth for a remote server. `false` opts out entirely.
   *
   * Validated since P0 and untyped until P3b, which is why nothing
   * could read it: the loader checked six rules about a field the
   * type system said did not exist.
   */
  oauth?: false | { clientId?: string; scopes?: string[]; callbackPort?: number };
};

/**
 * Which layer a server came from.
 *
 * The compat values are separate rather than one `"compat"` because
 * `keryx mcp list` tags each row, and "go edit the file it came from"
 * is only actionable if the row says which tool wrote it.
 */
export type McpServerSource = "project" | "user" | "cursor" | "claude" | "mcp.json" | "grok";

export type ResolvedMcpServer = McpServerEntry & {
  name: string;
  /** Which layer won this name. */
  source: McpServerSource;
  /**
   * Did this come from a file a REPOSITORY can commit?
   *
   * The question the trust gate asks, and the one `source` cannot
   * answer: `.cursor/mcp.json` exists both in the operator's home,
   * which they wrote, and in the project, which whoever they cloned
   * from wrote. Same tag, opposite trust.
   *
   * D-14 was implemented as `source !== "project"`, which was correct
   * when `.keryx/mcp-servers.json` was the only committable source. The
   * moment compat readers added `.mcp.json`, `.cursor/mcp.json` and
   * `.grok/config.toml` under the project, that check stopped asking
   * the right question — and a cloned repository could run a command
   * at session start with no approval, which is exactly the hole D-14
   * exists to close.
   */
  projectLocal: boolean;
  /** The file it came from, so `doctor` can name it. */
  file: string;
  /** After the entry's own `enabled` and the personal overlay. */
  enabled: boolean;
  /**
   * The entry EXACTLY as written, before `${VAR}` expansion.
   *
   * Everything human-readable prints from this, and nothing else may. The
   * expanded fields above are what gets executed; they hold the resolved
   * value of `--token=${GITHUB_TOKEN}`, and `keryx mcp list` used to echo
   * that to the terminal. `${GITHUB_TOKEN}` is both safer to print and more
   * useful to read — it says which variable the server needs.
   */
  raw: McpServerEntry;
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
 * The longest server name that still leaves room for a tool.
 *
 * `FQN_PATTERN` caps `server__tool` at 64. Reserving 24 characters for
 * `__` plus a tool name is a judgement, not a derivation — but the
 * alternative, which is what shipped, is a name that loads cleanly and
 * makes some or all of its tools unreachable with nothing said.
 */
export const MAX_SERVER_NAME_LENGTH = 40;

/** The only document version this keryx understands. Absent reads as this. */
export const SCHEMA_VERSION = 1;

/**
 * `JSON.parse`, minus a leading byte-order mark.
 *
 * EXPORTED and shared, because the first version of this put the strip in
 * `parseConfigFile` alone — one of the three readers of these same files.
 * The result was two surfaces disagreeing about one file: `keryx mcp list`
 * read a BOM'd config perfectly while `keryx mcp add` refused it, and
 * `keryx mcp enable` reported success while silently skipping the
 * sticky-flag cleanup. Worse, a BOM on the OVERLAY made `disable` not take
 * effect: the overrides were "ignored" and the server started.
 *
 * Windows editors write a BOM by default. It is not a syntax error the
 * operator made.
 */
export function parseJsonTolerant(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
}

/**
 * The largest timeout that survives `setTimeout`.
 *
 * Anything above 2^31-1 ms overflows and Node silently substitutes 1 ms —
 * so `startup_timeout_sec: 1e400` (which parses to Infinity, is a number,
 * and is greater than zero) produced a server timed out after one
 * millisecond and reported `failed`. Observed as a `TimeoutOverflowWarning`.
 */
export const MAX_TIMEOUT_SEC = 24 * 60 * 60;

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
  } else if (name.length > MAX_SERVER_NAME_LENGTH) {
    // Length, not just the leading character. `FQN_PATTERN` bounds
    // `server__tool` at 64 characters, so a long server name silently
    // costs tools: at 56 characters a plausible name
    // (`github-copilot-language-server-for-the-monorepo-frontend`) loaded
    // with zero problems, reported `connected`, and dropped every tool
    // whose qualified name exceeded the limit — and `startServers` reports
    // `toolCount` without `skipped`, so in a shell there was no signal at
    // all. The bound here leaves room for a short tool name; anything
    // longer is refused where the operator can act on it.
    problems.push(
      `server name "${name}" is ${name.length} characters; the limit is ${MAX_SERVER_NAME_LENGTH}, because "<server>__<tool>" must fit in 64 and a longer name silently drops tools`,
    );
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
  // A PRESENT but empty `url` is a leftover, not an absence. Treating it as
  // absent let `{"command":"x","url":""}` load as stdio, so deleting the
  // value of a `url` silently changed the transport instead of failing.
  if (entry.url !== undefined && !hasUrl && typeof entry.url === "string") {
    problems.push(`server "${name}" has an empty url; remove the field or give it a value`);
  }
  if (entry.command !== undefined && !hasCommand && typeof entry.command === "string") {
    problems.push(`server "${name}" has an empty command; remove the field or give it a value`);
  }
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
  const oauth = (entry as { oauth?: unknown }).oauth;
  if (oauth !== undefined && oauth !== false) {
    if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) {
      problems.push(`server "${name}" oauth must be an object or false`);
    } else {
      // The INTERIOR too. The first pass checked only "object or false",
      // which left six schema-specified rules unenforced — and the
      // "unknown fields round-trip" allowance covers unknown fields, not a
      // known one's contents. Latent while P0 does not dial OAuth, which
      // is the reason to pin it now rather than after it does.
      problems.push(...oauthProblems(name, oauth as Record<string, unknown>));
    }
  }
  if (entry.type !== undefined && !["stdio", "http", "sse"].includes(entry.type)) {
    problems.push(`server "${name}" type must be stdio, http or sse`);
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
    if (value !== undefined && !(typeof value === "number" && Number.isFinite(value) && value > 0)) {
      problems.push(`server "${name}" ${field} must be a finite number greater than 0`);
    } else if (value !== undefined && value > MAX_TIMEOUT_SEC) {
      problems.push(`server "${name}" ${field} must be at most ${MAX_TIMEOUT_SEC} seconds`);
    }
  }
  if (entry.tool_timeouts !== undefined) {
    const map = entry.tool_timeouts;
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      problems.push(`server "${name}" tool_timeouts must be an object`);
    } else if (
      !Object.values(map).every(
        (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_TIMEOUT_SEC,
      )
    ) {
      problems.push(
        `server "${name}" tool_timeouts values must all be finite numbers between 0 and ${MAX_TIMEOUT_SEC}`,
      );
    }
  }
  return problems;
}

/** `$defs/oauth` from the schema, enforced. */
function oauthProblems(name: string, oauth: Record<string, unknown>): string[] {
  const problems: string[] = [];
  // Every field `$defs/oauth` declares. Omitting `clientSecretEnvVar` made
  // the runtime STRICTER than the specification, so a legal document was
  // refused — the parity failure in the opposite direction from the usual.
  const known = new Set(["clientId", "clientSecretEnvVar", "scopes", "callbackPort"]);
  for (const key of Object.keys(oauth)) {
    if (!known.has(key)) problems.push(`server "${name}" oauth has unknown field "${key}"`);
  }
  for (const field of ["clientId", "clientSecretEnvVar"] as const) {
    if (oauth[field] !== undefined && typeof oauth[field] !== "string") {
      problems.push(`server "${name}" oauth.${field} must be a string`);
    }
  }
  if (oauth.scopes !== undefined) {
    if (!Array.isArray(oauth.scopes) || !oauth.scopes.every((v) => typeof v === "string")) {
      problems.push(`server "${name}" oauth.scopes must be an array of strings`);
    }
  }
  if (typeof oauth.clientSecretEnvVar === "string" && oauth.clientSecretEnvVar !== "") {
    // ACCEPTED BY THE SCHEMA, IMPLEMENTED BY NOTHING.
    //
    // Said out loud rather than ignored, because the silent version is
    // the dangerous one: keryx registers `token_endpoint_auth_method:
    // "none"`, so a server configured as a confidential client would
    // authenticate as a public one and the operator would never learn
    // that the secret they configured was not used.
    problems.push(
      `server "${name}" oauth.clientSecretEnvVar is not implemented; keryx authenticates as a public client and this value is ignored`,
    );
  }
  const port = oauth.callbackPort;
  if (port !== undefined && !(typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535)) {
    problems.push(`server "${name}" oauth.callbackPort must be an integer between 1 and 65535`);
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
    parsed = parseJsonTolerant(read.text);
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
  // `schemaVersion` was never checked at all. `schemaVersion: 2` means the
  // file was written by a later keryx; reading it and applying v1 semantics
  // without a word is how a newer field's meaning gets quietly ignored.
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (version !== undefined && version !== SCHEMA_VERSION) {
    return {
      servers: {},
      problems: [
        {
          file,
          message:
            typeof version === "number" && Number.isInteger(version) && version > SCHEMA_VERSION
              ? `declares schemaVersion ${version}; this keryx understands ${SCHEMA_VERSION}. Upgrade keryx rather than have it guess.`
              : `schemaVersion must be ${SCHEMA_VERSION} (got ${JSON.stringify(version)})`,
        },
      ],
    };
  }
  if (typeof doc.servers !== "object" || doc.servers === null || Array.isArray(doc.servers)) {
    return { servers: {}, problems: [{ file, message: "`servers` must be an object keyed by name" }] };
  }

  // `Object.create(null)`, not `{}`. A server named `__proto__` passes the
  // name rule and `servers[name] = entry` then hits `Object.prototype`'s
  // setter instead of creating an own property — so the file loaded with
  // ZERO problems and ZERO servers. No pollution, but exactly the
  // load-clean-and-produce-nothing shape this package keeps finding.
  const servers: Record<string, McpServerEntry> = Object.create(null) as Record<string, McpServerEntry>;
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

/**
 * Sentinel home for an isolated run: a path nothing can live under.
 *
 * Not `undefined`, because that means "use the real home"; not a real
 * temp dir, because then an isolated run could still pick something up.
 */
const NO_HOME = path.join(path.sep, "\u0000keryx-no-home");

export type LoadOptions = {
  cwd: string;
  gitRoot?: string | undefined;
  /** Overridden in tests; defaults to the real user config directory. */
  configDir?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  /**
   * The home directory the compat readers look in. Overridden in tests.
   *
   * A test that let this default to the real `os.homedir()` would read
   * the developer's own Cursor and Claude configs, so its result would
   * depend on who ran it — and it would pass on a clean CI box while
   * failing on the machine of anyone who uses those tools.
   */
  home?: string | undefined;
  /** Set false to read native config only. Used by `store.ts`'s writers. */
  compat?: boolean | undefined;
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

  const winner = new Map<
    string,
    { entry: McpServerEntry; source: McpServerSource; file: string; projectLocal: boolean }
  >();

  // COMPAT FIRST, so native overwrites it. Native is what keryx owns and
  // what `add` writes; a compat source is a courtesy read of a file
  // whose author never agreed to keryx's semantics, so it must never
  // shadow the operator's own keryx config. Within compat the order is
  // `compatFiles`', fixed and asserted rather than emergent.
  if (options.compat !== false) {
    // An ISOLATED config directory means an isolated environment.
    //
    // When a caller supplies `configDir` and no `home`, the user-global
    // compat files are skipped and only project-local ones are read.
    // Without this, every test that injects a temp `configDir` also
    // read the developer's real `~/.claude.json` and `~/.cursor/mcp.json`
    // — 69 of them failed the moment compat landed, because their
    // results depended on who ran them and on what that person happened
    // to have configured in other tools.
    //
    // I wrote that hazard into `LoadOptions.home`'s doc comment and then
    // shipped the unsafe default anyway; the tests caught it in one run.
    const home = options.home ?? (options.configDir === undefined ? undefined : NO_HOME);
    for (const entry of compatFiles(options.cwd, home)) {
      const read = readCompatFile(entry, options.cwd);
      problems.push(...read.problems);
      for (const [name, value] of Object.entries(read.servers) as Array<[string, McpServerEntry]>) {
        const found = entryProblems(name, value);
        if (found.length > 0) {
          // Validated exactly like a native entry, and rejected out loud.
          // A malformed compat entry that is silently dropped is
          // indistinguishable from one that was never written — and the
          // operator would go looking in the wrong file.
          for (const message of found) problems.push({ file: entry.file, message });
          continue;
        }
        winner.set(name, {
          entry: value,
          source: entry.source,
          file: entry.file,
          projectLocal: entry.projectLocal,
        });
      }
    }
  }

  for (const [name, entry] of Object.entries(user.servers)) {
    winner.set(name, { entry, source: "user", file: userFile, projectLocal: false });
  }

  for (const file of projectConfigFiles(options.cwd, options.gitRoot)) {
    const parsed = parseConfigFile(file);
    problems.push(...parsed.problems);
    for (const [name, entry] of Object.entries(parsed.servers)) {
      winner.set(name, { entry, source: "project", file, projectLocal: true });
    }
  }

  const overlayFile = path.join(configDir, "mcp-servers-disabled.json");
  const overlay = readOverlay(overlayFile);
  problems.push(...overlay.problems);

  const servers = [...winner.entries()]
    .map(([name, { entry, source, file, projectLocal }]) => {
      const expanded = expandEntry(entry, env);
      const personal = overlay.overrides[name];
      return {
        ...expanded,
        name,
        source,
        file,
        projectLocal,
        raw: entry,
        // The personal overlay wins over the file, in both directions. That is
        // what lets `enable` lift a committed `enabled: false` without editing
        // the project file.
        enabled: personal ?? entry.enabled ?? true,
      } satisfies ResolvedMcpServer;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { servers, problems };
}

/**
 * An empty override map with NO prototype.
 *
 * Every return from `readOverlay` goes through this. The first version used
 * `Object.create(null)` on the success path only, and the four other returns
 * — absent file, unreadable, no `overrides` key, invalid JSON — handed back a
 * plain `{}`. The caller then does `overrides[name]`, which resolves through
 * `Object.prototype`, so on a machine with NO OVERLAY FILE AT ALL (the
 * default state of every fresh install) a server named `toString`,
 * `constructor` or `hasOwnProperty` had its `"enabled": false` ignored and
 * was dialled — and `enabled` became a function or an object, which
 * `doctor --json` then emitted as `{}` or dropped from the payload entirely.
 *
 * A helper rather than four call sites, because four call sites is how one
 * of them gets missed. Which is what happened.
 */
function noOverrides(): Record<string, boolean> {
  return Object.create(null) as Record<string, boolean>;
}

function readOverlay(file: string): { overrides: Record<string, boolean>; problems: McpConfigProblem[] } {
  const read = readConfigFile(file);
  if (!read.ok) {
    return isDefiniteAbsence(read.reason)
      ? { overrides: noOverrides(), problems: [] }
      : { overrides: noOverrides(), problems: [{ file, message: `could not be read (${read.reason})` }] };
  }
  try {
    const parsed = parseJsonTolerant(read.text) as McpDisableOverlay;
    const overrides = parsed.overrides;
    if (overrides === undefined) return { overrides: noOverrides(), problems: [] };
    const clean = noOverrides();
    for (const [name, value] of Object.entries(overrides)) {
      if (typeof value === "boolean") clean[name] = value;
    }
    return { overrides: clean, problems: [] };
  } catch {
    // Not fatal: a broken personal overlay must not hide the servers, it must
    // report itself and leave the files' own `enabled` in force.
    return {
      overrides: noOverrides(),
      problems: [{ file, message: "is not valid JSON; personal overrides ignored" }],
    };
  }
}
