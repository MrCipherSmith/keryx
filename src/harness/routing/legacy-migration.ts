// The one place older routing settings are read. Earlier releases persisted
// three shapes the primary routing engine no longer writes:
//
//   1. the legacy category table: a BARE category map under `auth.json.routing`
//      (user) and `routing.config.json.categories` (project), with project
//      approval recorded as a table fingerprint in `routing-config-trust.json`;
//   2. opt-in engine settings: `auth.json.routingV2` (user) and
//      `routing.config.json.modelRouting` (project — the same key the canonical
//      project layer uses), which applied only behind
//   3. an activation marker under `<configDir>/routing-v2/activations/`, bound
//      by digest to the exact fragments it activated, with edit and rollback
//      journals beside it while a change was in flight.
//
// Reading converts in memory and never writes. `migrateLegacyRouting` writes
// the canonical `modelRouting` key once per scope and never replaces one that
// already exists. Conversion is conservative: an entry it cannot convert
// exactly is reported as unresolved and fails the read, never guessed into a
// baseline; trust carries over only for the exact content the operator
// approved; an interrupted activation edit or rollback refuses migration until
// it is recovered.
import { createHash } from "node:crypto";
import { copyFileSync, constants as fsConstants, lstatSync } from "node:fs";
import path from "node:path";
import { keryxConfigDir, readConfigFile } from "../../lib/config-dir";
import { isNotFound } from "../../lib/fs";
import {
  ROUTING_CONFIG_KEY,
  ROUTING_SCHEMA_VERSION,
  routingDigest,
  validateRoutingConfigLayer,
  type RoutingAssignment,
  type RoutingConfigLayer,
  type RoutingNormalizationOptions,
} from "./config";
import {
  isJsonObject,
  projectRoutingFile,
  readRoutingFileRoot,
  updateProjectRoutingKey,
  updateUserRoutingKey,
  userRoutingFile,
  type JsonObject,
} from "./config-file";
import { legacyRoutingTableFingerprint, validateLegacyRoutingTable } from "./legacy-table-config";
import { resolveProviderDefaultModelId } from "./provider-default";
import { ROUTING_CATEGORIES, type RoutingCategory, type RoutingTable } from "./table";
import { approveProjectRouting, isProjectRoutingApproved, loadRoutingTrustStore, routingTrustKey } from "./trust";

/** `auth.json` key of the opt-in user settings. */
const LEGACY_USER_OPT_IN_KEY = "routingV2";
/** `auth.json` key of the legacy user category table (a bare category map). */
const LEGACY_USER_TABLE_KEY = "routing";
/** `routing.config.json` key of the legacy project category table. */
const LEGACY_PROJECT_TABLE_KEY = "categories";
/** Directory, under the config dir, the activation markers were kept in. */
const LEGACY_ACTIVATION_DIR = "routing-v2";

export type RoutingScope = "project" | "user";

export interface RoutingLocation {
  readonly cwd: string;
  readonly configDir?: string;
}

export interface LegacyRoutingUnresolved {
  readonly category: RoutingCategory;
  readonly message: string;
}

export interface LegacyRoutingLayer {
  readonly source: "opt-in" | "legacy-table";
  readonly layer: RoutingConfigLayer;
  /** Project scope only: the operator approved exactly this content in an earlier release. */
  readonly approved: boolean;
  /** Entries that cannot be converted exactly. A read with any of these fails. */
  readonly unresolved: readonly LegacyRoutingUnresolved[];
  readonly notices: readonly string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function activationFile(location: RoutingLocation): string {
  const projectRoot = path.resolve(location.cwd);
  return path.join(path.resolve(keryxConfigDir(location.configDir)), LEGACY_ACTIVATION_DIR, "activations", `${sha256(projectRoot)}.json`);
}

function ownerOnlyRegularFile(file: string, label: string): boolean {
  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`legacy routing ${label} ${file} must be a regular non-symlink file`);
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error(`legacy routing ${label} ${file} permissions are not owner-only`);
  return true;
}

function pathPresent(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

interface ActivationFragments {
  readonly project: string;
  readonly user: string;
}

/**
 * The fragment digests an activation marker binds, `undefined` when no marker
 * exists or it records an explicit return to the legacy table. A marker that
 * is malformed, bound to another project or config dir, or has an edit or
 * rollback journal beside it throws: those states were fail-closed before and
 * stay so — migration does not read past an interrupted change.
 */
function activeFragments(location: RoutingLocation): ActivationFragments | undefined {
  const file = activationFile(location);
  if (!ownerOnlyRegularFile(file, "activation marker")) return undefined;
  for (const journal of [`${file}.edit.json`, `${file}.rollback.json`]) {
    if (pathPresent(journal)) {
      throw new Error(`an interrupted routing activation change is pending (${journal}); recover or discard it with the keryx release that started it before migrating`);
    }
  }
  const read = readConfigFile(file);
  if (!read.ok) throw new Error(`legacy routing activation marker ${file} cannot be read (${read.reason})`);
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    throw new Error(`legacy routing activation marker ${file} is malformed JSON`);
  }
  if (!isJsonObject(raw) || raw.schemaVersion !== 2 || (raw.engineVersion !== 1 && raw.engineVersion !== 2)) {
    throw new Error(`legacy routing activation marker ${file} is malformed`);
  }
  if (raw.projectRoot !== path.resolve(location.cwd) || raw.configRoot !== path.resolve(keryxConfigDir(location.configDir))) {
    throw new Error(`legacy routing activation marker ${file} is bound to another project or config directory`);
  }
  if (raw.engineVersion === 1) return undefined;
  const targets = raw.targets;
  const project = isJsonObject(targets) && isJsonObject(targets.project) ? targets.project.fragmentDigest : undefined;
  const user = isJsonObject(targets) && isJsonObject(targets.user) ? targets.user.fragmentDigest : undefined;
  if (typeof project !== "string" || typeof user !== "string") throw new Error(`legacy routing activation marker ${file} has malformed targets`);
  return { project, user };
}

function convertAssignment(category: RoutingCategory, assignment: RoutingTable[RoutingCategory]): RoutingAssignment | LegacyRoutingUnresolved {
  if (assignment === undefined || assignment.kind === "session-default") return { mode: "baseline" };
  if (assignment.kind === "model") return { mode: "model", target: { providerId: assignment.providerId, modelId: assignment.modelId } };
  const modelId = resolveProviderDefaultModelId(assignment.providerId);
  if (modelId === undefined) {
    return {
      category,
      message: `legacy routing assignment ${category} -> ${assignment.providerId} (provider default) has no known default model; `
        + `set it explicitly: keryx routing set ${category} ${assignment.providerId}/<model>`,
    };
  }
  return { mode: "model", target: { providerId: assignment.providerId, modelId } };
}

function convertTable(raw: unknown, label: string): { table: RoutingTable; layer: RoutingConfigLayer; unresolved: LegacyRoutingUnresolved[] } {
  const { table, errors } = validateLegacyRoutingTable(raw);
  if (errors.length > 0) throw new Error(`${label}: ${errors.join("; ")}`);
  const categories: Partial<Record<RoutingCategory, RoutingAssignment>> = {};
  const unresolved: LegacyRoutingUnresolved[] = [];
  for (const category of ROUTING_CATEGORIES) {
    if (table[category] === undefined) continue;
    const converted = convertAssignment(category, table[category]);
    if ("mode" in converted) categories[category] = converted;
    else unresolved.push(converted);
  }
  return { table, layer: { schemaVersion: ROUTING_SCHEMA_VERSION, categories }, unresolved };
}

function validOptIn(raw: unknown, label: string, normalization: RoutingNormalizationOptions): RoutingConfigLayer {
  const result = validateRoutingConfigLayer(raw, normalization);
  if (!result.ok) throw new Error(`invalid ${label}: ${result.errors.join("; ")}`);
  return raw as RoutingConfigLayer;
}

/**
 * The legacy layer that applies to `scope` when the file holds no canonical
 * layer, read from the already-loaded file root. `undefined` when no older
 * setting exists for that scope.
 */
export function readLegacyRoutingLayer(
  scope: RoutingScope,
  location: RoutingLocation,
  root: JsonObject,
  normalization: RoutingNormalizationOptions,
): LegacyRoutingLayer | undefined {
  if (scope === "user") {
    const notices: string[] = [];
    const optIn = root[LEGACY_USER_OPT_IN_KEY];
    if (optIn !== undefined) {
      const fragments = activeFragments(location);
      if (fragments !== undefined) {
        if (routingDigest(optIn) !== fragments.user) {
          throw new Error(`auth.json ${LEGACY_USER_OPT_IN_KEY} changed after it was activated for this project; it no longer matches its activation, routing settings cannot be read`);
        }
        return { source: "opt-in", layer: validOptIn(optIn, `auth.json ${LEGACY_USER_OPT_IN_KEY}`, normalization), approved: true, unresolved: [], notices };
      }
      notices.push(`auth.json ${LEGACY_USER_OPT_IN_KEY} holds routing settings that were never active for this project; they are ignored`);
    }
    const table = root[LEGACY_USER_TABLE_KEY];
    if (table === undefined) return notices.length === 0 ? undefined : { source: "legacy-table", layer: { schemaVersion: ROUTING_SCHEMA_VERSION }, approved: true, unresolved: [], notices };
    const converted = convertTable(table, `${userRoutingFile(location.configDir)} ${LEGACY_USER_TABLE_KEY}`);
    return { source: "legacy-table", layer: converted.layer, approved: true, unresolved: converted.unresolved, notices };
  }
  const table = root[LEGACY_PROJECT_TABLE_KEY];
  if (table === undefined) return undefined;
  const converted = convertTable(table, `${projectRoutingFile(location.cwd)} ${LEGACY_PROJECT_TABLE_KEY}`);
  const approvals = loadRoutingTrustStore(location.configDir);
  const approved = Object.keys(converted.table).length === 0
    || approvals[routingTrustKey(location.cwd)] === legacyRoutingTableFingerprint(converted.table);
  return { source: "legacy-table", layer: converted.layer, approved, unresolved: converted.unresolved, notices: [] };
}

/**
 * Was this exact canonical project layer activated by the operator in an
 * earlier release? The activation marker bound the project fragment by
 * digest, so only byte-for-byte-equivalent content qualifies.
 */
export function activationApprovesProjectLayer(location: RoutingLocation, layer: RoutingConfigLayer): boolean {
  const fragments = activeFragments(location);
  return fragments !== undefined && fragments.project === routingDigest(layer);
}

/**
 * `project-scoped`: the user layer comes from opt-in settings an earlier
 * release activated for THIS project only. Writing them to the global
 * `auth.json` key would apply them to every project, so migration leaves them
 * as they are unless the operator asks for that (`includeActivatedUser`).
 */
export type LegacyMigrationOutcome = "migrated" | "kept" | "none" | "project-scoped";

export interface LegacyMigrationOptions {
  /** Adopt user settings activated for this project only as the operator's global user layer. */
  readonly includeActivatedUser?: boolean;
}

/** Shown wherever project-activated user settings stop a write that would make them global. */
export const PROJECT_SCOPED_USER_NOTICE =
  "this project's user routing comes from settings an earlier release activated for this project only; "
  + "adopt them for every project with `keryx routing migrate --include-activated-user`, or replace them with `keryx routing settings set user`";

export interface LegacyMigrationReport {
  readonly user: LegacyMigrationOutcome;
  readonly project: LegacyMigrationOutcome;
  /** `carried`: an earlier approval of exactly this project content was recorded for the canonical layer. */
  readonly projectTrust: "carried" | "unchanged";
  readonly notices: readonly string[];
}

function assertResolved(legacy: LegacyRoutingLayer): void {
  if (legacy.unresolved.length > 0) throw new Error(legacy.unresolved.map((entry) => entry.message).join("; "));
}

/**
 * Write canonical layers for every scope that has only older settings.
 * Idempotent: a scope that already has a canonical layer is `kept` and its
 * file is not rewritten. Legacy keys stay where they are, so an older keryx
 * on the same machine keeps reading what it wrote.
 */
export async function migrateLegacyRouting(
  location: RoutingLocation,
  normalization: RoutingNormalizationOptions = {},
  options: LegacyMigrationOptions = {},
): Promise<LegacyMigrationReport> {
  const notices: string[] = [];
  let user: LegacyMigrationOutcome = "none";
  updateUserRoutingKey(location.configDir, ROUTING_CONFIG_KEY, (root) => {
    if (root[ROUTING_CONFIG_KEY] !== undefined) {
      user = "kept";
      return undefined;
    }
    const legacy = readLegacyRoutingLayer("user", location, root, normalization);
    if (legacy === undefined || (legacy.layer.categories === undefined && legacy.source === "legacy-table")) {
      user = "none";
      if (legacy !== undefined) notices.push(...legacy.notices);
      return undefined;
    }
    assertResolved(legacy);
    notices.push(...legacy.notices);
    if (legacy.source === "opt-in" && options.includeActivatedUser !== true) {
      user = "project-scoped";
      notices.push(PROJECT_SCOPED_USER_NOTICE);
      return undefined;
    }
    user = "migrated";
    return legacy.layer;
  });

  let project: LegacyMigrationOutcome = "none";
  let projectTrust: "carried" | "unchanged" = "unchanged";
  let carry: RoutingConfigLayer | undefined;
  await updateProjectRoutingKey(location.cwd, ROUTING_CONFIG_KEY, (root) => {
    const existing = root[ROUTING_CONFIG_KEY];
    if (existing !== undefined) {
      project = "kept";
      const layer = validOptIn(existing, `${projectRoutingFile(location.cwd)} ${ROUTING_CONFIG_KEY}`, normalization);
      if (!isProjectRoutingApproved(location.cwd, layer, location.configDir) && activationApprovesProjectLayer(location, layer)) carry = layer;
      return undefined;
    }
    const legacy = readLegacyRoutingLayer("project", location, root, normalization);
    if (legacy === undefined) return undefined;
    assertResolved(legacy);
    project = "migrated";
    if (legacy.approved) carry = legacy.layer;
    return legacy.layer;
  });
  if (carry !== undefined) {
    const approval = approveProjectRouting(location.cwd, carry, location.configDir);
    if (!approval.ok) throw new Error(approval.error);
    projectTrust = "carried";
  }
  return { user, project, projectTrust, notices };
}

/** For `keryx routing migrate --dry-run`: what a migration would do, without writing. */
export function planLegacyRoutingMigration(
  location: RoutingLocation,
  normalization: RoutingNormalizationOptions = {},
  options: LegacyMigrationOptions = {},
): {
  readonly user: { readonly outcome: LegacyMigrationOutcome; readonly layer?: RoutingConfigLayer; readonly source?: string };
  readonly project: { readonly outcome: LegacyMigrationOutcome; readonly layer?: RoutingConfigLayer; readonly source?: string; readonly approved?: boolean };
  readonly unresolved: readonly LegacyRoutingUnresolved[];
  readonly notices: readonly string[];
} {
  const userRoot = readRoutingFileRoot(userRoutingFile(location.configDir)).value;
  const projectRoot = readRoutingFileRoot(projectRoutingFile(location.cwd)).value;
  const userLegacy = userRoot[ROUTING_CONFIG_KEY] === undefined ? readLegacyRoutingLayer("user", location, userRoot, normalization) : undefined;
  const projectLegacy = projectRoot[ROUTING_CONFIG_KEY] === undefined ? readLegacyRoutingLayer("project", location, projectRoot, normalization) : undefined;
  const userMigrates = userLegacy !== undefined && !(userLegacy.source === "legacy-table" && userLegacy.layer.categories === undefined);
  const userScoped = userLegacy?.source === "opt-in" && options.includeActivatedUser !== true;
  return {
    user: userRoot[ROUTING_CONFIG_KEY] !== undefined ? { outcome: "kept" }
      : userMigrates ? { outcome: userScoped ? "project-scoped" : "migrated", layer: userLegacy.layer, source: userLegacy.source } : { outcome: "none" },
    project: projectRoot[ROUTING_CONFIG_KEY] !== undefined ? { outcome: "kept" }
      : projectLegacy !== undefined ? { outcome: "migrated", layer: projectLegacy.layer, source: projectLegacy.source, approved: projectLegacy.approved } : { outcome: "none" },
    unresolved: [...(userLegacy?.unresolved ?? []), ...(projectLegacy?.unresolved ?? [])],
    notices: [...(userLegacy?.notices ?? []), ...(projectLegacy?.notices ?? [])],
  };
}

/**
 * Carry an earlier release's per-project routing journal into the current
 * journal path once, so decision and attempt history (including attempts that
 * were still `started`) stays in one append-only file. Runs only while the
 * current file does not exist yet; the old file is left in place.
 */
export function adoptLegacyRoutingJournal(configDir: string | undefined, filename: string, target: string): void {
  const legacy = path.join(path.resolve(keryxConfigDir(configDir)), LEGACY_ACTIVATION_DIR, "journal", filename);
  if (pathPresent(target) || !ownerOnlyRegularFile(legacy, "journal")) return;
  try {
    copyFileSync(legacy, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    // Another process adopted it first; the current file is authoritative.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
}
