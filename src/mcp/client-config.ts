// MCP client-config installer (Flow 012). A sibling of the E5 multi-runtime
// security hook installer (`src/security/agent-hooks/runtimes.ts`) — it wires
// the Block A `keryx mcp serve` server into an editor/agent's project-local
// MCP client config, merge-safely and idempotently.
//
// #1 rule (mirrors E5): never clobber user config. The managed server entry
// carries a sentinel (`_keryxManaged`), so `uninstall` removes ONLY the
// `keryx` server this installer wrote and a re-install never duplicates it;
// every pre-existing server and top-level key is preserved untouched.
//
// This file lives in `src/mcp/` and stays within the import boundary (M-3): it
// imports only `node:*`, `../lib/*`, and the sibling `./config` module. The SDK
// is only PROBED via `await import()` (never a static import, never installed,
// never a network call).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { MCP_CONFIG_DEFAULTS } from "./config";

export type Settings = Record<string, unknown>;

// Managed-entry sentinel. Mirrors E5's `_keryxManaged` discipline, but with a
// value distinct from the security installer's so the two never collide.
export const MCP_MANAGED_KEY = "_keryxManaged";
export const MCP_MANAGED_SENTINEL = "mcp-client-config";

// The managed server entry written into every client config.
export const MCP_SERVER_NAME = "keryx";
export const MCP_SERVER_COMMAND = "keryx";
export const MCP_SERVER_ARGS: readonly string[] = ["mcp", "serve"];

// Actionable hint printed when the optional MCP SDK is not importable. The
// installer NEVER auto-installs and NEVER opens a network connection.
export const MCP_SDK_HINT = "bun add @modelcontextprotocol/sdk";

// The user-facing, ready-to-paste server entry (no sentinel — it is authored by
// the user in that runtime, not managed by this installer).
export function mcpServerEntry(projectRoot?: string): Record<string, unknown> {
  const args = projectRoot
    ? [...MCP_SERVER_ARGS, "--cwd", projectRoot]
    : [...MCP_SERVER_ARGS];
  return { command: MCP_SERVER_COMMAND, args };
}

// The managed server entry (carries the sentinel so uninstall/idempotency work).
function managedServerEntry(projectRoot: string): Record<string, unknown> {
  return { ...mcpServerEntry(projectRoot), [MCP_MANAGED_KEY]: MCP_MANAGED_SENTINEL };
}

function isManagedEntry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[MCP_MANAGED_KEY] === MCP_MANAGED_SENTINEL
  );
}

function readServers(settings: Settings): Settings {
  return typeof settings.mcpServers === "object" &&
    settings.mcpServers !== null &&
    !Array.isArray(settings.mcpServers)
    ? { ...(settings.mcpServers as Settings) }
    : {};
}

// Merge the managed `keryx` server into `settings.mcpServers`, preserving
// every other server + top-level key and staying idempotent (the same entry is
// replaced in place, never appended).
function mcpMerge(settings: Settings, projectRoot: string): Settings {
  const servers = readServers(settings);
  servers[MCP_SERVER_NAME] = managedServerEntry(projectRoot);
  settings.mcpServers = servers;
  return settings;
}

// Remove ONLY the managed `keryx` server (identified by the sentinel),
// leaving other servers + user content intact. When it is the last server the
// now-empty `mcpServers` key is dropped so uninstall restores the prior shape.
function mcpStrip(settings: Settings): Settings {
  if (
    typeof settings.mcpServers !== "object" ||
    settings.mcpServers === null ||
    Array.isArray(settings.mcpServers)
  ) {
    return settings;
  }
  const servers = { ...(settings.mcpServers as Settings) };
  if (isManagedEntry(servers[MCP_SERVER_NAME])) {
    delete servers[MCP_SERVER_NAME];
  }
  if (Object.keys(servers).length > 0) settings.mcpServers = servers;
  else delete settings.mcpServers;
  return settings;
}

function mcpValidate(id: string): (settings: Settings) => string[] {
  return (settings: Settings): string[] => {
    const errors: string[] = [];
    const servers = settings.mcpServers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
      errors.push(`${id}: mcpServers is missing or not an object`);
      return errors;
    }
    const entry = (servers as Settings)[MCP_SERVER_NAME];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${id}: missing mcpServers.${MCP_SERVER_NAME} entry`);
      return errors;
    }
    if ((entry as Record<string, unknown>).command !== MCP_SERVER_COMMAND) {
      errors.push(`${id}: mcpServers.${MCP_SERVER_NAME}.command must be "${MCP_SERVER_COMMAND}"`);
    }
    return errors;
  };
}

export interface McpClientRuntime {
  readonly id: string;
  // Absolute client-config path under a project root, or null for the fileless
  // `generic` runtime (which only ever prints a ready snippet).
  settingsPath(projectRoot: string): string | null;
  merge(settings: Settings, projectRoot: string): Settings;
  strip(settings: Settings): Settings;
  validate(settings: Settings): string[];
  // Whether `settings` currently carries THIS runtime's managed keryx entry —
  // runtime-specific because each runtime keys its servers under a different
  // top-level field (mcpServers vs mcp). Used by uninstallMcpClient to report
  // an accurate `removed` outcome; never hardcode a single shape here.
  hasManaged(settings: Settings): boolean;
  // Every MCP server name configured in this client's config file, `keryx`
  // included when present — e.g. a real `.cursor/mcp.json` naming `context7`/
  // `playwright` alongside `keryx`. This installer only ever writes/removes
  // the single `keryx` entry (see the file header's "never clobber user
  // config" rule); this is read-only visibility into what's already there,
  // for `mcp-inspector.ts` to show the *actual* MCP servers a client has
  // configured, not just this installer's own managed entry.
  listServers(settings: Settings): string[];
}

function mcpHasManaged(settings: Settings): boolean {
  return isManagedEntry(readServers(settings)[MCP_SERVER_NAME]);
}

function fileRuntime(id: string, relativePath: string): McpClientRuntime {
  return {
    id,
    settingsPath: (root) => path.join(root, ...relativePath.split("/")),
    merge: mcpMerge,
    strip: mcpStrip,
    validate: mcpValidate(id),
    hasManaged: mcpHasManaged,
    listServers: (settings) => Object.keys(readServers(settings)),
  };
}

export const CURSOR_RUNTIME: McpClientRuntime = fileRuntime("cursor", ".cursor/mcp.json");
export const CLAUDE_RUNTIME: McpClientRuntime = fileRuntime("claude", ".mcp.json");

// opencode's client config is project-local `opencode.json`, but its MCP server
// shape differs from the `mcpServers.<name>.{command,args}` convention every
// other runtime here shares: a single top-level `mcp` object keyed by server
// name, one combined `command` array (binary + args, not split), and a required
// `type`/`enabled` pair. Confirmed against a real `opencode.json` on this
// machine and a live `opencode run --auto` MCP round-trip before wiring this in
// (docs/requirements/keryx-benchmark-suite's opencode investigation covers the
// headless-hang finding for opencode's OWN tools — that is unrelated: an MCP
// tool call is a different code path and was verified working headlessly).
function readOpencodeMcp(settings: Settings): Settings {
  return typeof settings.mcp === "object" && settings.mcp !== null && !Array.isArray(settings.mcp)
    ? { ...(settings.mcp as Settings) }
    : {};
}

function opencodeManagedEntry(projectRoot: string): Record<string, unknown> {
  const args = projectRoot ? [...MCP_SERVER_ARGS, "--cwd", projectRoot] : [...MCP_SERVER_ARGS];
  return {
    type: "local",
    command: [MCP_SERVER_COMMAND, ...args],
    enabled: true,
    [MCP_MANAGED_KEY]: MCP_MANAGED_SENTINEL,
  };
}

function opencodeMerge(settings: Settings, projectRoot: string): Settings {
  const servers = readOpencodeMcp(settings);
  servers[MCP_SERVER_NAME] = opencodeManagedEntry(projectRoot);
  settings.mcp = servers;
  return settings;
}

function opencodeStrip(settings: Settings): Settings {
  if (typeof settings.mcp !== "object" || settings.mcp === null || Array.isArray(settings.mcp)) {
    return settings;
  }
  const servers = { ...(settings.mcp as Settings) };
  if (isManagedEntry(servers[MCP_SERVER_NAME])) {
    delete servers[MCP_SERVER_NAME];
  }
  if (Object.keys(servers).length > 0) settings.mcp = servers;
  else delete settings.mcp;
  return settings;
}

function opencodeValidate(settings: Settings): string[] {
  const errors: string[] = [];
  const servers = settings.mcp;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    errors.push("opencode: mcp is missing or not an object");
    return errors;
  }
  const entry = (servers as Settings)[MCP_SERVER_NAME] as Record<string, unknown> | undefined;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    errors.push(`opencode: missing mcp.${MCP_SERVER_NAME} entry`);
    return errors;
  }
  if (!Array.isArray(entry.command) || entry.command[0] !== MCP_SERVER_COMMAND) {
    errors.push(`opencode: mcp.${MCP_SERVER_NAME}.command[0] must be "${MCP_SERVER_COMMAND}"`);
  }
  if (entry.type !== "local") {
    errors.push(`opencode: mcp.${MCP_SERVER_NAME}.type must be "local"`);
  }
  return errors;
}

function opencodeHasManaged(settings: Settings): boolean {
  return isManagedEntry(readOpencodeMcp(settings)[MCP_SERVER_NAME]);
}

export const OPENCODE_RUNTIME: McpClientRuntime = {
  id: "opencode",
  settingsPath: (root) => path.join(root, "opencode.json"),
  merge: opencodeMerge,
  strip: opencodeStrip,
  validate: opencodeValidate,
  hasManaged: opencodeHasManaged,
  listServers: (settings) => Object.keys(readOpencodeMcp(settings)),
};

export const GENERIC_RUNTIME: McpClientRuntime = {
  id: "generic",
  settingsPath: () => null,
  merge: mcpMerge,
  strip: mcpStrip,
  validate: mcpValidate("generic"),
  hasManaged: mcpHasManaged,
  listServers: (settings) => Object.keys(readServers(settings)),
};

// VS Code's client config is project-local `.vscode/mcp.json`, but its shape
// differs from every other runtime here in two ways, confirmed live
// (WebSearch+WebFetch against current code.visualstudio.com docs — no VS
// Code install available in this environment to verify against a real
// instance, honestly noted, same pattern as the opencode investigation
// above): (1) the top-level key is `servers`, NOT `mcpServers`; (2) each
// entry requires an explicit `"type": "stdio"` field alongside
// `command`/`args` — none of `fileRuntime`'s two clients (cursor/claude) or
// opencode's own distinct shape carry a `type` discriminant on the entry
// itself. Mirrors `OPENCODE_RUNTIME`'s pattern: its own merge/strip/validate/
// hasManaged, not the generic `mcpServers` helpers `fileRuntime` reuses.
function readVscodeServers(settings: Settings): Settings {
  return typeof settings.servers === "object" &&
    settings.servers !== null &&
    !Array.isArray(settings.servers)
    ? { ...(settings.servers as Settings) }
    : {};
}

function vscodeManagedEntry(projectRoot: string): Record<string, unknown> {
  return {
    type: "stdio",
    ...mcpServerEntry(projectRoot),
    [MCP_MANAGED_KEY]: MCP_MANAGED_SENTINEL,
  };
}

function vscodeMerge(settings: Settings, projectRoot: string): Settings {
  const servers = readVscodeServers(settings);
  servers[MCP_SERVER_NAME] = vscodeManagedEntry(projectRoot);
  settings.servers = servers;
  return settings;
}

function vscodeStrip(settings: Settings): Settings {
  if (
    typeof settings.servers !== "object" ||
    settings.servers === null ||
    Array.isArray(settings.servers)
  ) {
    return settings;
  }
  const servers = { ...(settings.servers as Settings) };
  if (isManagedEntry(servers[MCP_SERVER_NAME])) {
    delete servers[MCP_SERVER_NAME];
  }
  if (Object.keys(servers).length > 0) settings.servers = servers;
  else delete settings.servers;
  return settings;
}

function vscodeValidate(settings: Settings): string[] {
  const errors: string[] = [];
  const servers = settings.servers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    errors.push("vscode: servers is missing or not an object");
    return errors;
  }
  const entry = (servers as Settings)[MCP_SERVER_NAME] as Record<string, unknown> | undefined;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    errors.push(`vscode: missing servers.${MCP_SERVER_NAME} entry`);
    return errors;
  }
  if (entry.type !== "stdio") {
    errors.push(`vscode: servers.${MCP_SERVER_NAME}.type must be "stdio"`);
  }
  if (entry.command !== MCP_SERVER_COMMAND) {
    errors.push(`vscode: servers.${MCP_SERVER_NAME}.command must be "${MCP_SERVER_COMMAND}"`);
  }
  return errors;
}

function vscodeHasManaged(settings: Settings): boolean {
  return isManagedEntry(readVscodeServers(settings)[MCP_SERVER_NAME]);
}

export const VSCODE_RUNTIME: McpClientRuntime = {
  id: "vscode",
  settingsPath: (root) => path.join(root, ".vscode", "mcp.json"),
  merge: vscodeMerge,
  strip: vscodeStrip,
  validate: vscodeValidate,
  hasManaged: vscodeHasManaged,
  listServers: (settings) => Object.keys(readVscodeServers(settings)),
};

export const MCP_CLIENT_RUNTIMES: McpClientRuntime[] = [
  CURSOR_RUNTIME,
  CLAUDE_RUNTIME,
  OPENCODE_RUNTIME,
  VSCODE_RUNTIME,
  GENERIC_RUNTIME,
];

// `all` expands to the file-backed, project-scoped runtimes. `generic` is
// deliberately excluded — it writes no file, so bundling it into `all` would be
// a no-op surprise. `vscode` is also deliberately excluded from `all`: unlike
// cursor/claude/opencode, a VS Code workspace is not a safe default assumption
// for every project this installer runs against, so `--runtime vscode` (or
// `vscode` in an explicit comma-list) is opt-in only. `codex` is deliberately
// NOT a runtime here: its client config is a single GLOBAL
// `~/.codex/config.toml` (not a project-local JSON file), and codex already
// ships its own safe, native installer for it —
// `codex mcp add keryx -- keryx mcp serve --cwd <projectRoot>` (verified live).
// Building a parallel TOML writer here would duplicate that without adding
// safety; `renderMcpManifest()` documents the real command instead.
const ALL_RUNTIME_IDS: readonly string[] = ["cursor", "claude", "opencode"];

export function mcpRuntimeIds(): string[] {
  return MCP_CLIENT_RUNTIMES.map((r) => r.id);
}

export function getMcpRuntime(id: string): McpClientRuntime | undefined {
  return MCP_CLIENT_RUNTIMES.find((r) => r.id === id);
}

// Resolve requested runtime ids (comma-list already split by the caller). `all`
// ⇒ cursor + claude. Unknown ids are reported so the CLI can surface them.
export function resolveMcpRuntimes(ids: string[]): {
  runtimes: McpClientRuntime[];
  unknown: string[];
} {
  const wanted = ids.includes("all") ? [...ALL_RUNTIME_IDS] : ids;
  const runtimes: McpClientRuntime[] = [];
  const unknown: string[] = [];
  for (const id of wanted) {
    const runtime = getMcpRuntime(id);
    if (runtime) runtimes.push(runtime);
    else unknown.push(id);
  }
  return { runtimes, unknown };
}

// The ready-to-paste JSON snippet for the `generic` runtime (no sentinel).
export function renderMcpClientSnippet(projectRoot?: string): string {
  return `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: mcpServerEntry(projectRoot) } }, null, 2)}\n`;
}

export interface McpRuntimeStatus {
  id: string;
  // Absolute client-config path, or null for the fileless `generic` runtime.
  filePath: string | null;
  connected: boolean;
  // Every OTHER MCP server name this client's config already has (e.g.
  // `context7`, `playwright`) — `keryx`'s own entry is excluded, since
  // `connected` already reports that one. Real visibility into what "MCP" on
  // this client actually means, distinct from this modal's own connect/
  // disconnect action; always `[]` for `generic` (no file to read) or when
  // the config has no `mcpServers`/`mcp`/`servers` section at all.
  otherServers: string[];
}

// Live connect/disconnect status for MCP client runtimes, read fresh from disk
// on every call — no cache, same rationale as `skills_catalog` (D-02 sibling):
// a handful of small JSON files, cheap to read, and a stale cached status is
// worse than the read cost it would save. `generic` never writes a file, so it
// is always reported disconnected — there is nothing on disk to check.
export async function mcpClientStatus(
  projectRoot: string,
  ids: string[] = mcpRuntimeIds(),
): Promise<McpRuntimeStatus[]> {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const { runtimes } = resolveMcpRuntimes(ids);
  const statuses: McpRuntimeStatus[] = [];
  for (const runtime of runtimes) {
    const file = runtime.settingsPath(absoluteProjectRoot);
    if (file === null) {
      statuses.push({ id: runtime.id, filePath: null, connected: false, otherServers: [] });
      continue;
    }
    const settings = await readSettings(file);
    const otherServers = runtime.listServers(settings).filter((name) => name !== MCP_SERVER_NAME).sort();
    statuses.push({ id: runtime.id, filePath: file, connected: runtime.hasManaged(settings), otherServers });
  }
  return statuses;
}

// ---------------------------------------------------------------------------
// Settings read/write (JSON-or-empty → merge/strip → write), mirroring E5.
// ---------------------------------------------------------------------------

async function readSettings(file: string): Promise<Settings> {
  if (!(await pathExists(file))) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Settings;
    }
    return {};
  } catch {
    throw new Error(`Cannot parse ${file}: file is not valid JSON`);
  }
}

async function writeSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// SDK probe (never installs, never connects).
// ---------------------------------------------------------------------------

export interface SdkProbe {
  available: boolean;
  hint?: string;
}

// Probe whether the optional `@modelcontextprotocol/sdk` is importable. Uses a
// lazy `await import()` (module resolution is local filesystem only — no network,
// no install). `load` is injectable so tests can exercise the absent branch.
export async function probeMcpSdk(
  load: () => Promise<unknown> = () => import("@modelcontextprotocol/sdk/server/index.js"),
): Promise<SdkProbe> {
  try {
    await load();
    return { available: true };
  } catch {
    return { available: false, hint: MCP_SDK_HINT };
  }
}

// ---------------------------------------------------------------------------
// Manifest enable (merge-safe; malformed ⇒ no-op with a message, never throws).
// ---------------------------------------------------------------------------

export interface ManifestEnableResult {
  changed: boolean;
  message?: string;
}

function metaprojectManifestPath(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "metaproject.json");
}

// The opt-in mcp manifest entry (identical to `init --mcp`'s entry). `enabled`
// is forced true; `capabilities` stays a string[] to satisfy the module schema.
export function buildMcpModuleEntry(): Record<string, unknown> {
  return {
    enabled: true,
    core: ".metaproject/core/mcp",
    data: ".metaproject/data/mcp",
    manifest: ".metaproject/modules/mcp.md",
    config: ".metaproject/core/mcp/mcp.config.json",
    commands: ["serve"],
    capabilities: [],
    http: { enabled: false },
    expose: {
      tools: true,
      resources: true,
      modules: ["gdgraph", "gdctx", "security", "flow", "memory", "health", "testing", "wiki", "standard", "sac", "gdskills"],
    },
  };
}

export function renderMcpConfig(): string {
  return `${JSON.stringify(MCP_CONFIG_DEFAULTS, null, 2)}\n`;
}

export function renderMcpManifest(): string {
  return `# MCP Module

Version: 0.1.0
Type: module
Status: active

## Summary

Exposes read-only Metaproject services (code graph, security, flow status,
memory, health, wiki, standard) over the Model Context Protocol (MCP). A thin
protocol adapter — it defines no new module logic.

## Commands

- \`keryx mcp serve\` — stdio JSON-RPC MCP server (default transport).
- \`keryx mcp serve --http\` — isolated HTTP/SSE opt-in (localhost only;
  requires \`http.enabled=true\` in this module's manifest entry).
- \`keryx mcp serve --cwd <project-root>\` — expose a specific project,
  independent of the MCP client's launch directory.
- \`keryx mcp install --runtime <cursor|claude|opencode|vscode|generic|all> [--dry-run]\` —
  wire this project into an editor/agent: writes a project-local client
  config (cursor → \`.cursor/mcp.json\`, claude → \`.mcp.json\`, opencode →
  \`opencode.json\`, vscode → \`.vscode/mcp.json\`) and sets
  \`modules.mcp.enabled=true\`. \`--dry-run\` prints the change without
  writing anything. This is the command to run when a user asks to
  "connect" or "enable" MCP for this project — it is the full, real setup
  step; hand-editing a client config file directly is unnecessary and skips
  setting \`modules.mcp.enabled\`. \`all\` expands to cursor + claude +
  opencode; \`vscode\` is opt-in only (not bundled into \`all\`) — request it
  explicitly with \`--runtime vscode\`.
- \`keryx mcp uninstall --runtime <cursor|claude|opencode|vscode|generic|all>\` —
  remove the managed client config again.
- **codex CLI**: not a \`--runtime\` here — codex's client config is a single
  GLOBAL \`~/.codex/config.toml\`, not a project-local file, and it already
  ships its own safe, native installer for it. Run
  \`codex mcp add keryx -- keryx mcp serve --cwd <project-root>\` once
  (verified live: codex successfully discovers and calls this server's
  tools headlessly with \`codex exec --approve-for-me\`); \`codex mcp remove
  keryx\` to undo. \`modules.mcp.enabled=true\` still needs
  \`keryx mcp install --runtime generic\` (or any other runtime) run once,
  since codex's own installer has no notion of the keryx manifest.

## Notes

- Requires the optional \`@modelcontextprotocol/sdk\`. Disabled by default.
- Every tool result is routed through the security \`redactRaw\` seam before
  transport.
- Tool/resource exposure is filtered by the manifest (\`expose.modules\`); a
  disabled module is hidden from \`tools/list\` and \`resources/list\`.
`;
}

export function renderMcpCoreReadme(): string {
  return `# MCP Core

Configuration for the \`mcp\` module lives in \`mcp.config.json\` (deep-merged over
built-in defaults). Transports are stdio (default) and an opt-in HTTP/SSE bridge.
\`mcp install\` writes client configs with \`--cwd <project-root>\` so tools and
resources resolve the intended project even when the editor launches the server
from another directory.

See \`.metaproject/modules/mcp.md\` for the command surface.
`;
}

async function writeTextIfMissing(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

// Scaffold the mcp module's on-disk structure (mirrors `init --mcp`) so an
// enabled manifest entry points at real files/dirs and `standard validate`
// stays green. Idempotent: existing files are left untouched.
export async function scaffoldMcpModule(metaprojectRoot: string): Promise<void> {
  await mkdir(path.join(metaprojectRoot, "core", "mcp"), { recursive: true });
  await mkdir(path.join(metaprojectRoot, "data", "mcp", "artifacts"), { recursive: true });
  await writeTextIfMissing(
    path.join(metaprojectRoot, "core", "mcp", "mcp.config.json"),
    renderMcpConfig(),
  );
  await writeTextIfMissing(
    path.join(metaprojectRoot, "modules", "mcp.md"),
    renderMcpManifest(),
  );
  await writeTextIfMissing(
    path.join(metaprojectRoot, "core", "mcp", "README.md"),
    renderMcpCoreReadme(),
  );
}

// Set `modules.mcp.enabled=true` in `.metaproject/metaproject.json`, preserving
// the rest of the manifest. A missing or malformed manifest is a no-op with a
// message (never a throw). When `dryRun` is set, nothing is written.
export async function enableMcpModule(
  projectRoot: string,
  options: { dryRun?: boolean } = {},
): Promise<ManifestEnableResult> {
  const manifestPath = metaprojectManifestPath(projectRoot);
  if (!(await pathExists(manifestPath))) {
    return {
      changed: false,
      message: "no .metaproject/metaproject.json found; run `keryx init` first",
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch {
    return {
      changed: false,
      message: "metaproject.json is not valid JSON; leaving it unchanged",
    };
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return {
      changed: false,
      message: "metaproject.json is not a JSON object; leaving it unchanged",
    };
  }

  const root = manifest as Record<string, unknown>;
  const modules =
    typeof root.modules === "object" && root.modules !== null && !Array.isArray(root.modules)
      ? { ...(root.modules as Record<string, unknown>) }
      : {};
  const existing =
    typeof modules.mcp === "object" && modules.mcp !== null && !Array.isArray(modules.mcp)
      ? (modules.mcp as Record<string, unknown>)
      : undefined;

  if (existing?.enabled === true) {
    return { changed: false };
  }

  if (options.dryRun) {
    return { changed: true };
  }

  // Preserve any user-authored fields on an existing (disabled) entry, but force
  // a schema-valid, enabled shape. When there is no entry yet, write the full
  // default so `standard validate` finds real `core`/`manifest` paths.
  modules.mcp = existing
    ? { ...buildMcpModuleEntry(), ...existing, enabled: true }
    : buildMcpModuleEntry();
  root.modules = modules;

  await scaffoldMcpModule(path.join(projectRoot, ".metaproject"));
  await writeFile(manifestPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return { changed: true };
}

// ---------------------------------------------------------------------------
// Orchestration: installMcpClient / uninstallMcpClient.
// ---------------------------------------------------------------------------

export interface RuntimeInstallOutcome {
  id: string;
  // Absolute file written/updated, or null for the fileless `generic` runtime.
  filePath: string | null;
  // Whether a file was actually written (false under dryRun and for generic).
  wrote: boolean;
  // The ready snippet for `generic` (and, under dryRun, a preview of the file).
  snippet?: string;
  errors: string[];
}

export interface McpInstallReport {
  outcomes: RuntimeInstallOutcome[];
  unknown: string[];
  manifest: ManifestEnableResult;
  sdk: SdkProbe;
  dryRun: boolean;
}

// Install the managed `keryx` MCP server into each requested runtime's
// project-local client config (merge-safe, idempotent). Also flips
// `modules.mcp.enabled=true` in the manifest and probes the optional SDK. With
// `dryRun`, it computes and previews every change but writes NOTHING.
export async function installMcpClient(
  projectRoot: string,
  ids: string[],
  options: { dryRun?: boolean } = {},
): Promise<McpInstallReport> {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const dryRun = options.dryRun === true;
  const { runtimes, unknown } = resolveMcpRuntimes(ids);
  const outcomes: RuntimeInstallOutcome[] = [];

  for (const runtime of runtimes) {
    const file = runtime.settingsPath(absoluteProjectRoot);
    if (file === null) {
      // generic: never writes a file; always emits the ready snippet.
      outcomes.push({
        id: runtime.id,
        filePath: null,
        wrote: false,
        snippet: renderMcpClientSnippet(absoluteProjectRoot),
        errors: [],
      });
      continue;
    }

    const settings = await readSettings(file);
    const merged = runtime.merge(settings, absoluteProjectRoot);
    const errors = runtime.validate(merged);
    if (dryRun) {
      outcomes.push({
        id: runtime.id,
        filePath: file,
        wrote: false,
        snippet: `${JSON.stringify(merged, null, 2)}\n`,
        errors,
      });
      continue;
    }
    await writeSettings(file, merged);
    outcomes.push({ id: runtime.id, filePath: file, wrote: true, errors });
  }

  const manifest = await enableMcpModule(absoluteProjectRoot, { dryRun });
  const sdk = await probeMcpSdk();

  return { outcomes, unknown, manifest, sdk, dryRun };
}

export interface RuntimeUninstallOutcome {
  id: string;
  filePath: string | null;
  removed: boolean;
}

export interface McpUninstallReport {
  outcomes: RuntimeUninstallOutcome[];
  unknown: string[];
}

// Remove ONLY the managed `keryx` server from each requested runtime's
// client config, preserving all other servers + user content. Uninstalling when
// nothing is installed (absent file / absent entry) is a no-op.
export async function uninstallMcpClient(
  projectRoot: string,
  ids: string[],
): Promise<McpUninstallReport> {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const { runtimes, unknown } = resolveMcpRuntimes(ids);
  const outcomes: RuntimeUninstallOutcome[] = [];

  for (const runtime of runtimes) {
    const file = runtime.settingsPath(absoluteProjectRoot);
    if (file === null) {
      // generic writes no file, so there is nothing to remove.
      outcomes.push({ id: runtime.id, filePath: null, removed: false });
      continue;
    }
    if (!(await pathExists(file))) {
      outcomes.push({ id: runtime.id, filePath: file, removed: false });
      continue;
    }
    const settings = await readSettings(file);
    const hadManaged = runtime.hasManaged(settings);
    const stripped = runtime.strip(settings);
    await writeSettings(file, stripped);
    outcomes.push({ id: runtime.id, filePath: file, removed: hadManaged });
  }

  return { outcomes, unknown };
}
