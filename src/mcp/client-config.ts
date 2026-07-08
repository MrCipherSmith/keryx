// MCP client-config installer (Flow 012). A sibling of the E5 multi-runtime
// security hook installer (`src/security/agent-hooks/runtimes.ts`) — it wires
// the Block A `gd-metapro mcp serve` server into an editor/agent's project-local
// MCP client config, merge-safely and idempotently.
//
// #1 rule (mirrors E5): never clobber user config. The managed server entry
// carries a sentinel (`_gdMetaproManaged`), so `uninstall` removes ONLY the
// `gd-metapro` server this installer wrote and a re-install never duplicates it;
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

// Managed-entry sentinel. Mirrors E5's `_gdMetaproManaged` discipline, but with a
// value distinct from the security installer's so the two never collide.
export const MCP_MANAGED_KEY = "_gdMetaproManaged";
export const MCP_MANAGED_SENTINEL = "mcp-client-config";

// The managed server entry written into every client config.
export const MCP_SERVER_NAME = "gd-metapro";
export const MCP_SERVER_COMMAND = "gd-metapro";
export const MCP_SERVER_ARGS: readonly string[] = ["mcp", "serve"];

// Actionable hint printed when the optional MCP SDK is not importable. The
// installer NEVER auto-installs and NEVER opens a network connection.
export const MCP_SDK_HINT = "bun add @modelcontextprotocol/sdk";

// The user-facing, ready-to-paste server entry (no sentinel — it is authored by
// the user in that runtime, not managed by this installer).
export function mcpServerEntry(): Record<string, unknown> {
  return { command: MCP_SERVER_COMMAND, args: [...MCP_SERVER_ARGS] };
}

// The managed server entry (carries the sentinel so uninstall/idempotency work).
function managedServerEntry(): Record<string, unknown> {
  return { ...mcpServerEntry(), [MCP_MANAGED_KEY]: MCP_MANAGED_SENTINEL };
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

// Merge the managed `gd-metapro` server into `settings.mcpServers`, preserving
// every other server + top-level key and staying idempotent (the same entry is
// replaced in place, never appended).
function mcpMerge(settings: Settings): Settings {
  const servers = readServers(settings);
  servers[MCP_SERVER_NAME] = managedServerEntry();
  settings.mcpServers = servers;
  return settings;
}

// Remove ONLY the managed `gd-metapro` server (identified by the sentinel),
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
  merge(settings: Settings): Settings;
  strip(settings: Settings): Settings;
  validate(settings: Settings): string[];
}

function fileRuntime(id: string, relativePath: string): McpClientRuntime {
  return {
    id,
    settingsPath: (root) => path.join(root, ...relativePath.split("/")),
    merge: mcpMerge,
    strip: mcpStrip,
    validate: mcpValidate(id),
  };
}

export const CURSOR_RUNTIME: McpClientRuntime = fileRuntime("cursor", ".cursor/mcp.json");
export const CLAUDE_RUNTIME: McpClientRuntime = fileRuntime("claude", ".mcp.json");
export const GENERIC_RUNTIME: McpClientRuntime = {
  id: "generic",
  settingsPath: () => null,
  merge: mcpMerge,
  strip: mcpStrip,
  validate: mcpValidate("generic"),
};

export const MCP_CLIENT_RUNTIMES: McpClientRuntime[] = [
  CURSOR_RUNTIME,
  CLAUDE_RUNTIME,
  GENERIC_RUNTIME,
];

// `all` expands to the file-backed, project-scoped runtimes (cursor + claude).
// `generic` is deliberately excluded — it writes no file, so bundling it into
// `all` would be a no-op surprise.
const ALL_RUNTIME_IDS: readonly string[] = ["cursor", "claude"];

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
export function renderMcpClientSnippet(): string {
  return `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: mcpServerEntry() } }, null, 2)}\n`;
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
      modules: ["gdgraph", "security", "flow", "memory", "health", "wiki", "standard"],
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

- \`gd-metapro mcp serve\` — stdio JSON-RPC MCP server (default transport).
- \`gd-metapro mcp serve --http\` — isolated HTTP/SSE opt-in (localhost only;
  requires \`http.enabled=true\` in this module's manifest entry).

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
      message: "no .metaproject/metaproject.json found; run `gd-metapro init` first",
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

// Install the managed `gd-metapro` MCP server into each requested runtime's
// project-local client config (merge-safe, idempotent). Also flips
// `modules.mcp.enabled=true` in the manifest and probes the optional SDK. With
// `dryRun`, it computes and previews every change but writes NOTHING.
export async function installMcpClient(
  projectRoot: string,
  ids: string[],
  options: { dryRun?: boolean } = {},
): Promise<McpInstallReport> {
  const dryRun = options.dryRun === true;
  const { runtimes, unknown } = resolveMcpRuntimes(ids);
  const outcomes: RuntimeInstallOutcome[] = [];

  for (const runtime of runtimes) {
    const file = runtime.settingsPath(projectRoot);
    if (file === null) {
      // generic: never writes a file; always emits the ready snippet.
      outcomes.push({
        id: runtime.id,
        filePath: null,
        wrote: false,
        snippet: renderMcpClientSnippet(),
        errors: [],
      });
      continue;
    }

    const settings = await readSettings(file);
    const merged = runtime.merge(settings);
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

  const manifest = await enableMcpModule(projectRoot, { dryRun });
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

// Remove ONLY the managed `gd-metapro` server from each requested runtime's
// client config, preserving all other servers + user content. Uninstalling when
// nothing is installed (absent file / absent entry) is a no-op.
export async function uninstallMcpClient(
  projectRoot: string,
  ids: string[],
): Promise<McpUninstallReport> {
  const { runtimes, unknown } = resolveMcpRuntimes(ids);
  const outcomes: RuntimeUninstallOutcome[] = [];

  for (const runtime of runtimes) {
    const file = runtime.settingsPath(projectRoot);
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
    const hadManaged = isManagedEntry(readServers(settings)[MCP_SERVER_NAME]);
    const stripped = runtime.strip(settings);
    await writeSettings(file, stripped);
    outcomes.push({ id: runtime.id, filePath: file, removed: hadManaged });
  }

  return { outcomes, unknown };
}
