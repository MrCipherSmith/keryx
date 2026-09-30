// Flow 313 (W4 portability), T9: the `rules-export` surface — one per
// harness, OPT-IN (`optIn: true`) — that renders the canonical
// `.metaproject/rules/**` library into that harness's own instruction file as
// a managed `<!-- keryx:rules -->` block (index only: path + description per
// rule, never rule bodies). Spec:
// docs/requirements/keryx-agent-platform-expansion/workstreams/W4-portability.md
// "Canonical instructions → per-harness instruction files".
//
// Distinct from `SUBSYSTEM_INSTRUCTIONS`'s `markdown-block.ts` surfaces
// (gemini-cli/kiro/github-copilot-agent's `keryx:instructions` pointer): this
// surface uses `markdown-block.ts`'s parameterised `ManagedBlockSpec`
// (`RULES_BLOCK_START_MARKER`/`RULES_BLOCK_END_MARKER` from
// `../rules/export-render`) so a file already carrying a `keryx:instructions`
// block (GEMINI.md, `.github/copilot-instructions.md`) keeps that OTHER block
// byte-for-byte untouched when this surface installs/uninstalls its own.
//
// `optIn: true` on every surface below means `keryx integrations install
// --runtime <id>` with no `--surface` is completely unchanged by this file's
// existence — only `--surface rules-export` (or `--surface instructions`,
// its flag) reaches these, same discipline `surfaces-agents.ts`'s `agents`
// surfaces already use.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeContained } from "../lib/contained-write";
import { isPathIgnored } from "../lib/git-local-ignore";
import { syncMetaprojectIgnoreRules } from "../lib/metaproject-gitignore";
import { refuseEscapingSymlink } from "../lib/symlink-safety";
import { insertRulesBlockAfterIndex } from "../rules/codex-override";
import { hasManagedRulesBlock } from "../rules/managed-index-block";
import { ignoredLocalTargetPaths, localRootEntry, normalizeEntrypointTargets, type EntrypointRuntime } from "../rules/entrypoint-targets";
import {
  collectCanonicalRules,
  renderRulesBlockBody,
  RULES_BLOCK_END_MARKER,
  RULES_BLOCK_START_MARKER,
  type SkippedCanonicalRule,
} from "../rules/export-render";
import { resolveClaudeSettingsTarget } from "./claude-settings";
import { resolveRulesExportTarget, rulesExportCandidates, rulesExportRelativePath } from "./rules-export-target";
import {
  inspectMarkdownBlock,
  installMarkdownBlock,
  probeMarkdownBlock,
  uninstallMarkdownBlock,
  type ManagedBlockSpec,
} from "./markdown-block";
import {
  SUBSYSTEM_RULES_EXPORT,
  type Confidence,
  type CustomInstallResult,
  type CustomUninstallResult,
  type SurfaceAdapter,
} from "./types";

export const LAST_VERIFIED_RULES_EXPORT = "2026-09-24";

interface RulesSpecResult {
  readonly spec: ManagedBlockSpec;
  readonly skipped: readonly SkippedCanonicalRule[];
}

/** Builds this call's `ManagedBlockSpec` by collecting+rendering the CURRENT rule set — never cached, so a rule added/removed since the last install is reflected on the next one. */
async function rulesSpec(root: string): Promise<RulesSpecResult> {
  const { rules, skipped } = await collectCanonicalRules(root);
  const body = renderRulesBlockBody(rules);
  return {
    spec: { startMarker: RULES_BLOCK_START_MARKER, endMarker: RULES_BLOCK_END_MARKER, render: () => body },
    skipped,
  };
}

/** Review round 1, F7: a rule `collectCanonicalRules` refused to index (an unsafe path) is surfaced here as a problem string, on every path this surface reports through — never silently dropped. */
function skippedMessages(skipped: readonly SkippedCanonicalRule[]): string[] {
  return skipped.map((s) => `${s.relativePath}: ${s.reason}`);
}

/**
 * Review round 2 fix (R2-F6): a rule `collectCanonicalRules` skips (an unsafe
 * name) used to be merged into the SAME `string[]` `installMarkdownBlock`
 * itself returns real errors on, so `installer.ts` treated a skip exactly
 * like a hard failure — exit 1, `rules-export` reported `failed`, and
 * `recordSurfaceInstalled` never ran, even though the block WAS written to
 * disk (with every SAFE rule indexed) and `--dry-run` predicted success the
 * whole time. Chosen fix: skip unsafe rules and report success-with-warnings,
 * consistently between dry-run and a real install — `errors` carries only a
 * REAL `installMarkdownBlock` failure (a symlink refusal, an unterminated
 * block), and `warnings` carries the skip messages, which `installer.ts`
 * folds into the surface's `SurfaceResult.warnings` without failing the
 * install or skipping `recordSurfaceInstalled`.
 */
async function installRulesExport(root: string, relativePath: string, frontMatter?: string): Promise<CustomInstallResult> {
  const { spec, skipped } = await rulesSpec(root);
  const errors = await installMarkdownBlock(root, relativePath, frontMatter, spec);
  return { errors, warnings: skippedMessages(skipped) };
}

async function uninstallRulesExport(
  root: string,
  relativePath: string,
  frontMatter?: string,
): Promise<boolean | CustomUninstallResult> {
  const { spec, skipped } = await rulesSpec(root);
  const removed = await uninstallMarkdownBlock(root, relativePath, frontMatter, spec);
  return skipped.length === 0 ? removed : { removed, warnings: skippedMessages(skipped) };
}

/**
 * Review round 3 fix (R3-F6, the still-open half of R2-F6): `probe` feeds
 * `installer.ts`'s `liveStatusOf`/`doctorIntegration`, which reports a
 * surface `invalid` — command exit 1 — the moment `probe` returns anything
 * non-empty. A skipped-rule warning is NOT a health problem with the
 * INSTALLED block (the block itself is fine; a rule with an unsafe name was
 * simply left out of it, exactly as install already reported at install
 * time) — merging it into `problems` here made `doctor` report `invalid`
 * immediately after an install that itself succeeded with warnings. `probe`
 * now reports only real block-health problems (missing file, stale content,
 * an unterminated/malformed block); a skipped rule is never one of them.
 */
async function probeRulesExport(root: string, relativePath: string): Promise<string[]> {
  const { spec } = await rulesSpec(root);
  return probeMarkdownBlock(root, relativePath, spec);
}

async function inspectRulesExport(root: string, relativePath: string) {
  const { spec } = await rulesSpec(root);
  return inspectMarkdownBlock(root, relativePath, spec);
}

/**
 * Round-4 fix (R2-F6 remainder): the same skip warnings `installRulesExport`
 * reports on a real install, computed here too so `installer.ts`'s
 * `customInstallDryRun` can surface them from `--dry-run` — before this fix,
 * `keryx integrations install --dry-run` (human and `--json`) always
 * reported `warnings: []` for this surface, even when an unsafe rule name
 * would be skipped, and only the immediately-following real install said so.
 */
async function dryRunRulesExportWarnings(root: string): Promise<readonly string[]> {
  const { skipped } = await rulesSpec(root);
  return skippedMessages(skipped);
}

interface RulesExportParams {
  readonly relativePath: string;
  readonly frontMatter?: string;
  readonly confidence: Confidence;
  readonly sourceDocs: readonly string[];
  readonly riskNotes?: readonly string[];
}

function rulesExportSurface(params: RulesExportParams): SurfaceAdapter {
  const { relativePath, frontMatter, confidence, sourceDocs, riskNotes } = params;
  return {
    ...rulesExportIdentity(confidence, sourceDocs, riskNotes),
    settingsFile: (root) => path.join(root, ...relativePath.split("/")),
    relativePath,
    label: relativePath,
    customInstall: (root) => installRulesExport(root, relativePath, frontMatter),
    customUninstall: (root) => uninstallRulesExport(root, relativePath, frontMatter),
    probe: (root) => probeRulesExport(root, relativePath),
    inspect: (root) => inspectRulesExport(root, relativePath),
    dryRunWarnings: (root) => dryRunRulesExportWarnings(root),
  };
}

/** What every rules-export surface shares, whatever file it writes. */
function rulesExportIdentity(
  confidence: Confidence,
  sourceDocs: readonly string[],
  riskNotes: readonly string[] | undefined,
): Pick<SurfaceAdapter, "id" | "flag" | "subsystem" | "sentinel" | "confidence" | "riskNotes" | "sourceDocs" | "optIn" | "slots"> {
  return {
    id: "rules-export",
    // Review round 1, F19: this surface used to share the `instructions`
    // flag with `markdown-block.ts`'s pointer-block surfaces (gemini-cli's
    // GEMINI.md, kiro's steering file, ...), which made
    // `--surface instructions` also install/uninstall `rules-export` — no
    // longer opt-in in effect, even though `optIn: true` is set below. Its
    // own flag keeps `--surface instructions` and `--surface rules` (or
    // `--surface rules-export`, the id) fully independent selectors.
    flag: "rules",
    subsystem: SUBSYSTEM_RULES_EXPORT,
    sentinel: "keryx:rules",
    confidence,
    ...(riskNotes !== undefined ? { riskNotes } : {}),
    sourceDocs,
    optIn: true,
    slots: [],
  };
}

/**
 * Flow 363: a rules-export surface whose file follows `agentEntrypoints.root`
 * (`resolveRulesExportTarget`) — `CLAUDE.local.md` / `AGENTS.override.md`
 * under scope local, the team file under scope shared. Every entry point
 * resolves the target afresh, so install, uninstall, probe, inspect, dry-run
 * and install-state (via `relativePathFor`) cannot name different files.
 * `relativePath` is only the default the capability matrix shows.
 */
function entrypointRulesExportSurface(
  runtime: EntrypointRuntime,
  params: Omit<RulesExportParams, "relativePath" | "frontMatter">,
): SurfaceAdapter {
  const [teamFile, localFile] = rulesExportCandidates(runtime) as [string, string];
  const fileFor = (root: string) => path.join(root, ...(rulesExportRelativePath(root, runtime) ?? localFile).split("/"));
  return {
    ...rulesExportIdentity(params.confidence, params.sourceDocs, params.riskNotes),
    relativePath: localFile,
    relativePathCandidates: [localFile, teamFile],
    relativePathFor: (root) => rulesExportRelativePath(root, runtime),
    settingsFile: fileFor,
    label: localFile,
    customInstall: (root) => installEntrypointRulesExport(root, runtime),
    customUninstall: (root) => uninstallEntrypointRulesExport(root, runtime),
    probe: async (root) => {
      const target = resolveRulesExportTarget(root, runtime);
      return target.kind === "file" ? probeRulesExport(root, target.path) : [];
    },
    inspect: async (root) => {
      const target = resolveRulesExportTarget(root, runtime);
      return target.kind === "file" ? inspectRulesExport(root, target.path) : { state: "absent-file", message: target.reason };
    },
    dryRunWarnings: async (root) => {
      const target = resolveRulesExportTarget(root, runtime);
      return [...(target.kind === "none" ? [target.reason] : []), ...(await dryRunRulesExportWarnings(root))];
    },
  };
}

/**
 * Install into the resolved file. A local file is made git-ignored first,
 * through flow 361's one ignore writer, when this checkout's rules do not
 * ignore it yet (a fresh clone before `keryx update`); a block the same
 * runtime left in its local file before switching to shared is removed, so
 * the block is never in both. With no target the install writes nothing and
 * succeeds with the reason as its warning.
 */
async function installEntrypointRulesExport(root: string, runtime: EntrypointRuntime): Promise<CustomInstallResult> {
  const target = resolveRulesExportTarget(root, runtime);
  if (target.kind === "none") {
    const { skipped } = await rulesSpec(root);
    return { errors: [], warnings: [target.reason, ...skippedMessages(skipped)] };
  }
  const ignoreNotices = target.scope === "local" ? await ignoreLocalTarget(root, target.path) : [];
  const result =
    runtime === "codex" && target.scope === "local" ? await installIntoOverride(root, target.path) : await installRulesExport(root, target.path);
  if (result.errors.length > 0) return { errors: result.errors, warnings: [...ignoreNotices, ...(result.warnings ?? [])] };
  const cleanup = await removeFromOtherCandidate(root, runtime, target.path);
  return { errors: [], warnings: [...ignoreNotices, ...cleanup, ...(result.warnings ?? [])] };
}

/**
 * The first install into a keryx-generated `AGENTS.override.md` puts the
 * block right after the index block — where every regeneration carries it
 * (`renderCodexOverride`) — instead of appending it after the team text, so
 * the next `keryx update` does not rewrite the file only to move it. An
 * override that already has the block is refreshed in place like any file.
 */
async function installIntoOverride(root: string, relativePath: string): Promise<CustomInstallResult> {
  const { spec, skipped } = await rulesSpec(root);
  if ((await refuseEscapingSymlink(root, relativePath)) === undefined) {
    const content = await readFile(path.join(root, ...relativePath.split("/")), "utf8");
    const placed = hasManagedRulesBlock(content) ? undefined : insertRulesBlockAfterIndex(content, spec.render());
    if (placed !== undefined) {
      await writeContained(root, relativePath, placed);
      return { errors: [], warnings: skippedMessages(skipped) };
    }
  }
  return installRulesExport(root, relativePath);
}

async function uninstallEntrypointRulesExport(root: string, runtime: EntrypointRuntime): Promise<boolean | CustomUninstallResult> {
  const target = resolveRulesExportTarget(root, runtime);
  if (target.kind === "none") return { removed: false, warnings: [target.reason] };
  const outcome = await uninstallRulesExport(root, target.path);
  const cleanup = await removeFromOtherCandidate(root, runtime, target.path);
  const removed = typeof outcome === "boolean" ? outcome : outcome.removed;
  const warnings = [...cleanup, ...(typeof outcome === "boolean" ? [] : (outcome.warnings ?? []))];
  return warnings.length === 0 ? removed || cleanup.length > 0 : { removed: removed || cleanup.length > 0, warnings };
}

/**
 * When the block goes to the team file, a copy left in the runtime's local
 * file (installed while its scope was local) is taken out. Never the other
 * way round: a block in the team file is the team's, or `keryx update`'s to
 * move. Returns a line for the output when something was removed.
 */
async function removeFromOtherCandidate(root: string, runtime: EntrypointRuntime, written: string): Promise<string[]> {
  const localFile = localRootEntry(runtime).path;
  if (written === localFile) return [];
  const inspection = await inspectRulesExport(root, localFile);
  if (inspection.state !== "present" && inspection.state !== "stale") return [];
  const { spec } = await rulesSpec(root);
  if (!(await uninstallMarkdownBlock(root, localFile, undefined, spec))) return [];
  return [`${localFile}: removed the keryx:rules block left there — the block is in ${written} now.`];
}

/**
 * Flow 361's ignore writer, run for a local target git does not ignore yet.
 * The managed `info/exclude` block always lists both local root targets, so
 * this runs only where no such block exists — a fresh clone, or a project
 * `keryx update` has not reached since 0.3.45 — and writes the full set
 * `keryx update` would (`ignoredLocalTargetPaths`).
 */
async function ignoreLocalTarget(root: string, relativePath: string): Promise<string[]> {
  const check = await isPathIgnored(root, relativePath);
  if (!check.git || check.ignored) return [];
  const agentEntrypoints = readAgentEntrypoints(root);
  const targets = normalizeEntrypointTargets(agentEntrypoints).targets;
  const notices: string[] = [];
  await syncMetaprojectIgnoreRules(root, {
    localTargets: ignoredLocalTargetPaths({ root: targets.root, claudeSettings: resolveClaudeSettingsTarget(root) }),
    onNotice: (line) => notices.push(line),
  });
  return notices;
}

function readAgentEntrypoints(root: string): unknown {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(root, ".metaproject", "metaproject.json"), "utf8"));
    return typeof manifest === "object" && manifest !== null ? (manifest as { agentEntrypoints?: unknown }).agentEntrypoints : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code — keryx's primary entrypoint (the `keryx:index` block): VERIFIED
 * that Claude Code reads `CLAUDE.md` and `CLAUDE.local.md` end-to-end
 * (https://code.claude.com/docs/en/memory — `CLAUDE.local.md` is the
 * per-project, per-developer file, loaded alongside `CLAUDE.md`). Flow 363:
 * the block goes where the index block goes (`resolveRulesExportTarget`).
 */
export const RULES_EXPORT_CLAUDE: SurfaceAdapter = entrypointRulesExportSurface("claude", {
  confidence: "verified",
  sourceDocs: ["https://code.claude.com/docs/en/memory"],
});

/**
 * Codex — AGENTS.md is the cross-tool convention Codex documents reading
 * (https://agents.md/), and `AGENTS.override.md` is the file Codex reads
 * INSTEAD of it in the same directory — VERIFIED. Flow 363: under scope
 * local the block goes into the keryx-generated override, which carries it
 * across every regeneration (`renderCodexOverride`).
 */
export const RULES_EXPORT_CODEX: SurfaceAdapter = entrypointRulesExportSurface("codex", {
  confidence: "verified",
  sourceDocs: ["https://agents.md/", "https://developers.openai.com/codex/"],
});

/**
 * gemini-cli — GEMINI.md, same file and same doc `INSTRUCTIONS_GEMINI_CLI`
 * (`surfaces-w5b.ts`) already cites — EXPERIMENTAL, same caveat: whether
 * Gemini CLI reads it end-to-end beyond the documented `context.fileName`
 * option is not independently confirmed here.
 */
export const RULES_EXPORT_GEMINI_CLI: SurfaceAdapter = rulesExportSurface({
  relativePath: "GEMINI.md",
  confidence: "experimental",
  sourceDocs: ["https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md"],
  riskNotes: [
    "Whether Gemini CLI actually reads GEMINI.md end-to-end (beyond the documented context.fileName option) is not independently confirmed here.",
  ],
});

/**
 * github-copilot-agent — `.github/copilot-instructions.md`, same file and
 * docs `INSTRUCTIONS_GITHUB_COPILOT_AGENT` (`surfaces-w5b.ts`) cites —
 * EXPERIMENTAL: whether the Copilot CODING AGENT (as opposed to the Copilot
 * CLI/IDE chat) reads this file the same way is not independently confirmed.
 * The rules-export block is appended into the existing file with NO front
 * matter (the file's documented shape carries none).
 */
export const RULES_EXPORT_GITHUB_COPILOT_AGENT: SurfaceAdapter = rulesExportSurface({
  relativePath: ".github/copilot-instructions.md",
  confidence: "experimental",
  sourceDocs: [
    "https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide",
    "https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions/",
  ],
  riskNotes: [
    "Whether the Copilot coding agent (as opposed to the Copilot CLI/IDE chat) reads .github/copilot-instructions.md the same way is not independently confirmed here.",
  ],
});

const CURSOR_RULES_FRONT_MATTER = "---\ndescription: Keryx canonical project rules index\nalwaysApply: true\n---\n\n";

/**
 * Cursor — project rules live under `.cursor/rules/*.mdc` with a YAML front
 * matter carrying `description`/`alwaysApply` (among other documented
 * fields) — EXPERIMENTAL here: the exact set of front-matter keys Cursor
 * tolerates on an unknown/extra key is not independently confirmed.
 */
export const RULES_EXPORT_CURSOR: SurfaceAdapter = rulesExportSurface({
  relativePath: ".cursor/rules/keryx-rules.mdc",
  frontMatter: CURSOR_RULES_FRONT_MATTER,
  confidence: "experimental",
  sourceDocs: ["https://docs.cursor.com/context/rules"],
  riskNotes: [
    "Cursor's exact tolerance for extra/unknown .mdc front-matter keys alongside description/alwaysApply is not independently confirmed here — verify on a live install.",
  ],
});

const KIRO_RULES_FRONT_MATTER = "---\ninclusion: always\n---\n\n";

/**
 * Kiro — steering files, same directory `INSTRUCTIONS_KIRO` (`surfaces-w5b.ts`)
 * already writes into, with `inclusion: always` front matter —
 * EXPERIMENTAL, same caveat: open Kiro issues report `inclusion` modes are
 * not always honoured.
 */
export const RULES_EXPORT_KIRO: SurfaceAdapter = rulesExportSurface({
  relativePath: ".kiro/steering/keryx-rules.md",
  frontMatter: KIRO_RULES_FRONT_MATTER,
  confidence: "experimental",
  sourceDocs: ["https://kiro.dev/docs/steering/"],
  riskNotes: ["Open Kiro issues report that steering file `inclusion` modes are not always honoured, even with `inclusion: always` set — verify on a live install."],
});

const WINDSURF_RULES_FRONT_MATTER = "---\ntrigger: always_on\n---\n\n";

/**
 * Windsurf — workspace rules under `.windsurf/rules/*.md`, `trigger:
 * always_on` front matter always applies the rule with no manual/glob
 * condition — EXPERIMENTAL: not independently confirmed against a live
 * install here.
 */
export const RULES_EXPORT_WINDSURF: SurfaceAdapter = rulesExportSurface({
  relativePath: ".windsurf/rules/keryx-rules.md",
  frontMatter: WINDSURF_RULES_FRONT_MATTER,
  confidence: "experimental",
  sourceDocs: ["https://docs.windsurf.com/windsurf/cascade/memories"],
  riskNotes: ["Windsurf's exact handling of an unrecognised trigger value or extra front-matter keys is not independently confirmed here — verify on a live install."],
});
