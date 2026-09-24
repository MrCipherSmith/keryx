// `loadAgentCatalog` — bundled `src/gdskills/bundled/agents/*.md` definitions
// plus project `<root>/.metaproject/agents/*.md` definitions, merged with
// project-overrides-bundled-by-name (W2 §Design "Canonical format",
// plan.md's module layout).
//
// Every error — an unreadable file, a malformed frontmatter block, a
// schema-invalid definition, a file-stem/`name` mismatch, or a duplicate name
// within one source — is returned as a named `AgentCatalogError`, never
// thrown. A caller that only wants "does this load" reads `errors.length`;
// one that wants specifics reads the reasons.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultBundledRoot } from "../gdskills/bundled-eval";
import { parseAgentFrontmatter } from "./frontmatter";
import { buildAgentDefinition, validateAgentFrontmatter } from "./schema";
import type { AgentSourceKind, LoadedAgent } from "./types";

export type AgentCatalogErrorReason =
  | "unreadable-file"
  | "invalid-frontmatter"
  | "invalid-schema"
  | "name-stem-mismatch"
  | "duplicate-name";

export interface AgentCatalogError {
  readonly reason: AgentCatalogErrorReason;
  /** Absolute path of the file the error came from. */
  readonly path: string;
  readonly message: string;
  /** Present for `invalid-schema`: one entry per validator finding. */
  readonly details?: readonly string[];
}

export interface AgentCatalog {
  /** Merged, deduplicated (project overrides bundled by name), sorted by name. */
  readonly agents: readonly LoadedAgent[];
  readonly errors: readonly AgentCatalogError[];
}

export interface LoadAgentCatalogOptions {
  /**
   * Directory holding bundled agent `.md` files directly (i.e. the
   * equivalent of `<defaultBundledRoot()>/agents`), injectable so a test can
   * point at a fixture tree instead of the real shipped catalogue.
   */
  readonly bundledRoot?: string;
}

function agentDefinitionFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

type LoadOneResult = { readonly agent: LoadedAgent; readonly error?: undefined } | { readonly agent?: undefined; readonly error: AgentCatalogError };

function loadOne(filePath: string, kind: AgentSourceKind): LoadOneResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { error: { reason: "unreadable-file", path: filePath, message: `could not read ${filePath}: ${detail}` } };
  }

  const parsed = parseAgentFrontmatter(raw);
  if (!parsed.ok) {
    return {
      error: {
        reason: "invalid-frontmatter",
        path: filePath,
        message: `${filePath}: ${parsed.error.message}`,
      },
    };
  }

  const validation = validateAgentFrontmatter(parsed.result.data);
  if (!validation.ok) {
    return {
      error: {
        reason: "invalid-schema",
        path: filePath,
        message: `${filePath} failed agent-definition schema validation`,
        details: validation.errors.map((error) => `${error.field}: ${error.reason} — ${error.message}`),
      },
    };
  }

  const definition = buildAgentDefinition(parsed.result.data, parsed.result.body);
  const stem = path.basename(filePath, ".md");
  if (stem !== definition.name) {
    return {
      error: {
        reason: "name-stem-mismatch",
        path: filePath,
        message: `${filePath}: file stem "${stem}" does not match declared name "${definition.name}"`,
      },
    };
  }

  return { agent: { definition, source: { kind, path: filePath }, raw } };
}

/**
 * Load one source directory's agent definitions. A duplicate `name` WITHIN
 * this one source is an error (two different files claiming the same
 * identity); a name that also exists in the OTHER source is not checked
 * here — that is the intended override, resolved by the caller writing
 * project entries into `byName` after bundled ones.
 */
function loadSource(dir: string, kind: AgentSourceKind, byName: Map<string, LoadedAgent>, errors: AgentCatalogError[]): void {
  const seenInThisSource = new Set<string>();
  for (const file of agentDefinitionFiles(dir)) {
    const loaded = loadOne(file, kind);
    if (loaded.error !== undefined) {
      errors.push(loaded.error);
      continue;
    }
    const name = loaded.agent.definition.name;
    if (seenInThisSource.has(name)) {
      errors.push({
        reason: "duplicate-name",
        path: file,
        message: `duplicate agent name "${name}" within the ${kind} source`,
      });
      continue;
    }
    seenInThisSource.add(name);
    byName.set(name, loaded.agent);
  }
}

/**
 * Load the agent-definition catalog: bundled definitions from
 * `<bundledRoot>` (default: `<defaultBundledRoot()>/agents`, resolved the
 * same way `defaultBundledRoot()` resolves the shipped skills tree — direct
 * source layout first, installed-package layout second), then project
 * definitions from `<projectRoot>/.metaproject/agents`, with a project
 * definition overriding a bundled one of the same name. Never throws.
 */
export function loadAgentCatalog(projectRoot: string, options: LoadAgentCatalogOptions = {}): AgentCatalog {
  const bundledRoot = options.bundledRoot ?? path.join(defaultBundledRoot(), "agents");
  const projectDir = path.join(projectRoot, ".metaproject", "agents");

  const byName = new Map<string, LoadedAgent>();
  const errors: AgentCatalogError[] = [];

  loadSource(bundledRoot, "bundled", byName, errors);
  loadSource(projectDir, "project", byName, errors);

  const agents = [...byName.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  return { agents, errors };
}
