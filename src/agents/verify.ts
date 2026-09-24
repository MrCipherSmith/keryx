// `verifyAgents` — the ONE checker `keryx agents verify` runs (W2 §"CLI
// surface", AC5/AC6). It never re-derives compile/export logic (D-2): every
// export-support answer comes from `agentExportSupport` in `./export.ts`
// (T7), and every schema question comes from `validateAgentDefinition`
// (`./schema.ts`, T5). This module only assembles named PROBLEMS from those
// answers plus the tool/skill/policy/origin checks the spec assigns to
// `verify` specifically.
//
// Fail-closed rule (AC6): a `generated` definition whose W1 stack pack
// cannot be confirmed to exist is a failure, not a warning — the default
// resolver returns `false` for anything it cannot positively confirm, never
// `true` by omission.
//
// Never throws. Every entry point returns a result object; a definition that
// cannot be checked at all (e.g. `--name` naming nothing in the catalog)
// becomes a `not-found` problem row rather than an exception.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { defaultBundledRoot } from "../gdskills/bundled-eval";
import { BUNDLED_GDSKILLS } from "../gdskills/catalog";
import { agentExportSupport, defaultAgentSupportLookup, type AgentSupportLookup } from "./export";
import { PROMPT_DEFENSE_BASELINE } from "./baseline";
import { loadAgentCatalog, type AgentCatalogError } from "./catalog";
import { isAgentPolicyProfile } from "./policy";
import { validateAgentDefinition } from "./schema";
import { isAgentToolName } from "./tools";
import type { AgentDefinition, AgentExportRuntime, AgentSource, ExportSupportLevel, LoadedAgent } from "./types";

export const AGENT_EXPORT_RUNTIMES: readonly AgentExportRuntime[] = [
  "claude",
  "codex",
  "kiro",
  "opencode",
  "keryx-shell",
];

export type AgentVerifyProblemReason =
  | "schema-invalid"
  | "unknown-tool"
  | "unknown-skill"
  | "unknown-policy-profile"
  | "origin-missing-source-ref"
  | "stack-pack-missing"
  | "baseline-in-body"
  | "no-export-support"
  | "catalog-error"
  | "not-found";

export interface AgentVerifyProblem {
  readonly reason: AgentVerifyProblemReason;
  readonly detail: string;
}

export interface AgentVerifyExportSupport {
  readonly runtime: AgentExportRuntime;
  readonly supportLevel: ExportSupportLevel;
}

export interface AgentVerifyResult {
  readonly name: string;
  /** `null` only for a `not-found` row — a name that resolved to nothing in the catalog. */
  readonly source: AgentSource | null;
  readonly problems: readonly AgentVerifyProblem[];
  /** The support level every export runtime resolves to, even when `problems` is empty. */
  readonly exportSupport: readonly AgentVerifyExportSupport[];
}

export interface VerifyAgentsOptions {
  /** Verify only this agent name. Absent from the catalog → a single `not-found` row. */
  readonly name?: string;
  /** Injectable bundled-agents directory (mirrors `LoadAgentCatalogOptions.bundledRoot`). */
  readonly bundledRoot?: string;
  /**
   * Confirms a W1 stack pack directory exists for a `generated` origin's
   * `sourceRef` (AC6). Default: `existsSync` a directory at
   * `<bundledRoot-or-default>/../stacks/<sourceRef>` — fails closed (returns
   * `false`) for anything it cannot positively confirm.
   */
  readonly stackPackExists?: (sourceRef: string) => boolean;
  /**
   * Confirms a `skills[]` entry resolves in the skill catalogue. Default:
   * `BUNDLED_GDSKILLS` names plus every directory under
   * `<projectRoot>/.metaproject/project-skills/<module>/<name>` and
   * `<projectRoot>/.metaproject/skills/gdskills/<category>/<name>` (the same
   * two trees `agent-catalogue-xref.test.ts`'s `knownAgentNames` walks for
   * shipped skill directories).
   */
  readonly skillExists?: (skillId: string) => boolean;
  /** Forwarded to `agentExportSupport` (T7's `export.ts`); default: `defaultAgentSupportLookup`. */
  readonly supportLookup?: AgentSupportLookup;
}

export interface VerifyAgentsReport {
  readonly ok: boolean;
  readonly agents: readonly AgentVerifyResult[];
  /** Catalog-load failures (unreadable file, invalid frontmatter/schema at load time, duplicate name, stem mismatch) — never silently dropped. */
  readonly catalogErrors: readonly AgentCatalogError[];
}

/** Default stack-pack resolver: a real directory under `<bundledRoot>/../stacks/<sourceRef>`. Fails closed. */
function defaultStackPackExists(bundledAgentsRoot: string): (sourceRef: string) => boolean {
  const stacksRoot = path.join(path.dirname(bundledAgentsRoot), "stacks");
  return (sourceRef: string): boolean => {
    if (sourceRef.length === 0) return false;
    const packDir = path.join(stacksRoot, sourceRef);
    try {
      return existsSync(packDir) && statSync(packDir).isDirectory();
    } catch {
      return false;
    }
  };
}

/**
 * Default skill resolver: `BUNDLED_GDSKILLS` names, plus every skill
 * directory under the project's installed `.metaproject/skills/gdskills`
 * tree and its local `.metaproject/project-skills` tree. Walks a
 * `<tree>/<category-or-module>/<name>` layout — the same shape
 * `agent-catalogue-xref.test.ts`'s `knownAgentNames` and
 * `project-skills.ts`'s `packageRoot` both use.
 */
function defaultSkillExists(projectRoot: string): (skillId: string) => boolean {
  const names = new Set(BUNDLED_GDSKILLS.map((skill) => skill.name));
  const trees = [
    path.join(projectRoot, ".metaproject", "skills", "gdskills"),
    path.join(projectRoot, ".metaproject", "project-skills"),
  ];
  for (const tree of trees) {
    if (!existsSync(tree)) continue;
    let categories: string[];
    try {
      categories = statSync(tree).isDirectory()
        ? readdirSync(tree, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
        : [];
    } catch {
      categories = [];
    }
    for (const category of categories) {
      const categoryDir = path.join(tree, category);
      try {
        for (const entry of readdirSync(categoryDir, { withFileTypes: true })) {
          if (entry.isDirectory()) names.add(entry.name);
        }
      } catch {
        // Unreadable category directory: skip it rather than fail the whole resolver.
      }
    }
  }
  return (skillId: string): boolean => names.has(skillId);
}

function verifyOne(
  loaded: LoadedAgent,
  options: {
    readonly stackPackExists: (sourceRef: string) => boolean;
    readonly skillExists: (skillId: string) => boolean;
    readonly supportLookup?: AgentSupportLookup;
  },
): AgentVerifyResult {
  const { definition } = loaded;
  const problems: AgentVerifyProblem[] = [];

  const validation = validateAgentDefinition(definition);
  if (!validation.ok) {
    for (const error of validation.errors) {
      problems.push({ reason: "schema-invalid", detail: `${error.field}: ${error.message}` });
    }
  }

  if (definition.body.includes(PROMPT_DEFENSE_BASELINE)) {
    problems.push({
      reason: "baseline-in-body",
      detail: `agent "${definition.name}"'s body repeats the prompt-defense baseline text — the compiler injects it once`,
    });
  }

  for (const tool of definition.tools) {
    if (!isAgentToolName(tool)) {
      problems.push({ reason: "unknown-tool", detail: `tools[] references unknown tool "${tool}"` });
    }
  }

  for (const skillId of definition.skills) {
    if (!options.skillExists(skillId)) {
      problems.push({ reason: "unknown-skill", detail: `skills[] references unknown skill "${skillId}"` });
    }
  }

  if (!isAgentPolicyProfile(definition.policy_profile)) {
    problems.push({
      reason: "unknown-policy-profile",
      detail: `policy_profile "${definition.policy_profile}" is not a known profile`,
    });
  }

  const origin = definition.origin;
  if (origin !== undefined && origin.kind !== "authored") {
    if (!origin.sourceRef || origin.sourceRef.length === 0) {
      problems.push({
        reason: "origin-missing-source-ref",
        detail: `origin.kind "${origin.kind}" requires origin.sourceRef`,
      });
    } else if (origin.kind === "generated") {
      if (!options.stackPackExists(origin.sourceRef)) {
        problems.push({
          reason: "stack-pack-missing",
          detail: `origin.sourceRef "${origin.sourceRef}" does not resolve to an existing W1 stack pack`,
        });
      }
    }
  }

  const exportSupport: AgentVerifyExportSupport[] = [];
  for (const runtime of AGENT_EXPORT_RUNTIMES) {
    let supportLevel: ExportSupportLevel;
    try {
      supportLevel = agentExportSupport(runtime, options.supportLookup);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      problems.push({ reason: "no-export-support", detail: `${runtime}: ${detail}` });
      continue;
    }
    exportSupport.push({ runtime, supportLevel });
  }

  return { name: definition.name, source: loaded.source, problems, exportSupport };
}

/**
 * Verify every agent in the catalog (or just `options.name`). Named reasons
 * only — never a thrown string. `ok` is `false` when any row carries a
 * problem, any `catalogErrors` entry exists (a definition that failed to
 * load at all is also a verification failure), or `options.name` resolved
 * to nothing.
 */
export function verifyAgents(projectRoot: string, options: VerifyAgentsOptions = {}): VerifyAgentsReport {
  const catalog = loadAgentCatalog(projectRoot, options.bundledRoot === undefined ? {} : { bundledRoot: options.bundledRoot });
  const bundledAgentsRoot = options.bundledRoot ?? path.join(defaultBundledRoot(), "agents");
  const stackPackExists = options.stackPackExists ?? defaultStackPackExists(bundledAgentsRoot);
  const skillExists = options.skillExists ?? defaultSkillExists(projectRoot);
  const supportLookup = options.supportLookup ?? defaultAgentSupportLookup;

  let candidates = catalog.agents;
  if (options.name !== undefined) {
    candidates = catalog.agents.filter((loaded) => loaded.definition.name === options.name);
  }

  const agents: AgentVerifyResult[] = candidates.map((loaded) =>
    verifyOne(loaded, { stackPackExists, skillExists, supportLookup }),
  );

  if (options.name !== undefined && candidates.length === 0) {
    agents.push({
      name: options.name,
      source: null,
      problems: [{ reason: "not-found", detail: `no agent named "${options.name}" in the catalog` }],
      exportSupport: [],
    });
  }

  const ok =
    catalog.errors.length === 0 &&
    agents.every((agent) => agent.problems.length === 0);

  return { ok, agents, catalogErrors: catalog.errors };
}

// `AgentDefinition` is re-exported so a caller of `verifyAgents` can type a
// custom `skillExists`/`stackPackExists` closure without a second import.
export type { AgentDefinition };
