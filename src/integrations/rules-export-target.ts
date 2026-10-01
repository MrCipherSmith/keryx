// Flow 363: the ONE resolver for "which file does the Claude or Codex
// rules-export surface write its `keryx:rules` block into". Until 0.3.47 the
// two surfaces carried a fixed `CLAUDE.md` / `AGENTS.md` and so wrote a tracked
// team file on every install — the uncommitted edit flow 361 took out of every
// other keryx writer. They now follow `agentEntrypoints.root`, the way the
// `keryx:index` block does, and install, uninstall, probe, inspect, dry-run,
// install-state and `bundle import --render-for` all ask this module.
//
// Synchronous on purpose, like `./claude-settings.ts`: `SurfaceAdapter`'s
// `relativePathFor`/`settingsFile` are synchronous, and the answer needs only
// the manifest and two small file reads. It must also stay free of the index
// block renderer (`src/rules/agent-entrypoints.ts` and what imports it):
// this module is on the core entry's graph (AFC-19, `src/core-package.test.ts`).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { trackedInGitSync } from "../lib/git-head";
import { parseCodexOverrideProvenance } from "../rules/codex-override";
import {
  isLocalFileOf,
  isTeamFileOf,
  localRootEntry,
  normalizeEntrypointTargets,
  rulesExportTeamFile,
  sharedRootEntry,
  type EntrypointRuntime,
  type EntrypointScope,
} from "../rules/entrypoint-targets";
import { hasManagedRulesBlock } from "../rules/managed-index-block";

const MANIFEST_REL = ".metaproject/metaproject.json";

export type RulesExportTarget =
  /** The block goes into `path`. */
  | { readonly kind: "file"; readonly path: string; readonly scope: EntrypointScope }
  /** Nothing is written for this runtime; `reason` says why, for the install's warning. */
  | { readonly kind: "none"; readonly reason: string };

/** Every file the resolver can name for `runtime`: the team file and the local target. */
export function rulesExportCandidates(runtime: EntrypointRuntime): readonly string[] {
  return [sharedRootEntry(runtime).path, localRootEntry(runtime).path];
}

function readTextSync(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function manifestAgentEntrypoints(projectRoot: string): unknown {
  const text = readTextSync(path.join(projectRoot, ...MANIFEST_REL.split("/")));
  if (text === undefined) return undefined;
  try {
    const manifest: unknown = JSON.parse(text);
    return typeof manifest === "object" && manifest !== null ? (manifest as { agentEntrypoints?: unknown }).agentEntrypoints : undefined;
  } catch {
    return undefined;
  }
}

function fileHoldsRulesBlock(projectRoot: string, relativePath: string): boolean {
  const text = readTextSync(path.join(projectRoot, ...relativePath.split("/")));
  return text !== undefined && hasManagedRulesBlock(text);
}

/**
 * Where `runtime`'s rules-export block goes in this project.
 *
 * - `scope: "shared"`, or a manifest that does not state the runtime in entry
 *   form (a legacy string array, no manifest): the team file, as before
 *   0.3.47 — until `keryx update` settles a legacy entry against `HEAD`, the
 *   entrypoint model itself counts it as shared (`normalizeEntrypointTargets`).
 * - The team file already carries a `keryx:rules` block: the team file. It
 *   is either committed there — the team's shared choice, never moved — or
 *   an uncommitted edit that `keryx update` moves; until then every command
 *   keeps working where the block is, so it never ends up in two files.
 * - Claude, scope local: `CLAUDE.local.md` — unless git tracks it: then it is
 *   the team's file and nothing is written.
 * - Codex, scope local: `AGENTS.override.md` when keryx generated it. With
 *   mode `skip`, no team file, no override yet, or an override keryx did not
 *   generate, nothing is written — Codex reads the override instead of
 *   `AGENTS.md`, so a block keryx put anywhere else would never reach it, and
 *   creating the override here would hide the team file from Codex.
 *
 * Whatever the manifest says, the answer is one of the runtime's standard
 * files (`rulesExportCandidates`) or nothing.
 */
export function resolveRulesExportTarget(projectRoot: string, runtime: EntrypointRuntime): RulesExportTarget {
  const target = resolveFromEntrypoints(projectRoot, runtime);
  // Defence in depth (flow 363 review round 1, F-001): `normalizeEntrypointTargets`
  // already turns any other path a manifest states into junk; whatever reaches
  // here, the block only ever goes into one of the runtime's standard files.
  if (target.kind === "file" && !isTeamFileOf(runtime, target.path) && !isLocalFileOf(runtime, target.path)) {
    return {
      kind: "none",
      reason: `${RUNTIME_LABEL[runtime]}: nothing written — ${target.path} is not one of the files the rules-export block goes into (${rulesExportCandidates(runtime).join(", ")}).`,
    };
  }
  return target;
}

const RUNTIME_LABEL: Record<EntrypointRuntime, string> = { claude: "Claude", codex: "Codex" };

function resolveFromEntrypoints(projectRoot: string, runtime: EntrypointRuntime): RulesExportTarget {
  const normalized = normalizeEntrypointTargets(manifestAgentEntrypoints(projectRoot));
  const entry = normalized.targets.root.find((candidate) => candidate.runtime === runtime) ?? sharedRootEntry(runtime);
  const legacy = normalized.legacy.some((item) => item.kind === "root" && item.runtime === runtime);
  const teamFile = rulesExportTeamFile(entry);
  if (entry.scope === "shared" || legacy) return { kind: "file", path: teamFile, scope: "shared" };
  if (fileHoldsRulesBlock(projectRoot, teamFile)) return { kind: "file", path: teamFile, scope: "shared" };
  if (entry.runtime === "claude") {
    // A tracked local file is the team's: `writeEntrypointBlocks` and the
    // migration refuse it for the same reason (flow 363 review round 1, F-004).
    if (trackedInGitSync(projectRoot, entry.path)) {
      return {
        kind: "none",
        reason:
          `Claude: nothing written — ${entry.path} is tracked in git, so a block there would show as a change after every install. ` +
          `Untrack it (\`git rm --cached ${entry.path}\`) to keep it per-developer, or set the claude entry's scope to "shared" in ${MANIFEST_REL}.`,
      };
    }
    return { kind: "file", path: entry.path, scope: "local" };
  }

  if (entry.mode === "skip") {
    return { kind: "none", reason: `Codex: nothing written — the codex entry in ${MANIFEST_REL} has mode "skip", so keryx writes no Codex file.` };
  }
  if (!existsSync(path.join(projectRoot, entry.source))) {
    return {
      kind: "none",
      reason: `Codex: nothing written — ${entry.source} does not exist, and ${entry.path} is only ever generated from it. Create ${entry.source} and run \`keryx update\`, or set the codex entry's scope to "shared" in ${MANIFEST_REL}.`,
    };
  }
  const override = readTextSync(path.join(projectRoot, entry.path));
  if (override === undefined) {
    return { kind: "none", reason: `Codex: nothing written — ${entry.path} has not been generated in this checkout yet; run \`keryx update\`, then install again.` };
  }
  if (parseCodexOverrideProvenance(override) === undefined) {
    return {
      kind: "none",
      reason: `Codex: nothing written — ${entry.path} exists and was not generated by keryx, so it is left untouched. Remove it and run \`keryx update\`, or set the codex entry's mode to "skip".`,
    };
  }
  return { kind: "file", path: entry.path, scope: "local" };
}

/** `resolveRulesExportTarget`'s path, or `undefined` when nothing is written. */
export function rulesExportRelativePath(projectRoot: string, runtime: EntrypointRuntime): string | undefined {
  const target = resolveRulesExportTarget(projectRoot, runtime);
  return target.kind === "file" ? target.path : undefined;
}
