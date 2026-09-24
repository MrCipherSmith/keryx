// Flow 310 (W2 agent-definitions catalog), T7: the `agents` surfaces —
// keryx's own bundled/project agent catalog (`src/agents/catalog.ts`)
// compiled and exported into a host's OWN agent-definition directory
// (`.claude/agents`, `.codex/agents`, `.kiro/agents`, `.opencode/agents`),
// via `src/agents/export.ts`'s `planAgentExport`/`writeAgentExport`/
// `removeManagedAgentExports`.
//
// These surfaces are OPT-IN (`optIn: true` — `types.ts`) so `keryx
// integrations install --runtime <id>` with no `--surface` keeps its
// pre-flow-310 behavior unchanged; an agents export happens only when
// `--surface agents` (or the surface id) is named explicitly.
//
// Registered ONLY where first-party docs confirm a subagent file shape
// (context.md's "Host agent-file formats" research, 2026-09-24) — the same
// four runtimes `src/agents/compile.ts`'s `renderHostExport` implements.
// `keryx-shell` carries no surface here on purpose: it is not a host
// settings/file surface at all (it is keryx's own dispatch engine); see
// `src/agents/export.ts`'s `defaultAgentSupportLookup` for that documented
// special case, and `registry.ts`'s `keryx-shell` adapter comment for why its
// placeholder `unsupported` table (W6's) is left untouched here.
//
// Every surface below is a CUSTOM (non-JSON) surface: no `merge`/`strip` —
// the artifact is a whole DIRECTORY of per-agent files, not one settings
// file `settings-json.ts`'s walkers could own. `customInstall` returns
// error strings (empty = success, per `installer.ts`'s contract);
// `customUninstall` returns a `CustomUninstallResult` (T17): whether
// anything was actually removed, plus a warning per hand-edited managed
// file this exporter kept rather than deleted (uninstall has no `--force`
// override for that — see `uninstallAgentsExports` below); `probe` reports
// missing/stale/unmanaged agents as problem strings for `keryx integrations
// doctor`.

// R1-F10: `loadAgentCatalog`/`planAgentExport`/etc. are imported LAZILY
// inside each async function below, never at module top level. This module
// is imported eagerly by `registry.ts` (`HARNESS_ADAPTERS`'s array literal
// references `AGENTS_CLAUDE` etc.), and `../agents/export.ts` imports back
// into `registry.ts` (`getHarnessAdapter`/`surfacesOf`) — a top-level import
// here would close that cycle and crash with a TDZ ReferenceError
// (`Cannot access 'AGENTS_CLAUDE' before initialization`) the first time
// something imports THIS module before `registry.ts`. `type`-only imports
// are erased at compile time and never execute, so they cannot participate
// in the cycle and stay at the top.
import type { AgentExportRuntime } from "../agents/types";
import { SUBSYSTEM_AGENTS, type CustomUninstallResult, type SurfaceAdapter } from "./types";

export const LAST_VERIFIED_AGENTS = "2026-09-24";

const AGENTS_DIR: Readonly<Record<AgentExportRuntime, string>> = {
  claude: ".claude/agents",
  codex: ".codex/agents",
  kiro: ".kiro/agents",
  opencode: ".opencode/agents",
  // Never referenced (no surface registered for keryx-shell), kept only so
  // this record stays total over `AgentExportRuntime`.
  "keryx-shell": "",
};

/**
 * Install every catalog agent's export for `runtime`. A `refuse-unmanaged`
 * plan (an existing file this exporter does not own) is REPORTED, not
 * overwritten — surfaced as an error string here, same as a catalog load
 * error, so an install that could not fully complete is visible as such
 * rather than silently reporting success for the agents it DID manage to
 * write.
 */
async function installAgentsExports(root: string, runtime: AgentExportRuntime): Promise<string[]> {
  const { loadAgentCatalog } = await import("../agents/catalog");
  const { planAgentExport, writeAgentExport } = await import("../agents/export");
  const catalog = loadAgentCatalog(root);
  const errors: string[] = catalog.errors.map((e) => `agents catalog: ${e.path}: ${e.message}`);
  for (const agent of catalog.agents) {
    const plan = await planAgentExport(root, agent.definition, runtime);
    // R1-F9: a bulk `integrations install --surface agents` never forces —
    // a hand-edited managed export (`refuse-modified`) is reported exactly
    // like `refuse-unmanaged`, never silently overwritten; `keryx agents
    // export --force` is the explicit, one-at-a-time override for that.
    if (plan.action === "refuse-unmanaged" || plan.action === "refuse-modified") {
      errors.push(
        `agents export ${runtime}/${agent.definition.name}: refused — ${plan.reason ?? "existing file is not keryx-managed"}`,
      );
      continue;
    }
    if (plan.action === "compiled-only") {
      // Never reached for a registered host runtime (only keryx-shell
      // compiles-only, and keryx-shell has no surface here) — kept as a
      // named no-op rather than an unreachable-branch assumption.
      continue;
    }
    await writeAgentExport(root, plan);
  }
  return errors;
}

/**
 * T17 (design pt. 3): never deletes a managed file that was hand-edited
 * since export (its content-sha256 no longer verifies) — `keryx integrations
 * uninstall` has no `--force` override for this at all; a hand edit is kept,
 * unconditionally, and reported as a warning alongside the uninstall's own
 * result line rather than silently vanishing from the report.
 */
async function uninstallAgentsExports(root: string, runtime: AgentExportRuntime): Promise<CustomUninstallResult> {
  const { removeManagedAgentExportsDetailed } = await import("../agents/export");
  const { removed, kept } = await removeManagedAgentExportsDetailed(root, runtime);
  return {
    removed: removed.length > 0,
    warnings: kept.map((k) => `kept ${k.relativePath} — ${k.reason}`),
  };
}

/**
 * R1-F8: structured dry-run state for `installer.ts`'s `customUninstallDryRun`
 * — whether ANY sentinel-marked export currently exists for `runtime`,
 * without touching the filesystem otherwise. `"present"` -> would-remove,
 * `"no-block"` -> nothing-to-remove (including when the directory exists but
 * holds only files this exporter does not own).
 */
async function inspectAgentsExports(
  root: string,
  runtime: AgentExportRuntime,
): Promise<{ readonly state: "absent-file" | "no-block" | "present" | "stale" | "malformed"; readonly message?: string }> {
  const { hasManagedAgentExports } = await import("../agents/export");
  return { state: (await hasManagedAgentExports(root, runtime)) ? "present" : "no-block" };
}

/**
 * Missing (never exported), stale (source changed since export), or
 * unmanaged (an existing file this exporter refuses to touch) agents, one
 * problem string per finding. Empty = every catalog agent is exported and
 * up to date for `runtime`.
 */
async function probeAgentsExports(root: string, runtime: AgentExportRuntime): Promise<string[]> {
  const { loadAgentCatalog } = await import("../agents/catalog");
  const { planAgentExport } = await import("../agents/export");
  const catalog = loadAgentCatalog(root);
  const problems: string[] = catalog.errors.map((e) => `agents catalog: ${e.path}: ${e.message}`);
  for (const agent of catalog.agents) {
    const plan = await planAgentExport(root, agent.definition, runtime);
    if (plan.action === "create") {
      problems.push(`${runtime}/${agent.definition.name}: not yet exported (${plan.relativePath})`);
    } else if (plan.action === "update") {
      problems.push(`${runtime}/${agent.definition.name}: exported file is stale (${plan.relativePath})`);
    } else if (plan.action === "refuse-unmanaged") {
      problems.push(`${runtime}/${agent.definition.name}: existing file at ${plan.relativePath} is not keryx-managed`);
    } else if (plan.action === "refuse-modified") {
      problems.push(`${runtime}/${agent.definition.name}: exported file at ${plan.relativePath} was hand-edited since export`);
    }
  }
  return problems;
}

function agentsSurface(params: {
  readonly runtime: AgentExportRuntime;
  readonly confidence: "verified" | "experimental";
  readonly sourceDocs: readonly string[];
  readonly riskNotes?: readonly string[];
}): SurfaceAdapter {
  const { runtime, confidence, sourceDocs, riskNotes } = params;
  const relativePath = AGENTS_DIR[runtime];
  return {
    id: "agents",
    flag: "agents",
    subsystem: SUBSYSTEM_AGENTS,
    sentinel: "keryx:agents-export",
    confidence,
    ...(riskNotes !== undefined ? { riskNotes } : {}),
    sourceDocs,
    optIn: true,
    settingsFile: (root) => `${root}/${relativePath}`,
    relativePath,
    label: relativePath,
    slots: [],
    customInstall: (root) => installAgentsExports(root, runtime),
    customUninstall: (root) => uninstallAgentsExports(root, runtime),
    probe: (root) => probeAgentsExports(root, runtime),
    inspect: (root) => inspectAgentsExports(root, runtime),
  };
}

/**
 * Claude Code — https://code.claude.com/docs/en/sub-agents — VERIFIED (T1's
 * docs check): `.claude/agents/<name>.md`, documented YAML frontmatter,
 * `model: inherit` accepted. This is the one host `compile.ts`'s
 * `renderClaudeExport` fully implements against a confirmed shape, so its
 * surface (unlike codex/kiro/opencode below) carries `confidence:
 * "verified"` — which, per `matrix.ts`'s `classifySurfaceState`, is what
 * makes the matrix report this surface `native` (host-hook adapter +
 * verified + `customInstall` present).
 */
export const AGENTS_CLAUDE: SurfaceAdapter = agentsSurface({
  runtime: "claude",
  confidence: "verified",
  sourceDocs: ["https://code.claude.com/docs/en/sub-agents"],
});

/**
 * Codex — https://developers.openai.com/codex/subagents — fields verified,
 * but registered EXPERIMENTAL (T1's docs check: "register surface as
 * experimental — tool allowlist cannot be expressed"): codex has no
 * per-tool allowlist at all, only `sandbox_mode`, so this surface cannot
 * express the same tool-restriction guarantee claude's does.
 */
export const AGENTS_CODEX: SurfaceAdapter = agentsSurface({
  runtime: "codex",
  confidence: "experimental",
  sourceDocs: ["https://developers.openai.com/codex/subagents"],
  riskNotes: [
    "Codex has no per-tool allowlist — access is governed entirely by sandbox_mode (read-only/workspace-write); a tool a definition names but the sandbox mode does not itself restrict is NOT enforced the way claude's per-tool allowlist is.",
  ],
});

/**
 * Kiro — https://kiro.dev/docs/custom-agents/configuration-reference/ —
 * EXPERIMENTAL: unknown-key tolerance is undocumented (why the managed
 * sentinel rides inside `prompt` rather than a new top-level key — see
 * `compile.ts`'s kiro renderer), and Kiro's own hook/steering surfaces
 * elsewhere in this registry are already experimental for the same class of
 * reason (third-party-reported field names).
 */
export const AGENTS_KIRO: SurfaceAdapter = agentsSurface({
  runtime: "kiro",
  confidence: "experimental",
  sourceDocs: ["https://kiro.dev/docs/custom-agents/configuration-reference/"],
  riskNotes: [
    "Kiro's unknown-key tolerance for .kiro/agents/*.json is not documented, so the managed sentinel is written as the first line of `prompt` rather than a new top-level key; verify on a live install.",
  ],
});

/**
 * OpenCode — https://opencode.ai/docs/agents/ — EXPERIMENTAL: the
 * documented `tools` boolean map is itself flagged deprecated in OpenCode's
 * own docs in favour of `permission`, which this exporter targets, but that
 * migration's stability is not independently confirmed here.
 */
export const AGENTS_OPENCODE: SurfaceAdapter = agentsSurface({
  runtime: "opencode",
  confidence: "experimental",
  sourceDocs: ["https://opencode.ai/docs/agents/"],
  riskNotes: [
    "OpenCode's documented `tools` boolean map is flagged deprecated in favour of `permission`, which this exporter targets — the stability of that migration is not independently confirmed here.",
  ],
});
