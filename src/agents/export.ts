// Flow 310 (W2 agent-definitions catalog), T7: the per-runtime EXPORTER —
// the honesty-gated dispatcher in front of `compile.ts`'s renderers (AC4,
// AC9). `compile.ts` answers "what would this target's file look like";
// this module answers "is writing that file actually backed by the W5
// registry for THIS project, and is it safe to write given what is already
// on disk".
//
// Three things this module owns that `compile.ts` deliberately does not:
//   1. `agentExportSupport` — looks the runtime's `agents` surface state up
//      from the SAME W5 registry classification the capability matrix is
//      generated from (`classifySurfaceState`/`surfacesOf`), never a second
//      hand-written table (AC4). `keryx-shell` is a documented special case:
//      it is keryx's own dispatch engine, not a host settings surface, so it
//      never has (or needs) a matrix `agents` record of its own — the
//      matrix's `keryx-shell` row belongs to W6.
//   2. `planAgentExport` — decides create/update/unchanged/refuse-unmanaged
//      against what is ALREADY on disk, using the sentinel every renderer in
//      `compile.ts` embeds (`compile.ts`'s `AGENT_SENTINEL_PREFIX`). Never
//      overwrites a file lacking that sentinel.
//   3. `writeAgentExport`/`removeManagedAgentExports` — the only code in
//      this zone that actually touches the filesystem for an export.

import { readFile, mkdir, writeFile, rm, readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { pathExists, isNotFound, isPathInside } from "../lib/fs";
import { getHarnessAdapter, surfacesOf } from "../integrations/registry";
import { classifySurfaceState, type MatrixSurfaceState } from "../integrations/matrix";
import {
  compileAgentDefinition,
  compileAgentHeader,
  agentManagedSentinelText,
  finalizeAgentContentHash,
  verifyAgentContentHash,
  AGENT_SENTINEL_PREFIX,
  type HostAgentExport,
  type KeryxShellCompileResult,
} from "./compile";
import type { HostToolTarget } from "./tools";
import type { AgentDefinition, AgentExportRuntime, ExportSupportLevel } from "./types";

// ---------------------------------------------------------------------------
// Support-level lookup (AC4)
// ---------------------------------------------------------------------------

/** Reads a runtime's `agents` surface support level. `undefined` = no agents record for that runtime at all. */
export type AgentSupportLookup = (runtime: AgentExportRuntime) => ExportSupportLevel | undefined;

function matrixStateToExportLevel(state: MatrixSurfaceState): ExportSupportLevel {
  return state === "native" || state === "adapter" ? state : "instruction-only";
}

/**
 * The default lookup: reads the `agents` surface for `runtime` off
 * `HARNESS_ADAPTERS` (via `registry.ts`'s `getHarnessAdapter`/`surfacesOf`)
 * and classifies it with the SAME function `matrix.ts`'s
 * `generateCapabilityMatrix` uses (`classifySurfaceState`) — never a second,
 * independently-maintained honesty table. `keryx-shell` is special-cased to
 * `"native"` BEFORE any registry lookup: it is keryx's own dispatch engine
 * (`compileAgentDefinition`'s `target: "keryx-shell"` branch), not a host
 * file surface, so it carries no `agents` surface in the registry at all —
 * the matrix's `keryx-shell` row is W6's placeholder adapter (no surfaces
 * yet) and asking it the same question the host runtimes are asked would
 * misreport a runtime this workstream already fully supports as
 * unsupported.
 */
export const defaultAgentSupportLookup: AgentSupportLookup = (runtime) => {
  if (runtime === "keryx-shell") return "native";
  const adapter = getHarnessAdapter(runtime);
  if (!adapter) return undefined;
  const surface = surfacesOf(adapter, { flag: "agents" })[0];
  if (!surface) return undefined;
  return matrixStateToExportLevel(classifySurfaceState(adapter, surface));
};

/**
 * `native`/`adapter` pass through; `undefined` (no registry record at all)
 * or an explicit `"instruction-only"` both collapse to `"instruction-only"`
 * — the one honest fallback when this project's registry does not back a
 * host-native or adapter-shaped export for `runtime` (AC4).
 */
export function agentExportSupport(
  runtime: AgentExportRuntime,
  lookup: AgentSupportLookup = defaultAgentSupportLookup,
): ExportSupportLevel {
  const level = lookup(runtime);
  return level === "native" || level === "adapter" ? level : "instruction-only";
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type AgentExportAction = "create" | "update" | "unchanged" | "refuse-unmanaged" | "refuse-modified" | "compiled-only";

export interface AgentExportPlan {
  readonly runtime: AgentExportRuntime;
  readonly name: string;
  readonly supportLevel: ExportSupportLevel;
  /** Present for every host (non-`keryx-shell`) plan, whatever its action — even `refuse-unmanaged`, so a caller can report which path was refused. */
  readonly relativePath?: string;
  /** The content this plan would write. Absent for `keryx-shell` (see `keryxShell`) and for a `refuse-unmanaged` compile failure. */
  readonly content?: string;
  /** Present only for `runtime: "keryx-shell"` — the compiled dispatch-input result (`compile.ts`'s `KeryxShellCompileResult`). */
  readonly keryxShell?: KeryxShellCompileResult;
  readonly droppedTools: readonly string[];
  readonly action: AgentExportAction;
  readonly reason?: string;
}

export interface PlanAgentExportOptions {
  readonly lookup?: AgentSupportLookup;
}

const PROSE_EXPORT_ROOT = ".metaproject/agents-export";

/** Where instruction-only prose fallback lands for a runtime with no backing registry record (AC4). */
function proseExportRelativePath(runtime: AgentExportRuntime, name: string): string {
  return `${PROSE_EXPORT_ROOT}/${runtime}/${name}.md`;
}

async function readExistingFileContent(projectRoot: string, relativePath: string): Promise<string | undefined> {
  const absolute = path.join(projectRoot, ...relativePath.split("/"));
  try {
    return await readFile(absolute, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// R1-F3: symlink/containment safety.
//
// `readFile`/`mkdir`/`writeFile` all follow symlinks. A dangling symlink at
// `relativePath` (or a symlinked ancestor directory, e.g. `.codex/agents ->
// <outside>`) made `writeAgentExport` write attacker-chosen content to an
// attacker-chosen path outside the project root — reachable from a cloned
// repo, since a project `.metaproject/agents/<name>.md` overrides a bundled
// definition's body. Every write/plan-for-write below is checked through
// this first: refuse when ANY path component (the leaf included) is itself a
// symlink, or when the deepest existing ancestor's real path resolves
// outside the project root's real path.
// ---------------------------------------------------------------------------

async function checkExportPathSafety(projectRoot: string, relativePath: string): Promise<string | undefined> {
  const segments = relativePath.split("/");
  let current = projectRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isNotFound(error)) continue; // does not exist yet — fine, it will be created
      throw error;
    }
    if (stats.isSymbolicLink()) {
      return `refusing to write ${relativePath} — ${path.relative(projectRoot, current) || "."} is a symlink; this exporter never writes through a symlink`;
    }
  }

  // Belt-and-braces: resolve the deepest existing ancestor and confirm it is
  // still inside the project root's own real path (catches a symlink this
  // process cannot `lstat` component-by-component, e.g. one introduced by a
  // race, or a root itself reached through a symlinked parent).
  let ancestor = path.dirname(path.join(projectRoot, ...segments));
  for (let guard = 0; guard < segments.length + 1 && !(await pathExists(ancestor)); guard += 1) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  try {
    const [resolvedRoot, resolvedAncestor] = await Promise.all([realpath(projectRoot), realpath(ancestor)]);
    if (!isPathInside(resolvedRoot, resolvedAncestor)) {
      return `refusing to write ${relativePath} — its resolved directory is outside the project root`;
    }
  } catch {
    // Root or ancestor unreadable for some unrelated reason; the per-segment
    // lstat loop above already ran and is the primary guard.
  }
  return undefined;
}

interface DecidedAction {
  readonly action: "create" | "update" | "unchanged" | "refuse-unmanaged" | "refuse-modified";
  readonly reason?: string;
}

/**
 * create/update/unchanged/refuse-unmanaged/refuse-modified, judged purely
 * off what is already on disk at `relativePath` versus the freshly generated
 * `content`: absent -> create; present but missing ANY keryx-managed
 * sentinel -> refuse-unmanaged (this exporter never overwrites a file it
 * does not own); present, sentinel-bearing, and byte-identical -> unchanged;
 * present, sentinel-bearing, different, AND its own `content-sha256:` no
 * longer matches its own content (R1-F9 — it was hand-edited since it was
 * exported) -> refuse-modified (only `--force` overwrites this, never a
 * plain re-export); present, sentinel-bearing, different, and verified
 * unedited -> update (a newer source version, or a different target's
 * render of the same source).
 */
function decideAction(existing: string | undefined, generated: string): DecidedAction {
  if (existing === undefined) return { action: "create" };
  if (!existing.includes(AGENT_SENTINEL_PREFIX)) {
    return {
      action: "refuse-unmanaged",
      reason: "existing file carries no keryx-managed sentinel — refusing to overwrite a file this exporter does not own",
    };
  }
  if (existing === generated) return { action: "unchanged" };
  if (!verifyAgentContentHash(existing)) {
    return {
      action: "refuse-modified",
      reason:
        "existing file's content no longer matches the content-sha256 recorded in its own sentinel — it appears to have been hand-edited since it was exported; re-run with --force to overwrite it",
    };
  }
  return { action: "update" };
}

/**
 * Plan one definition's export for one runtime, WITHOUT writing anything
 * (`writeAgentExport` is the only writer). Never throws for an
 * ordinary catalog-loaded, schema-valid definition; a genuine compile
 * failure (e.g. a `policy_profile` value `schema.ts` accepts as a non-empty
 * string but `policy.ts`'s canonical vocabulary rejects) surfaces as
 * `action: "refuse-unmanaged"` with the compile error's reason in `reason`
 * — this module writes nothing it cannot itself compile.
 */
export async function planAgentExport(
  projectRoot: string,
  definition: AgentDefinition,
  runtime: AgentExportRuntime,
  opts: PlanAgentExportOptions = {},
): Promise<AgentExportPlan> {
  const supportLevel = agentExportSupport(runtime, opts.lookup);

  if (runtime === "keryx-shell") {
    const compiled = compileAgentDefinition(definition, "keryx-shell");
    if (!compiled.ok) {
      return {
        runtime,
        name: definition.name,
        supportLevel,
        droppedTools: [],
        action: "compiled-only",
        reason: `compile failed (${compiled.error.reason}): ${compiled.error.message}`,
      };
    }
    return {
      runtime,
      name: definition.name,
      supportLevel,
      keryxShell: compiled.result as KeryxShellCompileResult,
      // AC2: nothing is silently dropped for keryx-shell — every field lands
      // in `input` or the `policy` sidecar, so there is nothing to report here.
      droppedTools: [],
      action: "compiled-only",
    };
  }

  if (supportLevel === "instruction-only") {
    const headerResult = compileAgentHeader(definition);
    if (!headerResult.ok) {
      return {
        runtime,
        name: definition.name,
        supportLevel,
        droppedTools: [],
        action: "refuse-unmanaged",
        reason: `compile failed (${headerResult.error.reason}): ${headerResult.error.message}`,
      };
    }
    const relativePath = proseExportRelativePath(runtime, definition.name);
    const safetyReason = await checkExportPathSafety(projectRoot, relativePath);
    if (safetyReason !== undefined) {
      return {
        runtime,
        name: definition.name,
        supportLevel,
        relativePath,
        droppedTools: [],
        action: "refuse-unmanaged",
        reason: safetyReason,
      };
    }
    // Plain prose: no host-specific frontmatter/enforced fields — just the
    // sentinel (as a visible provenance comment naming the missing matrix
    // record) followed by the compiled header.
    const provenance =
      `<!-- ${agentManagedSentinelText(definition)}; instruction-only prose — ` +
      `no "agents" surface record for runtime "${runtime}" in the W5 capability matrix -->`;
    const content = finalizeAgentContentHash(`${provenance}\n\n${headerResult.header}\n`);
    const existing = await readExistingFileContent(projectRoot, relativePath);
    const decided = decideAction(existing, content);
    return {
      runtime,
      name: definition.name,
      supportLevel,
      relativePath,
      content,
      droppedTools: [],
      action: decided.action,
      ...(decided.reason !== undefined ? { reason: decided.reason } : {}),
    };
  }

  // native | adapter: a real host renderer backs this runtime.
  const compiled = compileAgentDefinition(definition, runtime as HostToolTarget);
  if (!compiled.ok) {
    return {
      runtime,
      name: definition.name,
      supportLevel,
      droppedTools: [],
      action: "refuse-unmanaged",
      reason: `compile failed (${compiled.error.reason}): ${compiled.error.message}`,
    };
  }
  const hostResult = compiled.result as HostAgentExport;
  const safetyReason = await checkExportPathSafety(projectRoot, hostResult.relativePath);
  if (safetyReason !== undefined) {
    return {
      runtime,
      name: definition.name,
      supportLevel,
      relativePath: hostResult.relativePath,
      droppedTools: hostResult.droppedTools,
      action: "refuse-unmanaged",
      reason: safetyReason,
    };
  }
  const existing = await readExistingFileContent(projectRoot, hostResult.relativePath);
  const decided = decideAction(existing, hostResult.content);
  return {
    runtime,
    name: definition.name,
    supportLevel,
    relativePath: hostResult.relativePath,
    content: hostResult.content,
    droppedTools: hostResult.droppedTools,
    action: decided.action,
    ...(decided.reason !== undefined ? { reason: decided.reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface WriteAgentExportOptions {
  readonly dryRun?: boolean;
  /**
   * R1-F9: overwrite a `refuse-modified` plan (a managed, sentinel-bearing
   * file whose content no longer matches its own recorded content hash —
   * i.e. it was hand-edited since export). Never overrides
   * `refuse-unmanaged` (a file with no sentinel at all, or an unsafe/
   * symlinked path) — those are never something `--force` can push through.
   */
  readonly force?: boolean;
}

export interface WriteAgentExportResult {
  readonly written: boolean;
  readonly plan: AgentExportPlan;
}

/**
 * Apply a plan produced by `planAgentExport`. Never writes on
 * `refuse-unmanaged`, `unchanged`, `compiled-only`, or `dryRun: true`;
 * `refuse-modified` is written only with `opts.force: true` — `written`
 * reports which happened. Re-checks the target path's symlink safety
 * immediately before writing (defense in depth alongside `planAgentExport`'s
 * own check, in case the plan is stale relative to the filesystem). Creates
 * parent directories as needed.
 */
export async function writeAgentExport(
  projectRoot: string,
  plan: AgentExportPlan,
  opts: WriteAgentExportOptions = {},
): Promise<WriteAgentExportResult> {
  if (opts.dryRun) return { written: false, plan };
  const writable = plan.action === "create" || plan.action === "update" || (plan.action === "refuse-modified" && opts.force === true);
  if (!writable) return { written: false, plan };
  if (plan.relativePath === undefined || plan.content === undefined) return { written: false, plan };

  const safetyReason = await checkExportPathSafety(projectRoot, plan.relativePath);
  if (safetyReason !== undefined) {
    return { written: false, plan: { ...plan, action: "refuse-unmanaged", reason: safetyReason } };
  }

  const absolute = path.join(projectRoot, ...plan.relativePath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, plan.content, "utf8");
  return { written: true, plan };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/** The directory each host runtime's exports live under — the same directories the compile.ts renderers write `relativePath`s inside. */
const HOST_AGENTS_DIR: Readonly<Record<HostToolTarget, string>> = {
  claude: ".claude/agents",
  codex: ".codex/agents",
  kiro: ".kiro/agents",
  opencode: ".opencode/agents",
};

/**
 * R1-F3: read-only scan for sentinel-marked files under `runtime`'s agents
 * directory — the shared, symlink-safe core `removeManagedAgentExports` and
 * `hasManagedAgentExports` both build on. Never descends into a symlinked
 * agents directory (an attacker-controlled `.codex/agents -> <outside-dir>`
 * previously let a delete reach outside the project root), and never counts
 * a symlinked entry inside it as managed — `readdir`'s `Dirent.isFile()`
 * already reflects the directory ENTRY's own type (not the symlink target),
 * so a symlinked file's `isFile()` is `false`; the extra `lstat` below is
 * defense in depth for platforms where that is not guaranteed.
 */
async function scanManagedAgentExports(
  projectRoot: string,
  runtime: Exclude<AgentExportRuntime, "keryx-shell">,
): Promise<string[]> {
  const dirRelative = HOST_AGENTS_DIR[runtime];
  const dirAbsolute = path.join(projectRoot, ...dirRelative.split("/"));

  let dirStats;
  try {
    dirStats = await lstat(dirAbsolute);
  } catch {
    return [];
  }
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) return [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dirAbsolute, { withFileTypes: true });
  } catch {
    return [];
  }

  const managed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relativePath = `${dirRelative}/${entry.name}`;
    const absolute = path.join(projectRoot, ...relativePath.split("/"));
    let entryStats;
    try {
      entryStats = await lstat(absolute);
    } catch {
      continue;
    }
    if (entryStats.isSymbolicLink()) continue;
    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch {
      continue;
    }
    if (content.includes(AGENT_SENTINEL_PREFIX)) managed.push(relativePath);
  }
  return managed.sort();
}

/**
 * Delete every sentinel-marked file this exporter previously wrote for
 * `runtime` — never a file lacking the sentinel, whatever else sits in that
 * directory, and never anything reached through a symlink (R1-F3). `keryx-shell`
 * writes no file (see `planAgentExport`), so this always returns `[]` for
 * it. Returns the removed files' project-relative paths, sorted.
 */
export async function removeManagedAgentExports(projectRoot: string, runtime: AgentExportRuntime): Promise<string[]> {
  if (runtime === "keryx-shell") return [];
  const managed = await scanManagedAgentExports(projectRoot, runtime);
  const removed: string[] = [];
  for (const relativePath of managed) {
    await rm(path.join(projectRoot, ...relativePath.split("/")));
    removed.push(relativePath);
  }
  return removed;
}

/**
 * R1-F8: read-only presence check for a runtime's managed agent exports —
 * whether ANY sentinel-marked file currently exists, without deleting
 * anything. `installer.ts`'s `customUninstallDryRun` uses this (via the
 * `agents` surface's `inspect`) so a dry-run uninstall reports
 * "nothing-to-remove" for a directory holding only unmanaged files, instead
 * of "would-remove" merely because the directory exists.
 */
export async function hasManagedAgentExports(projectRoot: string, runtime: AgentExportRuntime): Promise<boolean> {
  if (runtime === "keryx-shell") return false;
  return (await scanManagedAgentExports(projectRoot, runtime)).length > 0;
}
