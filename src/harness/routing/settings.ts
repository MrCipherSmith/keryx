// The routing settings store: reads the user and project layers every routing
// consumer resolves against, and writes them. Model routing is always on —
// there is no activation step and no engine switch; an unconfigured project
// resolves every category from the built-in baseline.
//
//   user     `auth.json` key `modelRouting` — the operator's own config, no trust gate;
//   project  `routing.config.json` key `modelRouting` — committed with the
//            repository, so it applies only once the operator approved its
//            current content (`trust.ts`); unapproved, it is ignored with a notice.
//
// A scope with no canonical layer falls back to whatever an earlier release
// stored there, converted in memory by `legacy-migration.ts`; the first write
// to that scope persists the converted layer plus the change. Malformed
// settings in either place throw: a consumer surfaces the error rather than
// silently routing on the baseline.
import {
  normalizeRoutingConfig,
  ROUTING_CONFIG_KEY,
  ROUTING_SCHEMA_VERSION,
  routingDigest,
  validateRoutingConfigLayer,
  type NormalizedRoutingConfig,
  type RoutingAssignment,
  type RoutingConfigLayer,
  type RoutingConfigLayers,
  type RoutingNormalizationOptions,
} from "./config";
import { ROUTING_CLASSIFIER_ADAPTER_REGISTRY } from "./classifier-production";
import {
  projectRoutingFile,
  readRoutingFileRoot,
  updateProjectRoutingKey,
  updateUserRoutingKey,
  userRoutingFile,
  type JsonObject,
} from "./config-file";
import {
  activationApprovesProjectLayer,
  PROJECT_SCOPED_USER_NOTICE,
  readLegacyRoutingLayer,
  type LegacyRoutingLayer,
  type LegacyRoutingUnresolved,
  type RoutingLocation,
  type RoutingScope,
} from "./legacy-migration";
import type { RoutingCategory } from "./table";
import {
  approveProjectRouting as recordProjectApproval,
  describeLayerForApproval,
  isEmptyRoutingLayer,
  isProjectRoutingApproved,
  ROUTING_TRUST_NOTICE,
  type RoutingTrustResult,
} from "./trust";

export type { RoutingLocation, RoutingScope } from "./legacy-migration";

/** Where a scope's settings came from. */
export type RoutingLayerSource = "canonical" | "opt-in" | "legacy-table" | "none";

export interface RoutingScopeState {
  readonly source: RoutingLayerSource;
  /** The stored layer as written (or converted), before the project trust gate. */
  readonly layer?: RoutingConfigLayer;
}

export interface ProjectRoutingState extends RoutingScopeState {
  /** Whether `layer` takes effect. An absent or empty layer needs no approval. */
  readonly trusted: boolean;
}

export interface RoutingSettings {
  /** The layers that take effect: the project layer only when trusted. */
  readonly layers: RoutingConfigLayers;
  readonly user: RoutingScopeState;
  readonly project: ProjectRoutingState;
  /** Operator-facing lines every caller surfaces (unapproved project settings, ignored older settings). */
  readonly notices: readonly string[];
  /** Digest of both stored layers and the project trust state, for expected-revision writes. */
  readonly revision: string;
}

/** The registry every production read validates classifier chains against. */
export const ROUTING_NORMALIZATION: RoutingNormalizationOptions = { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY };

function validLayer(raw: unknown, label: string, normalization: RoutingNormalizationOptions): RoutingConfigLayer {
  const result = validateRoutingConfigLayer(raw, normalization);
  if (!result.ok) throw new Error(`invalid ${label}: ${result.errors.join("; ")}`);
  return raw as RoutingConfigLayer;
}

function unresolvedError(unresolved: readonly LegacyRoutingUnresolved[]): Error {
  return new Error(unresolved.map((entry) => entry.message).join("; "));
}

interface ScopeRead {
  readonly source: RoutingLayerSource;
  readonly layer?: RoutingConfigLayer;
  readonly legacy?: LegacyRoutingLayer;
}

function readScope(
  scope: RoutingScope,
  location: RoutingLocation,
  root: JsonObject,
  label: string,
  normalization: RoutingNormalizationOptions,
): ScopeRead {
  const canonical = root[ROUTING_CONFIG_KEY];
  if (canonical !== undefined) return { source: "canonical", layer: validLayer(canonical, `${label} ${ROUTING_CONFIG_KEY}`, normalization) };
  const legacy = readLegacyRoutingLayer(scope, location, root, normalization);
  if (legacy === undefined) return { source: "none" };
  return { source: legacy.source, layer: legacy.layer, legacy };
}

/** Read both scopes, apply the project trust gate, and validate the merged result. */
export function readRoutingSettings(
  location: RoutingLocation,
  normalization: RoutingNormalizationOptions = ROUTING_NORMALIZATION,
): RoutingSettings {
  const userFile = userRoutingFile(location.configDir);
  const projectFile = projectRoutingFile(location.cwd);
  const user = readScope("user", location, readRoutingFileRoot(userFile).value, userFile, normalization);
  const project = readScope("project", location, readRoutingFileRoot(projectFile).value, projectFile, normalization);
  const notices = [...(user.legacy?.notices ?? []), ...(project.legacy?.notices ?? [])];
  const unresolved = [...(user.legacy?.unresolved ?? []), ...(project.legacy?.unresolved ?? [])];
  if (unresolved.length > 0) throw unresolvedError(unresolved);

  let trusted = true;
  if (project.layer !== undefined && !isEmptyRoutingLayer(project.layer)) {
    trusted = isProjectRoutingApproved(location.cwd, project.layer, location.configDir)
      || (project.legacy !== undefined ? project.legacy.approved : activationApprovesProjectLayer(location, project.layer));
  }
  if (!trusted) notices.push(ROUTING_TRUST_NOTICE);

  const layers: RoutingConfigLayers = {
    ...(user.layer === undefined ? {} : { user: user.layer }),
    ...(project.layer === undefined || !trusted ? {} : { project: project.layer }),
  };
  normalizeRoutingConfig(layers, normalization);
  return {
    layers,
    user: { source: user.source, ...(user.layer === undefined ? {} : { layer: user.layer }) },
    project: { source: project.source, trusted, ...(project.layer === undefined ? {} : { layer: project.layer }) },
    notices,
    revision: routingDigest({ user: user.layer ?? null, project: project.layer ?? null, trusted }),
  };
}

/** The routing config every consumer resolves against. Always defined; throws on malformed settings. */
export function loadRouting(cwd: string, configDir?: string): NormalizedRoutingConfig {
  const settings = readRoutingSettings({ cwd, ...(configDir === undefined ? {} : { configDir }) });
  return normalizeRoutingConfig(settings.layers, ROUTING_NORMALIZATION);
}

/**
 * The layer a write to `scope` starts from, read from the fresh file root:
 * the canonical layer, else the converted older settings, else an empty
 * layer. Older entries that cannot be converted block the write unless the
 * write itself replaces them (`replaces`).
 */
function writeBase(
  scope: RoutingScope,
  location: RoutingLocation,
  root: JsonObject,
  label: string,
  replaces: ReadonlySet<RoutingCategory> | "all",
): RoutingConfigLayer {
  const read = readScope(scope, location, root, label, ROUTING_NORMALIZATION);
  // A category write would persist the base layer globally; settings an earlier
  // release activated for this project only must not ride along silently.
  if (read.source === "opt-in" && replaces !== "all") throw new Error(PROJECT_SCOPED_USER_NOTICE);
  const pending = (read.legacy?.unresolved ?? []).filter((entry) => replaces !== "all" && !replaces.has(entry.category));
  if (pending.length > 0) throw unresolvedError(pending);
  return read.layer ?? { schemaVersion: ROUTING_SCHEMA_VERSION };
}

async function writeScope(
  scope: RoutingScope,
  location: RoutingLocation,
  replaces: ReadonlySet<RoutingCategory> | "all",
  change: (base: RoutingConfigLayer) => RoutingConfigLayer | undefined,
): Promise<"written" | "unchanged"> {
  const apply = (label: string) => (root: JsonObject): RoutingConfigLayer | undefined => {
    const next = change(writeBase(scope, location, root, label, replaces));
    if (next === undefined) return undefined;
    return validLayer(next, `${scope} routing settings`, ROUTING_NORMALIZATION);
  };
  if (scope === "user") return updateUserRoutingKey(location.configDir, ROUTING_CONFIG_KEY, apply(userRoutingFile(location.configDir)));
  return updateProjectRoutingKey(location.cwd, ROUTING_CONFIG_KEY, apply(projectRoutingFile(location.cwd)));
}

/** Assign one category in a scope, keeping every other setting of that scope. */
export async function setRoutingCategory(
  scope: RoutingScope,
  location: RoutingLocation,
  category: RoutingCategory,
  assignment: RoutingAssignment,
): Promise<void> {
  await writeScope(scope, location, new Set([category]), (base) => ({
    ...base,
    categories: { ...(base.categories ?? {}), [category]: assignment },
  }));
}

/** Clear one category in a scope; it falls through to the next layer, then the baseline. */
export async function unsetRoutingCategory(scope: RoutingScope, location: RoutingLocation, category: RoutingCategory): Promise<void> {
  await writeScope(scope, location, new Set([category]), (base) => {
    const { [category]: _removed, ...categories } = base.categories ?? {};
    return { ...base, categories };
  });
}

/** Replace a whole scope's layer unconditionally (the scope's older settings are superseded). */
export async function replaceRoutingLayer(scope: RoutingScope, location: RoutingLocation, layer: RoutingConfigLayer): Promise<void> {
  await writeScope(scope, location, "all", () => layer);
}

export interface UpdateRoutingLayerInput extends RoutingLocation {
  readonly scope: RoutingScope;
  readonly expectedRevision: string;
  readonly next: RoutingConfigLayer;
}

/** Replace a whole scope's layer, refused when the settings changed since `expectedRevision` was read. */
export async function updateRoutingLayer(input: UpdateRoutingLayerInput): Promise<{ readonly status: "updated" | "unchanged"; readonly revision: string }> {
  const location: RoutingLocation = { cwd: input.cwd, ...(input.configDir === undefined ? {} : { configDir: input.configDir }) };
  validLayer(input.next, `${input.scope} routing settings`, ROUTING_NORMALIZATION);
  const current = readRoutingSettings(location);
  if (current.revision !== input.expectedRevision) throw new Error("routing settings revision conflict; read the settings again before writing");
  const before = current[input.scope].layer;
  if (before !== undefined && routingDigest(before) === routingDigest(input.next) && current[input.scope].source === "canonical") {
    return { status: "unchanged", revision: current.revision };
  }
  await writeScope(input.scope, location, "all", (base) => {
    if (routingDigest(base) !== routingDigest(before ?? { schemaVersion: ROUTING_SCHEMA_VERSION })) {
      throw new Error("routing settings revision conflict; read the settings again before writing");
    }
    return input.next;
  });
  const after = readRoutingSettings(location);
  return { status: "updated", revision: after.revision };
}

/**
 * Approve the project's stored routing layer exactly as it validates now.
 * Returns the lines that describe it so callers can show what was approved.
 */
export function approveProjectRouting(location: RoutingLocation): RoutingTrustResult & { readonly approved: readonly string[] } {
  const settings = readRoutingSettings(location);
  const layer = settings.project.layer;
  if (layer === undefined || isEmptyRoutingLayer(layer)) return { ok: true, file: projectRoutingFile(location.cwd), approved: [] };
  const result = recordProjectApproval(location.cwd, layer, location.configDir);
  return { ...result, approved: describeLayerForApproval(layer) };
}
