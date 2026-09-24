// Flow 309 (W1), T6: `planInstall` — resolve a profile + `--with`/`--without`
// + stack detection into a deterministic install plan (profiles → modules →
// components, docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md
// "Install: profiles → modules → components").
//
// Determinism (W1-AC6): no `Date.now`/randomness in this module; every
// collection is deduped and sorted before it reaches the output, and every
// path in a plan is repo-relative. Two calls with the same `manifest`,
// `profileId`, `with`/`without`, `target`, and `stack` input produce
// byte-identical JSON.
//
// `defaultInstall` semantics (decided in flow 309 W1 T14, fixing a defect
// where a per-stack profile installed zero pack files): `defaultInstall`
// governs whether a module that reaches the candidate set *only* through an
// owning component installs without the operator asking for it by name.
// - A module a profile lists directly under `profile.modules` always
//   installs (`unconditionalModuleIds`, below) — `defaultInstall` is not
//   consulted for those at all.
// - A module reached through `component.modules` installs when
//   `defaultInstall: true`, OR when it (or its owning component) was named
//   explicitly via `--with`, OR when something already selected depends on
//   it. `defaultInstall: false` on a component-sourced module means
//   "catalog-listed but never installed implicitly" — reserved for
//   placeholder/scaffold modules that resolve to zero files or are not yet
//   ready for a default install; it is NOT how a real, shippable stack
//   pack's modules should be marked, because every per-stack profile
//   (`python`, `react`, `nestjs`, ...) reaches its pack's modules only
//   through a component, and W1-AC6 requires the profile's plan to include
//   every module the profile's resolved component set requires. Concretely:
//   `python-rules`/`python-skills` (real pack content, reachable via
//   `lang:python`) are `defaultInstall: true`, matching every other stack
//   component's modules (`react-review-skills`, `nestjs-review-skill`,
//   etc.); only a genuine placeholder module (none remain as of this flow)
//   should ever ship `defaultInstall: false`.

import { createHash } from "node:crypto";
import path from "node:path";
import { sha256OfFile } from "../../integrations/install-state";
import { generateCapabilityMatrix, type CapabilityMatrixDocument, type MatrixSurfaceState } from "../../integrations/matrix";
import { resolveGlobs } from "./glob";
import type { HarnessId, InstallManifest, ManifestModule, ModuleKind } from "./manifest";

export interface StackDetectionInput {
  tags: Record<string, boolean>;
  uncertain: boolean;
  [extra: string]: unknown;
}

export interface PlanFileEntry {
  source: string;
  destination: string;
  sha256: string;
}

export interface PlanModuleEntry {
  id: string;
  kind: ModuleKind;
  cost: ManifestModule["cost"];
  stability: ManifestModule["stability"];
  files: PlanFileEntry[];
}

export interface PlanComponentEntry {
  id: string;
  included: boolean;
  reason: string;
}

export interface PlanStackInput {
  source: "provided" | "none";
  uncertain: boolean;
  inputsSha256?: string;
}

export interface InstallPlan {
  schemaVersion: "1.0.0";
  profile: string;
  target: HarnessId;
  stackInput: PlanStackInput;
  components: PlanComponentEntry[];
  modules: PlanModuleEntry[];
  errors: string[];
  ok: boolean;
}

export interface PlanInstallInput {
  manifest: InstallManifest;
  profileId: string;
  with?: string[] | undefined;
  without?: string[] | undefined;
  target?: HarnessId | undefined;
  stack?: StackDetectionInput | undefined;
  includeDeprecated?: boolean | undefined;
  /**
   * Root that `module.paths` (repo-relative bundled source paths) resolve
   * against — the keryx PACKAGE root (`defaultBundledSourceRoot()` in
   * `./manifest`), never the target project's `process.cwd()`. Destinations
   * in the resulting plan are project-relative strings with no root baked
   * in; `applyInstall`'s separate `destRoot` (default: same value) is what
   * resolves those against the actual target project.
   */
  repoRoot: string;
  matrix?: CapabilityMatrixDocument | undefined;
}

const DEFAULT_TARGET: HarnessId = "claude";

/** Deterministic sha256 of a stack-detection document, `detectedAt` excluded (Lane A's fingerprint convention). */
function stackInputsSha256(stack: StackDetectionInput): string {
  const { detectedAt: _detectedAt, ...rest } = stack as Record<string, unknown> & { detectedAt?: unknown };
  return createHash("sha256").update(stableStringify(rest)).digest("hex");
}

/** JSON.stringify with sorted object keys, so the fingerprint never depends on property insertion order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function matrixStateFor(matrix: CapabilityMatrixDocument, harnessId: string): MatrixSurfaceState | undefined {
  return matrix.harnesses.find((h) => h.id === harnessId)?.state;
}

/** Resolve a component's inclusion decision under stack detection (fail open throughout). */
function resolveComponentInclusion(
  componentId: string,
  markers: readonly string[],
  stack: StackDetectionInput | undefined,
): { included: boolean; reason: string } {
  if (stack === undefined) {
    return { included: true, reason: "no stack detection input supplied — fail open, included by default" };
  }
  if (stack.uncertain) {
    return { included: true, reason: "stack detection reported uncertain — fail open, included by default" };
  }
  if (markers.length === 0) {
    return { included: true, reason: "component declares no detectionMarkers — included by default" };
  }
  const missing = markers.filter((marker) => !(marker in stack.tags));
  if (missing.length > 0) {
    return {
      included: true,
      reason: `detection tag(s) [${missing.join(", ")}] missing from stack.json — fail open, included by default`,
    };
  }
  const matchedMarker = markers.find((marker) => stack.tags[marker] === true);
  if (matchedMarker !== undefined) {
    return { included: true, reason: `detected via tag "${matchedMarker}"` };
  }
  return {
    included: false,
    reason: `stack detection ran; none of [${markers.join(", ")}] were present (uncertain: false)`,
  };
}

interface SkillDestination {
  category: string;
  name: string;
  rest: string;
}

/** Extract `{category, name, rest}` from a bundled-skill or stack-pack-skill source path, or `undefined` if unrecognised. */
function parseSkillSource(source: string): SkillDestination | undefined {
  const bundled = /^src\/gdskills\/bundled\/skills\/([^/]+)\/([^/]+)\/(.*)$/.exec(source);
  if (bundled) {
    return { category: bundled[1]!, name: bundled[2]!, rest: bundled[3]! };
  }
  const stackPack = /^src\/gdskills\/bundled\/stacks\/([^/]+)\/skills\/([^/]+)\/(.*)$/.exec(source);
  if (stackPack) {
    return { category: stackPack[1]!, name: stackPack[2]!, rest: stackPack[3]! };
  }
  return undefined;
}

/** Extract `{pack, file}` from a stack-pack rule source path, or `undefined` if unrecognised. */
function parseStackRuleSource(source: string): { pack: string; file: string } | undefined {
  const match = /^src\/gdskills\/bundled\/stacks\/([^/]+)\/rules\/([^/]+)$/.exec(source);
  return match ? { pack: match[1]!, file: match[2]! } : undefined;
}

/**
 * Destination table, v1 (docs/requirements/.../workstreams/W1-stack-catalog.md
 * §"Install: profiles → modules → components"):
 *   claude      skill -> .claude/skills/<name>/<rest>       rule -> .claude/rules/<basename>
 *   keryx-shell skill -> .metaproject/skills/gdskills/<category>/<name>/<rest>
 *               rule -> .metaproject/rules/core/<basename>
 * A stack-pack rule (source under `stacks/<pack>/rules/`) is namespaced by
 * pack id instead of landing at the bare `core` rule destination, so two
 * packs shipping a same-named file (e.g. both ship `coding-style.mdc`) never
 * collide:
 *   claude      rule -> .claude/rules/<pack>-<basename>
 *   keryx-shell rule -> .metaproject/rules/stacks/<pack>/<basename>
 * Any other target, or a module kind with no entry here (agent-ref,
 * hook-runtime, schema, doc), has no destination in v1.
 */
function destinationFor(target: HarnessId, kind: ModuleKind, source: string): string | { error: string } {
  if (kind === "rule") {
    const stackRule = parseStackRuleSource(source);
    if (stackRule !== undefined) {
      if (target === "claude") return `.claude/rules/${stackRule.pack}-${stackRule.file}`;
      if (target === "keryx-shell") return `.metaproject/rules/stacks/${stackRule.pack}/${stackRule.file}`;
      return { error: `target "${target}" has no rule destination in the v1 destination table` };
    }
    const basename = path.posix.basename(source);
    if (target === "claude") return `.claude/rules/${basename}`;
    if (target === "keryx-shell") return `.metaproject/rules/core/${basename}`;
    return { error: `target "${target}" has no rule destination in the v1 destination table` };
  }
  if (kind === "skill") {
    const parsed = parseSkillSource(source);
    if (parsed === undefined) {
      return { error: `cannot resolve a skill destination for source "${source}" (unrecognised bundled-skill layout)` };
    }
    if (target === "claude") {
      return parsed.rest.length > 0 ? `.claude/skills/${parsed.name}/${parsed.rest}` : `.claude/skills/${parsed.name}`;
    }
    if (target === "keryx-shell") {
      return parsed.rest.length > 0
        ? `.metaproject/skills/gdskills/${parsed.category}/${parsed.name}/${parsed.rest}`
        : `.metaproject/skills/gdskills/${parsed.category}/${parsed.name}`;
    }
    return { error: `target "${target}" has no skill destination in the v1 destination table` };
  }
  return { error: `module kind "${kind}" has no install destination in the v1 destination table` };
}

/** Collect a module's own dependency closure, detecting cycles. Returns the set including `startId` itself. */
function dependencyClosure(
  startIds: readonly string[],
  modules: Record<string, ManifestModule>,
  errors: string[],
): Set<string> {
  const result = new Set<string>();
  const visiting = new Set<string>();

  const visit = (id: string): void => {
    if (result.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`dependency cycle detected involving module "${id}"`);
      return;
    }
    const module = modules[id];
    if (module === undefined) {
      errors.push(`unknown module id "${id}" referenced by a profile or component`);
      return;
    }
    visiting.add(id);
    for (const dep of module.dependencies ?? []) {
      visit(dep);
    }
    visiting.delete(id);
    result.add(id);
  };

  for (const id of startIds) visit(id);
  return result;
}

export async function planInstall(input: PlanInstallInput): Promise<InstallPlan> {
  const { manifest, repoRoot } = input;
  const target = input.target ?? DEFAULT_TARGET;
  const withList = input.with ?? [];
  const withoutList = input.without ?? [];
  const matrix = input.matrix ?? generateCapabilityMatrix();
  const errors: string[] = [];

  const profile = manifest.profiles[input.profileId];
  const stackInput: PlanStackInput =
    input.stack === undefined
      ? { source: "none", uncertain: true }
      : { source: "provided", uncertain: input.stack.uncertain, inputsSha256: stackInputsSha256(input.stack) };

  if (profile === undefined) {
    return {
      schemaVersion: "1.0.0",
      profile: input.profileId,
      target,
      stackInput,
      components: [],
      modules: [],
      errors: [`unknown profile "${input.profileId}"`],
      ok: false,
    };
  }

  // --- components ----------------------------------------------------------
  const declaredComponents = new Set(profile.components ?? []);
  for (const id of withList) {
    if (manifest.components[id] !== undefined) declaredComponents.add(id);
  }

  const componentEntries: PlanComponentEntry[] = [];
  const includedComponentModuleIds = new Set<string>();
  const forcedModuleIds = new Set<string>(withList.filter((id) => manifest.modules[id] !== undefined));

  for (const componentId of [...declaredComponents].sort()) {
    const component = manifest.components[componentId];
    if (component === undefined) {
      errors.push(`unknown component id "${componentId}" referenced by profile "${input.profileId}"`);
      continue;
    }
    if (withoutList.includes(componentId)) {
      componentEntries.push({ id: componentId, included: false, reason: "explicitly excluded via --without" });
      continue;
    }
    let decision: { included: boolean; reason: string };
    if (withList.includes(componentId)) {
      decision = { included: true, reason: "explicitly requested via --with" };
    } else if (profile.stackDetectionAware === true) {
      decision = resolveComponentInclusion(componentId, component.detectionMarkers ?? [], input.stack);
    } else {
      decision = { included: true, reason: "component listed unconditionally by profile" };
    }
    componentEntries.push({ id: componentId, included: decision.included, reason: decision.reason });
    if (decision.included) {
      for (const moduleId of component.modules) {
        includedComponentModuleIds.add(moduleId);
        if (withList.includes(componentId)) forcedModuleIds.add(moduleId);
      }
    }
  }

  // --- modules ---------------------------------------------------------------
  // Profile-listed modules install unconditionally (schema: "installed
  // unconditionally by this profile"); component-sourced modules are gated by
  // `defaultInstall` unless force-included (explicit --with of the module id
  // or of the owning component, or pulled in as a dependency).
  const unconditionalModuleIds = new Set(profile.modules);
  const candidateModuleIds = new Set<string>([...unconditionalModuleIds, ...includedComponentModuleIds]);

  const closure = dependencyClosure([...candidateModuleIds], manifest.modules, errors);
  // Dependencies must always be present once something that needs them is
  // included, regardless of defaultInstall.
  for (const id of closure) {
    if (!candidateModuleIds.has(id)) forcedModuleIds.add(id);
  }

  let selectedModuleIds = [...closure].filter((id) => {
    const module = manifest.modules[id];
    if (module === undefined) return false; // already reported by dependencyClosure
    if (unconditionalModuleIds.has(id)) return true;
    if (forcedModuleIds.has(id)) return true;
    return module.defaultInstall === true;
  });

  // --without at module granularity, plus stripping modules whose owning
  // component was excluded and that are not required unconditionally/by another
  // included module's dependency chain.
  selectedModuleIds = selectedModuleIds.filter((id) => !withoutList.includes(id));

  if (input.profileId === "full") {
    selectedModuleIds = selectedModuleIds.filter((id) => {
      const module = manifest.modules[id];
      return module !== undefined && (module.stability !== "deprecated" || input.includeDeprecated === true);
    });
  }

  selectedModuleIds = [...new Set(selectedModuleIds)].sort();

  const modules: PlanModuleEntry[] = [];
  for (const moduleId of selectedModuleIds) {
    const module = manifest.modules[moduleId];
    if (module === undefined) continue; // reported already

    if (!module.targets.includes(target)) {
      // This module is not written for the requested target — nothing to
      // install for it here, and not an error: `targets` names what a module
      // is FOR, not every harness that must accept it.
      continue;
    }

    if (module.kind === "hook-runtime") {
      const state = matrixStateFor(matrix, target);
      if (state !== "native" && state !== "adapter") {
        errors.push(
          `module "${moduleId}" (hook-runtime) targets harness "${target}", whose capability-matrix state is ` +
            `"${state ?? "unknown"}", not native or adapter (W1-AC5)`,
        );
        continue;
      }
      errors.push(`module "${moduleId}" (hook-runtime) has no install destination in the v1 destination table`);
      continue;
    }

    if (module.kind !== "rule" && module.kind !== "skill") {
      errors.push(`module "${moduleId}" (kind "${module.kind}") has no install destination in the v1 destination table`);
      continue;
    }

    const sources = await resolveGlobs(repoRoot, module.paths);
    if (sources.length === 0) {
      errors.push(
        `module "${moduleId}" paths [${module.paths.join(", ")}] resolve to zero files under "${repoRoot}" — nothing to install`,
      );
      continue;
    }

    const files: PlanFileEntry[] = [];
    let destinationError: string | undefined;
    for (const source of sources) {
      const destination = destinationFor(target, module.kind, source);
      if (typeof destination !== "string") {
        destinationError = `module "${moduleId}": ${destination.error}`;
        break;
      }
      const sha256 = (await sha256OfFile(repoRoot, source)) ?? "";
      files.push({ source, destination, sha256 });
    }
    if (destinationError !== undefined) {
      errors.push(destinationError);
      continue;
    }

    files.sort((a, b) => a.destination.localeCompare(b.destination));
    modules.push({ id: moduleId, kind: module.kind, cost: module.cost, stability: module.stability, files });
  }

  modules.sort((a, b) => a.id.localeCompare(b.id));

  // Collision check: two sources (possibly from different modules) mapping
  // to the same destination is always a planning error — one of them would
  // silently overwrite the other at apply time.
  const destinationOwners = new Map<string, { moduleId: string; source: string }>();
  for (const module of modules) {
    for (const file of module.files) {
      const existing = destinationOwners.get(file.destination);
      if (existing !== undefined) {
        errors.push(
          `destination collision at "${file.destination}": module "${existing.moduleId}" source "${existing.source}" ` +
            `and module "${module.id}" source "${file.source}" both write it`,
        );
        continue;
      }
      destinationOwners.set(file.destination, { moduleId: module.id, source: file.source });
    }
  }

  return {
    schemaVersion: "1.0.0",
    profile: input.profileId,
    target,
    stackInput,
    components: componentEntries,
    modules,
    errors,
    ok: errors.length === 0,
  };
}
