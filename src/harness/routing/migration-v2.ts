import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ensureKeryxSubdir, keryxConfigDir, readConfigFile, type ConfigReadResult } from "../../lib/config-dir";
import { updateConfigFile } from "../../lib/config-update";
import { withFileLock as withConfigFileLock } from "../../lib/file-lock";
import { isNotFound, withFileLock, writeFileAtomic } from "../../lib/fs";
import { shellConfigPath } from "../../lib/shell-config";
import {
  normalizeRoutingV2Config,
  routingV2Digest,
  validateRoutingV2ConfigLayer,
  type RoutingAssignmentV2,
  type RoutingV2ConfigLayer,
  type RoutingV2ConfigLayers,
  type RoutingV2NormalizationOptions,
} from "./config-v2";
import { projectRoutingConfigPath, withProjectRoutingWriteLock } from "./config";
import { ROUTING_CATEGORIES, type RoutingCategory, type RoutingTable } from "./table";

const PROJECT_V2_KEY = "modelRouting";
const USER_V2_KEY = "routingV2";
const MIGRATION_SCHEMA_VERSION = 1 as const;
const MARKER_SCHEMA_VERSION = 2 as const;

type JsonObject = Record<string, unknown>;

export interface RoutingV2MigrationUnresolved {
  readonly code: string;
  readonly message: string;
  readonly category?: RoutingCategory;
}

export interface RoutingV2MigrationDiff {
  readonly layer: "project" | "user";
  readonly path: "/modelRouting" | "/routingV2";
  readonly before: RoutingV2ConfigLayer | null;
  readonly after: RoutingV2ConfigLayer | null;
}

export interface RoutingV2MigrationTarget {
  readonly file: string;
  readonly key: typeof PROJECT_V2_KEY | typeof USER_V2_KEY;
  readonly existed: boolean;
  /** Digest of the exact original bytes. Used only by apply's stale-plan gate. */
  readonly inputDigest: string;
  /** Digest of the JSON object excluding this migration's v2 fragment. */
  readonly baseDigest: string;
  readonly proposed: RoutingV2ConfigLayer | null;
  readonly proposedDigest: string;
  readonly writeRequired: boolean;
  readonly ownerOnly: boolean;
}

export interface RoutingV2MigrationPlan {
  readonly schemaVersion: typeof MIGRATION_SCHEMA_VERSION;
  readonly migrationId: string;
  readonly createdAt: string;
  readonly locations: {
    readonly projectRoot: string;
    readonly configRoot: string;
    readonly projectFile: string;
    readonly userFile: string;
    readonly activationFile: string;
    readonly backupDir: string;
  };
  readonly targets: {
    readonly project: RoutingV2MigrationTarget;
    readonly user: RoutingV2MigrationTarget;
  };
  /** Dry-run rollback manifest; backup files are materialized only on apply. */
  readonly rollback: {
    readonly targets: {
      readonly project: RoutingV2RollbackTarget;
      readonly user: RoutingV2RollbackTarget;
    };
  };
  readonly unresolved: readonly RoutingV2MigrationUnresolved[];
  readonly diff: readonly RoutingV2MigrationDiff[];
  readonly planDigest: string;
}

export interface RoutingV2ActiveMarker {
  readonly schemaVersion: typeof MARKER_SCHEMA_VERSION;
  readonly engineVersion: 2;
  readonly migrationId: string;
  readonly planDigest: string;
  readonly activatedAt: string;
  readonly projectRoot: string;
  readonly configRoot: string;
  readonly revision: string;
  readonly previousRevision?: string;
  readonly lastEditId?: string;
  readonly updatedAt?: string;
  readonly targets: {
    readonly project: RoutingV2ActivatedTarget;
    readonly user: RoutingV2ActivatedTarget;
  };
}

export interface RoutingV2RolledBackMarker {
  readonly schemaVersion: typeof MARKER_SCHEMA_VERSION;
  readonly engineVersion: 1;
  readonly rolledBackMigrationId: string;
  readonly planDigest: string;
  readonly rolledBackAt: string;
  readonly projectRoot: string;
  readonly configRoot: string;
}

export interface RoutingV2DeactivatedMarker {
  readonly schemaVersion: typeof MARKER_SCHEMA_VERSION;
  readonly engineVersion: 1;
  readonly deactivatedMigrationId: string;
  readonly planDigest: string;
  readonly deactivatedAt: string;
  readonly projectRoot: string;
  readonly configRoot: string;
}

export type RoutingV2ActivationMarker = RoutingV2ActiveMarker | RoutingV2RolledBackMarker | RoutingV2DeactivatedMarker;

interface RoutingV2ActivatedTarget {
  readonly path: string;
  readonly digest: string;
  readonly fragmentDigest: string;
}

interface RootSnapshot {
  readonly file: string;
  readonly existed: boolean;
  readonly bytes: string;
  readonly value: JsonObject;
}

export interface ActiveRoutingV2Settings {
  readonly layers: RoutingV2ConfigLayers;
  readonly revision: string;
}

interface BackupManifest {
  readonly schemaVersion: 1;
  readonly migrationId: string;
  readonly planDigest: string;
  readonly targets: {
    readonly project: BackupTarget;
    readonly user: BackupTarget;
  };
}

export interface RoutingV2RollbackTarget {
  readonly path: string;
  readonly existed: boolean;
  readonly digest: string;
  readonly backupFile: string;
}

type BackupTarget = RoutingV2RollbackTarget;

export type RoutingV2MigrationFaultPoint =
  | "after-backup"
  | "after-project-write"
  | "after-user-write"
  | "before-activation";

export type RoutingV2RollbackFaultPoint =
  | "after-project-restore"
  | "after-user-restore"
  | "before-rollback-marker";

export interface CreateRoutingV2MigrationPlanInput {
  readonly cwd: string;
  readonly configDir?: string;
  readonly project?: RoutingV2ConfigLayer;
  readonly user?: RoutingV2ConfigLayer;
  readonly unresolved?: readonly RoutingV2MigrationUnresolved[];
  readonly normalization?: RoutingV2NormalizationOptions;
}

export interface ApplyRoutingV2MigrationOptions {
  readonly confirmed: boolean;
  /** Independently trusted invocation location; plan paths are never trusted alone. */
  readonly cwd: string;
  readonly configDir?: string;
  readonly normalization?: RoutingV2NormalizationOptions;
  /** Test-only crash seam. */
  readonly fault?: (point: RoutingV2MigrationFaultPoint) => Promise<void> | void;
}

export interface RollbackRoutingV2MigrationOptions {
  readonly confirmed: boolean;
  /** Independently trusted invocation location; plan paths are never trusted alone. */
  readonly cwd: string;
  readonly configDir?: string;
  readonly normalization?: RoutingV2NormalizationOptions;
  /** Test-only crash seam. */
  readonly fault?: (point: RoutingV2RollbackFaultPoint) => Promise<void> | void;
}

export interface RoutingV2MigrationResult {
  readonly status: "applied" | "already-applied" | "rolled-back" | "already-rolled-back";
  readonly migrationId: string;
  readonly activationFile: string;
}

export interface DeactivateRoutingV2Options {
  readonly confirmed: boolean;
  readonly cwd: string;
  readonly configDir?: string;
}

export interface RoutingV2DeactivationResult {
  readonly status: "deactivated" | "already-deactivated";
  readonly migrationId: string;
  readonly activationFile: string;
}

export type ActiveRoutingV2Layer = "project" | "user";

export type ActiveRoutingV2EditFaultPoint = "after-journal" | "after-config-write" | "after-marker-write";

export interface UpdateActiveRoutingV2LayerInput {
  readonly cwd: string;
  readonly configDir?: string;
  readonly layer: ActiveRoutingV2Layer;
  readonly expectedRevision: string;
  readonly next: RoutingV2ConfigLayer;
  readonly normalization?: RoutingV2NormalizationOptions;
  /** Test-only crash seam. */
  readonly fault?: (point: ActiveRoutingV2EditFaultPoint) => Promise<void> | void;
}

export interface UpdateActiveRoutingV2LayerResult {
  readonly status: "updated" | "unchanged" | "already-applied";
  readonly revision: string;
}

interface ActiveRoutingV2EditJournal {
  readonly schemaVersion: 1;
  readonly editId: string;
  readonly layer: ActiveRoutingV2Layer;
  readonly targetPath: string;
  readonly targetKey: typeof PROJECT_V2_KEY | typeof USER_V2_KEY;
  readonly beforeExisted: boolean;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly backupFile: string;
  readonly beforeMarker: RoutingV2ActiveMarker;
  readonly afterMarker: RoutingV2ActiveMarker;
}

interface RoutingV2RollbackReadTarget {
  readonly path: string;
  readonly existed: boolean;
  readonly digest: string;
  readonly backupFile: string;
}

interface RoutingV2RollbackReadJournal {
  readonly schemaVersion: 1;
  readonly migrationId: string;
  readonly planDigest: string;
  readonly revision: string;
  readonly targets: {
    readonly project: RoutingV2RollbackReadTarget;
    readonly user: RoutingV2RollbackReadTarget;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function canonicalDigest(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)));
}

function activeRevision(projectFragmentDigest: string, userFragmentDigest: string): string {
  return canonicalDigest({ schemaVersion: MARKER_SCHEMA_VERSION, projectFragmentDigest, userFragmentDigest });
}

function editedActiveRevision(
  previousRevision: string,
  projectFragmentDigest: string,
  userFragmentDigest: string,
  editId: string,
): string {
  return canonicalDigest({
    schemaVersion: MARKER_SCHEMA_VERSION,
    previousRevision,
    projectFragmentDigest,
    userFragmentDigest,
    editId,
  });
}

function planBody(plan: RoutingV2MigrationPlan): Omit<RoutingV2MigrationPlan, "planDigest"> {
  const { planDigest: _planDigest, ...body } = plan;
  return body;
}

function assertPlanDigest(plan: RoutingV2MigrationPlan): void {
  if (canonicalDigest(planBody(plan)) !== plan.planDigest) throw new Error("routing v2 migration plan digest mismatch");
}

function normalizedRoot(cwd: string): string {
  return path.resolve(cwd);
}

function normalizedConfigRoot(configDir?: string): string {
  return path.resolve(keryxConfigDir(configDir));
}

function migrationBackupDir(configRoot: string, migrationId: string): string {
  return path.join(configRoot, "routing-v2", "backups", sha256(migrationId));
}

/**
 * Project-scoped activation state lives under the operator-owned user config
 * directory. A repository cannot activate itself by committing a project file.
 */
export function routingV2ActivationPath(cwd: string, configDir?: string): string {
  const projectRoot = normalizedRoot(cwd);
  return path.join(normalizedConfigRoot(configDir), "routing-v2", "activations", `${sha256(projectRoot)}.json`);
}

function locations(cwd: string, configDir: string | undefined, migrationId: string): RoutingV2MigrationPlan["locations"] {
  const projectRoot = normalizedRoot(cwd);
  const configRoot = normalizedConfigRoot(configDir);
  return {
    projectRoot,
    configRoot,
    projectFile: path.resolve(projectRoutingConfigPath(projectRoot)),
    userFile: path.resolve(shellConfigPath(configRoot)),
    activationFile: routingV2ActivationPath(projectRoot, configRoot),
    backupDir: migrationBackupDir(configRoot, migrationId),
  };
}

function withRoutingMutationLocks<T>(activationFile: string, projectRoot: string, action: () => Promise<T>): Promise<T> {
  return withFileLock(`${activationFile}.lock`, () => withProjectRoutingWriteLock(projectRoot, action));
}

function parseRoot(bytes: string, file: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error(`${file} is malformed JSON; migration refused`);
  }
  if (!isRecord(parsed)) throw new Error(`${file} must contain a JSON object; migration refused`);
  return parsed;
}

async function readRoot(file: string): Promise<RootSnapshot> {
  try {
    const stats = await lstat(file);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${file} must be a regular non-symlink file`);
    const bytes = await readFile(file, "utf8");
    return { file, existed: true, bytes, value: parseRoot(bytes, file) };
  } catch (error) {
    if (isNotFound(error)) return { file, existed: false, bytes: "", value: {} };
    throw error;
  }
}

function readRootSync(file: string): RootSnapshot {
  try {
    const stats = lstatSync(file);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${file} must be a regular non-symlink file`);
    const bytes = readFileSync(file, "utf8");
    return { file, existed: true, bytes, value: parseRoot(bytes, file) };
  } catch (error) {
    if (isNotFound(error)) return { file, existed: false, bytes: "", value: {} };
    throw error;
  }
}

function withoutKey(value: JsonObject, key: string): JsonObject {
  const { [key]: _removed, ...rest } = value;
  return rest;
}

function validateLayer(
  layer: unknown,
  label: string,
  normalization: RoutingV2NormalizationOptions = {},
): RoutingV2ConfigLayer {
  const result = validateRoutingV2ConfigLayer(layer, normalization);
  if (!result.ok) throw new Error(`invalid ${label} routing v2 config: ${result.errors.join("; ")}`);
  return layer as RoutingV2ConfigLayer;
}

function existingLayer(
  root: RootSnapshot,
  key: string,
  label: string,
  normalization: RoutingV2NormalizationOptions = {},
): RoutingV2ConfigLayer | null {
  const raw = root.value[key];
  return raw === undefined ? null : validateLayer(raw, label, normalization);
}

function makeTarget(root: RootSnapshot, key: typeof PROJECT_V2_KEY | typeof USER_V2_KEY, proposed: RoutingV2ConfigLayer | null, ownerOnly: boolean): RoutingV2MigrationTarget {
  const proposedDigest = routingV2Digest(proposed);
  const current = root.value[key];
  return {
    file: root.file,
    key,
    existed: root.existed,
    inputDigest: sha256(root.bytes),
    baseDigest: canonicalDigest(withoutKey(root.value, key)),
    proposed,
    proposedDigest,
    writeRequired: routingV2Digest(current === undefined ? null : current) !== proposedDigest,
    ownerOnly,
  };
}

function assertValidLayers(
  project: RoutingV2ConfigLayer | null,
  user: RoutingV2ConfigLayer | null,
  normalization: RoutingV2NormalizationOptions = {},
): void {
  if (project !== null) validateLayer(project, "project", normalization);
  if (user !== null) validateLayer(user, "user", normalization);
  normalizeRoutingV2Config({
    ...(project === null ? {} : { project }),
    ...(user === null ? {} : { user }),
  }, normalization);
}

/** Build the dry-run artifact in memory. This function never writes. */
export async function createRoutingV2MigrationPlan(input: CreateRoutingV2MigrationPlanInput): Promise<RoutingV2MigrationPlan> {
  const migrationId = randomUUID();
  const targetLocations = locations(input.cwd, input.configDir, migrationId);
  const [projectRoot, userRoot] = await Promise.all([
    readRoot(targetLocations.projectFile),
    readRoot(targetLocations.userFile),
  ]);
  const project = input.project ?? null;
  const user = input.user ?? null;
  assertValidLayers(project, user, input.normalization);
  const projectBefore = existingLayer(projectRoot, PROJECT_V2_KEY, "existing project", input.normalization);
  const userBefore = existingLayer(userRoot, USER_V2_KEY, "existing user", input.normalization);
  const targets = {
    project: makeTarget(projectRoot, PROJECT_V2_KEY, project, false),
    user: makeTarget(userRoot, USER_V2_KEY, user, true),
  };
  const body: Omit<RoutingV2MigrationPlan, "planDigest"> = {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    migrationId,
    createdAt: new Date().toISOString(),
    locations: targetLocations,
    targets,
    rollback: {
      targets: {
        project: plannedBackupTarget(targetLocations.backupDir, "project", targets.project),
        user: plannedBackupTarget(targetLocations.backupDir, "user", targets.user),
      },
    },
    unresolved: [...(input.unresolved ?? [])],
    diff: [
      { layer: "project", path: "/modelRouting", before: projectBefore, after: project },
      { layer: "user", path: "/routingV2", before: userBefore, after: user },
    ],
  };
  return { ...body, planDigest: canonicalDigest(body) };
}

function assertExactLocations(plan: RoutingV2MigrationPlan, cwd: string, configDir?: string): void {
  const expected = locations(cwd, configDir, plan.migrationId);
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (plan.locations[key] !== expected[key]) throw new Error(`routing v2 migration plan has an invalid ${key}`);
  }
  if (plan.targets.project.file !== expected.projectFile || plan.targets.project.key !== PROJECT_V2_KEY) {
    throw new Error("routing v2 migration plan has an invalid project target");
  }
  if (plan.targets.user.file !== expected.userFile || plan.targets.user.key !== USER_V2_KEY) {
    throw new Error("routing v2 migration plan has an invalid user target");
  }
  const expectedRollback = {
    project: plannedBackupTarget(expected.backupDir, "project", plan.targets.project),
    user: plannedBackupTarget(expected.backupDir, "user", plan.targets.user),
  };
  if (canonicalDigest(plan.rollback.targets) !== canonicalDigest(expectedRollback)) {
    throw new Error("routing v2 migration plan has an invalid rollback manifest");
  }
}

function assertApplicablePlan(
  plan: RoutingV2MigrationPlan,
  confirmed: boolean,
  cwd: string,
  configDir?: string,
  normalization: RoutingV2NormalizationOptions = {},
): void {
  if (!confirmed) throw new Error("explicit routing v2 migration plan confirmation is required");
  if (plan.schemaVersion !== MIGRATION_SCHEMA_VERSION) throw new Error("unsupported routing v2 migration plan schema");
  assertPlanDigest(plan);
  assertExactLocations(plan, cwd, configDir);
  if (plan.unresolved.length > 0) throw new Error(`routing v2 migration has ${plan.unresolved.length} unresolved mapping(s)`);
  assertValidLayers(plan.targets.project.proposed, plan.targets.user.proposed, normalization);
  if (plan.targets.project.ownerOnly || !plan.targets.user.ownerOnly) throw new Error("routing v2 migration target ownership metadata mismatch");
  if (plan.targets.project.proposedDigest !== routingV2Digest(plan.targets.project.proposed)
    || plan.targets.user.proposedDigest !== routingV2Digest(plan.targets.user.proposed)) {
    throw new Error("routing v2 migration proposed digest mismatch");
  }
  const projectDiff = plan.diff[0];
  const userDiff = plan.diff[1];
  if (
    plan.diff.length !== 2
    || projectDiff === undefined
    || projectDiff.layer !== "project"
    || projectDiff.path !== "/modelRouting"
    || canonicalDigest(projectDiff.after) !== canonicalDigest(plan.targets.project.proposed)
    || userDiff === undefined
    || userDiff.layer !== "user"
    || userDiff.path !== "/routingV2"
    || canonicalDigest(userDiff.after) !== canonicalDigest(plan.targets.user.proposed)
  ) throw new Error("routing v2 migration diff does not match its targets");
}

type TargetState = "pending" | "staged" | "noop" | "stale";

function targetState(root: RootSnapshot, target: RoutingV2MigrationTarget): TargetState {
  if (sha256(root.bytes) === target.inputDigest && root.existed === target.existed) return target.writeRequired ? "pending" : "noop";
  const current = root.value[target.key];
  if (
    target.writeRequired
    &&
    canonicalDigest(withoutKey(root.value, target.key)) === target.baseDigest
    && routingV2Digest(current === undefined ? null : current) === target.proposedDigest
  ) return "staged";
  return "stale";
}

function markerJson(marker: RoutingV2ActivationMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

function parseActiveTarget(raw: unknown, label: string): RoutingV2ActivatedTarget {
  if (!isRecord(raw) || typeof raw.path !== "string" || typeof raw.digest !== "string" || typeof raw.fragmentDigest !== "string") {
    throw new Error(`malformed routing v2 activation ${label} target`);
  }
  return { path: raw.path, digest: raw.digest, fragmentDigest: raw.fragmentDigest };
}

/** Parse a marker strictly. Malformed activation state must fail closed. */
export function parseRoutingV2ActivationMarker(raw: unknown): RoutingV2ActivationMarker {
  if (!isRecord(raw) || raw.schemaVersion !== MARKER_SCHEMA_VERSION || (raw.engineVersion !== 1 && raw.engineVersion !== 2)) {
    throw new Error("malformed routing v2 activation marker");
  }
  if (typeof raw.planDigest !== "string" || typeof raw.projectRoot !== "string" || typeof raw.configRoot !== "string") {
    throw new Error("malformed routing v2 activation marker binding");
  }
  if (raw.engineVersion === 1) {
    if (typeof raw.rolledBackMigrationId === "string" && typeof raw.rolledBackAt === "string") {
      return {
        schemaVersion: MARKER_SCHEMA_VERSION,
        engineVersion: 1,
        rolledBackMigrationId: raw.rolledBackMigrationId,
        planDigest: raw.planDigest,
        rolledBackAt: raw.rolledBackAt,
        projectRoot: raw.projectRoot,
        configRoot: raw.configRoot,
      };
    }
    if (typeof raw.deactivatedMigrationId === "string" && typeof raw.deactivatedAt === "string") {
      return {
        schemaVersion: MARKER_SCHEMA_VERSION,
        engineVersion: 1,
        deactivatedMigrationId: raw.deactivatedMigrationId,
        planDigest: raw.planDigest,
        deactivatedAt: raw.deactivatedAt,
        projectRoot: raw.projectRoot,
        configRoot: raw.configRoot,
      };
    }
    throw new Error("malformed routing v2 inactive marker");
  }
  if (typeof raw.migrationId !== "string" || typeof raw.activatedAt !== "string" || !isRecord(raw.targets)) {
    throw new Error("malformed routing v2 active marker");
  }
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    engineVersion: 2,
    migrationId: raw.migrationId,
    planDigest: raw.planDigest,
    activatedAt: raw.activatedAt,
    projectRoot: raw.projectRoot,
    configRoot: raw.configRoot,
    revision: typeof raw.revision === "string"
      ? raw.revision
      : activeRevision(
        parseActiveTarget(raw.targets.project, "project").fragmentDigest,
        parseActiveTarget(raw.targets.user, "user").fragmentDigest,
      ),
    ...(typeof raw.previousRevision === "string" ? { previousRevision: raw.previousRevision } : {}),
    ...(typeof raw.lastEditId === "string" ? { lastEditId: raw.lastEditId } : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
    targets: {
      project: parseActiveTarget(raw.targets.project, "project"),
      user: parseActiveTarget(raw.targets.user, "user"),
    },
  };
}

function readMarker(file: string): RoutingV2ActivationMarker | undefined {
  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("routing v2 activation marker must be a regular file");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error("routing v2 activation marker permissions are not owner-only");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("malformed routing v2 activation marker JSON");
  }
  return parseRoutingV2ActivationMarker(raw);
}

function assertMarkerBinding(marker: RoutingV2ActivationMarker, cwd: string, configDir?: string): void {
  const projectRoot = normalizedRoot(cwd);
  const configRoot = normalizedConfigRoot(configDir);
  if (marker.projectRoot !== projectRoot || marker.configRoot !== configRoot) {
    throw new Error("routing v2 activation marker path binding mismatch");
  }
  if (marker.engineVersion === 1) return;
  if (marker.targets.project.path !== path.resolve(projectRoutingConfigPath(projectRoot))) {
    throw new Error("routing v2 activation marker project path mismatch");
  }
  if (marker.targets.user.path !== path.resolve(shellConfigPath(configRoot))) {
    throw new Error("routing v2 activation marker user path mismatch");
  }
}

function expectedActiveMarkerRevision(marker: RoutingV2ActiveMarker): string | undefined {
  if (marker.lastEditId === undefined) {
    return activeRevision(marker.targets.project.fragmentDigest, marker.targets.user.fragmentDigest);
  }
  if (marker.previousRevision === undefined) return undefined;
  return editedActiveRevision(
    marker.previousRevision,
    marker.targets.project.fragmentDigest,
    marker.targets.user.fragmentDigest,
    marker.lastEditId,
  );
}

/**
 * Reads marker and both bound fragments synchronously as one loader snapshot.
 * Missing/rolled back returns legacy. Any active inconsistency throws.
 */
export function readActiveRoutingV2Settings(
  cwd: string,
  configDir?: string,
  normalization: RoutingV2NormalizationOptions = {},
): ActiveRoutingV2Settings | undefined {
  const markerFile = routingV2ActivationPath(cwd, configDir);
  const marker = readMarker(markerFile);
  if (marker === undefined) return undefined;
  assertMarkerBinding(marker, cwd, configDir);
  const journal = readEditJournalSync(markerFile);
  const rollbackJournal = readRollbackReadJournalSync(markerFile);
  if (journal !== undefined && rollbackJournal !== undefined) throw new Error("routing v2 has conflicting edit and rollback journals");
  if (marker.engineVersion === 1) {
    if (journal !== undefined) throw new Error("routing v2 is inactive with a pending edit journal");
    return undefined;
  }
  const expectedRevision = expectedActiveMarkerRevision(marker);
  if (marker.revision !== expectedRevision) throw new Error("active routing v2 revision mismatch");
  let projectRoot = readRootSync(marker.targets.project.path);
  let userRoot = readRootSync(marker.targets.user.path);
  if (rollbackJournal !== undefined) {
    if (rollbackJournal.migrationId !== marker.migrationId
      || rollbackJournal.planDigest !== marker.planDigest
      || rollbackJournal.revision !== marker.revision
      || rollbackJournal.targets.project.path !== marker.targets.project.path
      || rollbackJournal.targets.user.path !== marker.targets.user.path
      || rollbackJournal.targets.project.digest !== marker.targets.project.digest
      || rollbackJournal.targets.user.digest !== marker.targets.user.digest) {
      throw new Error("routing v2 rollback read journal does not match the active marker");
    }
    projectRoot = readRollbackReadBackupSync(rollbackJournal.targets.project);
    userRoot = readRollbackReadBackupSync(rollbackJournal.targets.user);
  } else if (journal !== undefined) {
    assertEditJournalBinding(journal, markerFile, cwd, configDir);
    const journalMarker = marker.revision === journal.beforeMarker.revision
      ? journal.beforeMarker
      : marker.revision === journal.afterMarker.revision
        ? journal.afterMarker
        : undefined;
    if (journalMarker === undefined
      || journalMarker.migrationId !== marker.migrationId
      || journalMarker.planDigest !== marker.planDigest) {
      throw new Error("routing v2 edit journal does not match the active marker");
    }
    const currentTarget = journal.layer === "project" ? projectRoot : userRoot;
    const currentFragment = currentTarget.value[journal.targetKey];
    const currentFragmentDigest = routingV2Digest(currentFragment === undefined ? null : currentFragment);
    const beforeFragmentDigest = journal.beforeMarker.targets[journal.layer].fragmentDigest;
    const afterFragmentDigest = journal.afterMarker.targets[journal.layer].fragmentDigest;
    if (marker.revision === journal.beforeMarker.revision) {
      if (currentFragmentDigest === afterFragmentDigest) {
        const original = readEditBackupSync(journal);
        if (journal.layer === "project") projectRoot = original;
        else userRoot = original;
      } else if (currentFragmentDigest !== beforeFragmentDigest) {
        throw new Error("routing v2 edit journal target is neither the old nor new revision");
      }
    } else if (currentFragmentDigest !== afterFragmentDigest) {
      throw new Error("routing v2 committed edit journal target mismatch");
    }
  }
  const projectRaw = projectRoot.value[PROJECT_V2_KEY];
  const userRaw = userRoot.value[USER_V2_KEY];
  if (routingV2Digest(projectRaw === undefined ? null : projectRaw) !== marker.targets.project.fragmentDigest) {
    throw new Error("active routing v2 project fragment digest mismatch");
  }
  if (routingV2Digest(userRaw === undefined ? null : userRaw) !== marker.targets.user.fragmentDigest) {
    throw new Error("active routing v2 user fragment digest mismatch");
  }
  const project = projectRaw === undefined ? undefined : validateLayer(projectRaw, "active project", normalization);
  const user = userRaw === undefined ? undefined : validateLayer(userRaw, "active user", normalization);
  const layers: RoutingV2ConfigLayers = { ...(project === undefined ? {} : { project }), ...(user === undefined ? {} : { user }) };
  normalizeRoutingV2Config(layers, normalization);
  return { layers, revision: marker.revision };
}

export function readActiveRoutingV2Layers(
  cwd: string,
  configDir?: string,
  normalization: RoutingV2NormalizationOptions = {},
): RoutingV2ConfigLayers | undefined {
  return readActiveRoutingV2Settings(cwd, configDir, normalization)?.layers;
}

function editJournalPath(activationFile: string): string {
  return `${activationFile}.edit.json`;
}

function editBackupPath(activationFile: string): string {
  return `${activationFile}.edit.backup`;
}

function rollbackReadJournalPath(activationFile: string): string {
  return `${activationFile}.rollback.json`;
}

function rollbackReadBackupPath(activationFile: string, layer: ActiveRoutingV2Layer): string {
  return `${activationFile}.rollback.${layer}.backup`;
}

function renderLayerRoot(root: RootSnapshot, key: typeof PROJECT_V2_KEY | typeof USER_V2_KEY, next: RoutingV2ConfigLayer): string {
  return `${JSON.stringify({ ...root.value, [key]: next }, null, 2)}\n`;
}

function parseEditJournal(raw: unknown): ActiveRoutingV2EditJournal {
  if (
    !isRecord(raw)
    || raw.schemaVersion !== 1
    || typeof raw.editId !== "string"
    || (raw.layer !== "project" && raw.layer !== "user")
    || typeof raw.targetPath !== "string"
    || (raw.targetKey !== PROJECT_V2_KEY && raw.targetKey !== USER_V2_KEY)
    || typeof raw.beforeExisted !== "boolean"
    || typeof raw.beforeDigest !== "string"
    || typeof raw.afterDigest !== "string"
    || typeof raw.backupFile !== "string"
  ) throw new Error("malformed routing v2 edit journal");
  const beforeMarker = parseRoutingV2ActivationMarker(raw.beforeMarker);
  const afterMarker = parseRoutingV2ActivationMarker(raw.afterMarker);
  if (beforeMarker.engineVersion !== 2 || afterMarker.engineVersion !== 2) throw new Error("routing v2 edit journal markers must be active");
  return {
    schemaVersion: 1,
    editId: raw.editId,
    layer: raw.layer,
    targetPath: raw.targetPath,
    targetKey: raw.targetKey,
    beforeExisted: raw.beforeExisted,
    beforeDigest: raw.beforeDigest,
    afterDigest: raw.afterDigest,
    backupFile: raw.backupFile,
    beforeMarker,
    afterMarker,
  };
}

function parseRollbackReadTarget(raw: unknown, activationFile: string, layer: ActiveRoutingV2Layer): RoutingV2RollbackReadTarget {
  if (!isRecord(raw)
    || typeof raw.path !== "string"
    || typeof raw.existed !== "boolean"
    || typeof raw.digest !== "string"
    || raw.backupFile !== rollbackReadBackupPath(activationFile, layer)) {
    throw new Error(`malformed routing v2 rollback ${layer} read target`);
  }
  return { path: raw.path, existed: raw.existed, digest: raw.digest, backupFile: raw.backupFile };
}

function parseRollbackReadJournal(raw: unknown, activationFile: string): RoutingV2RollbackReadJournal {
  if (!isRecord(raw)
    || raw.schemaVersion !== 1
    || typeof raw.migrationId !== "string"
    || typeof raw.planDigest !== "string"
    || typeof raw.revision !== "string"
    || !isRecord(raw.targets)) {
    throw new Error("malformed routing v2 rollback read journal");
  }
  return {
    schemaVersion: 1,
    migrationId: raw.migrationId,
    planDigest: raw.planDigest,
    revision: raw.revision,
    targets: {
      project: parseRollbackReadTarget(raw.targets.project, activationFile, "project"),
      user: parseRollbackReadTarget(raw.targets.user, activationFile, "user"),
    },
  };
}

function readRollbackReadJournalSync(activationFile: string): RoutingV2RollbackReadJournal | undefined {
  const file = rollbackReadJournalPath(activationFile);
  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("routing v2 rollback read journal must be a regular non-symlink file");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error("routing v2 rollback read journal permissions are not owner-only");
  try {
    return parseRollbackReadJournal(JSON.parse(readFileSync(file, "utf8")), activationFile);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("malformed routing v2 rollback read journal JSON");
    throw error;
  }
}

function readRollbackReadBackupSync(target: RoutingV2RollbackReadTarget): RootSnapshot {
  if (!target.existed) return { file: target.path, existed: false, bytes: "", value: {} };
  let stats;
  try {
    stats = lstatSync(target.backupFile);
  } catch (error) {
    if (isNotFound(error)) throw new Error("routing v2 rollback read backup is missing");
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("routing v2 rollback read backup must be a regular non-symlink file");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error("routing v2 rollback read backup permissions are not owner-only");
  const bytes = readFileSync(target.backupFile, "utf8");
  if (sha256(bytes) !== target.digest) throw new Error("routing v2 rollback read backup digest mismatch");
  return { file: target.path, existed: true, bytes, value: parseRoot(bytes, target.path) };
}

function readEditJournalSync(activationFile: string): ActiveRoutingV2EditJournal | undefined {
  const file = editJournalPath(activationFile);
  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("routing v2 edit journal must be a regular non-symlink file");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error("routing v2 edit journal permissions are not owner-only");
  try {
    return parseEditJournal(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("malformed routing v2 edit journal JSON");
    throw error;
  }
}

function readEditBackupSync(journal: ActiveRoutingV2EditJournal): RootSnapshot {
  if (!journal.beforeExisted) return { file: journal.targetPath, existed: false, bytes: "", value: {} };
  let stats;
  try {
    stats = lstatSync(journal.backupFile);
  } catch (error) {
    if (isNotFound(error)) throw new Error("routing v2 edit backup is missing");
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("routing v2 edit backup must be a regular non-symlink file");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error("routing v2 edit backup permissions are not owner-only");
  const bytes = readFileSync(journal.backupFile, "utf8");
  if (sha256(bytes) !== journal.beforeDigest) throw new Error("routing v2 edit backup digest mismatch");
  return { file: journal.targetPath, existed: true, bytes, value: parseRoot(bytes, journal.targetPath) };
}

function assertEditJournalBinding(
  journal: ActiveRoutingV2EditJournal,
  activationFile: string,
  cwd: string,
  configDir?: string,
): void {
  assertMarkerBinding(journal.beforeMarker, cwd, configDir);
  assertMarkerBinding(journal.afterMarker, cwd, configDir);
  const otherLayer: ActiveRoutingV2Layer = journal.layer === "project" ? "user" : "project";
  if (journal.targetPath !== journal.beforeMarker.targets[journal.layer].path
    || journal.targetPath !== journal.afterMarker.targets[journal.layer].path
    || journal.targetKey !== (journal.layer === "project" ? PROJECT_V2_KEY : USER_V2_KEY)
    || journal.backupFile !== editBackupPath(activationFile)
    || journal.beforeMarker.revision !== expectedActiveMarkerRevision(journal.beforeMarker)
    || journal.afterMarker.migrationId !== journal.beforeMarker.migrationId
    || journal.afterMarker.planDigest !== journal.beforeMarker.planDigest
    || journal.afterMarker.activatedAt !== journal.beforeMarker.activatedAt
    || journal.afterMarker.previousRevision !== journal.beforeMarker.revision
    || journal.afterMarker.lastEditId !== journal.editId
    || journal.afterMarker.revision !== expectedActiveMarkerRevision(journal.afterMarker)
    || canonicalDigest(journal.afterMarker.targets[otherLayer]) !== canonicalDigest(journal.beforeMarker.targets[otherLayer])
    || journal.afterDigest !== journal.afterMarker.targets[journal.layer].digest) {
    throw new Error("routing v2 edit journal target binding mismatch");
  }
}

async function readEditJournal(activationFile: string): Promise<ActiveRoutingV2EditJournal | undefined> {
  const file = editJournalPath(activationFile);
  try {
    const stats = await lstat(file);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("routing v2 edit journal must be a regular non-symlink file");
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error("routing v2 edit journal permissions are not owner-only");
    return parseEditJournal(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function cleanupEditJournal(activationFile: string, journal: ActiveRoutingV2EditJournal): Promise<void> {
  await rm(editJournalPath(activationFile), { force: true });
  await rm(journal.backupFile, { force: true });
}

async function cleanupRollbackReadJournal(activationFile: string): Promise<void> {
  await rm(rollbackReadJournalPath(activationFile), { force: true });
  await rm(rollbackReadBackupPath(activationFile, "project"), { force: true });
  await rm(rollbackReadBackupPath(activationFile, "user"), { force: true });
}

async function ensureRollbackReadJournal(
  activationFile: string,
  marker: RoutingV2ActiveMarker,
  project: RootSnapshot,
  user: RootSnapshot,
  states: readonly RollbackTargetState[],
): Promise<RoutingV2RollbackReadJournal> {
  const existing = readRollbackReadJournalSync(activationFile);
  if (existing !== undefined) {
    if (existing.migrationId !== marker.migrationId
      || existing.planDigest !== marker.planDigest
      || existing.revision !== marker.revision
      || existing.targets.project.path !== marker.targets.project.path
      || existing.targets.user.path !== marker.targets.user.path
      || existing.targets.project.digest !== marker.targets.project.digest
      || existing.targets.user.digest !== marker.targets.user.digest) {
      throw new Error("routing v2 rollback read journal does not match the active marker");
    }
    readRollbackReadBackupSync(existing.targets.project);
    readRollbackReadBackupSync(existing.targets.user);
    return existing;
  }
  if (states.some((state) => state !== "active")) {
    throw new Error("routing v2 rollback is partially restored but its read journal is missing");
  }
  const target = (layer: ActiveRoutingV2Layer, root: RootSnapshot): RoutingV2RollbackReadTarget => ({
    path: root.file,
    existed: root.existed,
    digest: sha256(root.bytes),
    backupFile: rollbackReadBackupPath(activationFile, layer),
  });
  const journal: RoutingV2RollbackReadJournal = {
    schemaVersion: 1,
    migrationId: marker.migrationId,
    planDigest: marker.planDigest,
    revision: marker.revision,
    targets: {
      project: target("project", project),
      user: target("user", user),
    },
  };
  if (project.existed) await writeFileAtomic(journal.targets.project.backupFile, project.bytes, { mode: 0o600 });
  if (user.existed) await writeFileAtomic(journal.targets.user.backupFile, user.bytes, { mode: 0o600 });
  await writeFileAtomic(rollbackReadJournalPath(activationFile), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  return journal;
}

/** Complete or discard a previously interrupted edit while holding the activation lock. */
async function recoverActiveRoutingV2Edit(activationFile: string, cwd: string, configDir?: string): Promise<void> {
  const journal = await readEditJournal(activationFile);
  if (journal === undefined) return;
  const marker = readMarker(activationFile);
  if (marker === undefined) throw new Error("routing v2 edit journal exists without an activation marker");
  assertMarkerBinding(marker, cwd, configDir);
  assertEditJournalBinding(journal, activationFile, cwd, configDir);
  if (marker.engineVersion !== 2) throw new Error("routing v2 edit journal exists while routing v2 is inactive");
  const target = await readRoot(journal.targetPath);
  const targetDigest = sha256(target.bytes);
  const fragment = target.value[journal.targetKey];
  const fragmentDigest = routingV2Digest(fragment === undefined ? null : fragment);
  const beforeFragmentDigest = journal.beforeMarker.targets[journal.layer].fragmentDigest;
  const afterFragmentDigest = journal.afterMarker.targets[journal.layer].fragmentDigest;
  if (marker.revision === journal.afterMarker.revision && fragmentDigest === afterFragmentDigest) {
    await cleanupEditJournal(activationFile, journal);
    return;
  }
  if (marker.revision !== journal.beforeMarker.revision) throw new Error("routing v2 edit journal marker revision mismatch");
  if (fragmentDigest === beforeFragmentDigest) {
    await cleanupEditJournal(activationFile, journal);
    return;
  }
  if (fragmentDigest !== afterFragmentDigest) throw new Error("routing v2 edit journal target digest mismatch");
  const recoveredMarker: RoutingV2ActiveMarker = {
    ...journal.afterMarker,
    targets: {
      ...journal.afterMarker.targets,
      [journal.layer]: { ...journal.afterMarker.targets[journal.layer], digest: targetDigest },
    },
  };
  await writeFileAtomic(activationFile, markerJson(recoveredMarker), { mode: 0o600 });
  await cleanupEditJournal(activationFile, journal);
}

function writeUserRootExpected(file: string, expected: RootSnapshot, nextBytes: string): void {
  const outcome = updateConfigFile(file, (read) => {
    const current = rootFromConfigRead(file, read);
    if (current.existed !== expected.existed || sha256(current.bytes) !== sha256(expected.bytes)) {
      throw new Error("active routing v2 user layer changed during update");
    }
    return nextBytes;
  });
  if (outcome !== "written") throw new Error(`active routing v2 user layer write ${outcome}`);
}

async function writeActiveLayerRoot(layer: ActiveRoutingV2Layer, current: RootSnapshot, nextBytes: string): Promise<void> {
  if (layer === "user") {
    writeUserRootExpected(current.file, current, nextBytes);
    return;
  }
  const latest = await readRoot(current.file);
  if (latest.existed !== current.existed || sha256(latest.bytes) !== sha256(current.bytes)) {
    throw new Error("active routing v2 project layer changed during update");
  }
  await writeFileAtomic(current.file, nextBytes);
}

function updatedActiveMarker(
  marker: RoutingV2ActiveMarker,
  layer: ActiveRoutingV2Layer,
  targetDigest: string,
  fragmentDigest: string,
  editId: string,
): RoutingV2ActiveMarker {
  const targets = {
    ...marker.targets,
    [layer]: { ...marker.targets[layer], digest: targetDigest, fragmentDigest },
  };
  return {
    ...marker,
    previousRevision: marker.revision,
    revision: editedActiveRevision(
      marker.revision,
      targets.project.fragmentDigest,
      targets.user.fragmentDigest,
      editId,
    ),
    lastEditId: editId,
    updatedAt: new Date().toISOString(),
    targets,
  };
}

/** Atomically update one active layer with expected-revision conflict detection. */
export async function updateActiveRoutingV2Layer(input: UpdateActiveRoutingV2LayerInput): Promise<UpdateActiveRoutingV2LayerResult> {
  validateLayer(input.next, `${input.layer} update`, input.normalization);
  const projectRoot = normalizedRoot(input.cwd);
  const configRoot = normalizedConfigRoot(input.configDir);
  const activationFile = routingV2ActivationPath(projectRoot, configRoot);
  const nextFragmentDigest = routingV2Digest(input.next);
  const editId = canonicalDigest({ expectedRevision: input.expectedRevision, layer: input.layer, nextFragmentDigest });
  return withRoutingMutationLocks(activationFile, projectRoot, async () => {
    await recoverActiveRoutingV2Edit(activationFile, projectRoot, configRoot);
    if (readRollbackReadJournalSync(activationFile) !== undefined) throw new Error("routing v2 rollback is in progress");
    const marker = readMarker(activationFile);
    if (marker === undefined || marker.engineVersion !== 2) throw new Error("routing v2 is not active");
    assertMarkerBinding(marker, projectRoot, configRoot);
    const settings = readActiveRoutingV2Settings(projectRoot, configRoot, input.normalization);
    if (settings === undefined) throw new Error("routing v2 is not active");
    if (marker.lastEditId === editId) return { status: "already-applied", revision: marker.revision };
    if (marker.revision !== input.expectedRevision) throw new Error("active routing v2 revision conflict");
    const nextLayers: RoutingV2ConfigLayers = { ...settings.layers, [input.layer]: input.next };
    normalizeRoutingV2Config(nextLayers, input.normalization);
    const currentLayer = settings.layers[input.layer];
    if (currentLayer !== undefined && routingV2Digest(currentLayer) === nextFragmentDigest) {
      return { status: "unchanged", revision: marker.revision };
    }
    const target = marker.targets[input.layer];
    const currentRoot = await readRoot(target.path);
    const targetKey = input.layer === "project" ? PROJECT_V2_KEY : USER_V2_KEY;
    const currentFragment = currentRoot.value[targetKey];
    if (routingV2Digest(currentFragment === undefined ? null : currentFragment) !== target.fragmentDigest) {
      throw new Error(`active routing v2 ${input.layer} fragment changed during update`);
    }
    const nextBytes = renderLayerRoot(currentRoot, targetKey, input.next);
    const nextMarker = updatedActiveMarker(marker, input.layer, sha256(nextBytes), nextFragmentDigest, editId);
    const backupFile = editBackupPath(activationFile);
    if (currentRoot.existed) await writeFileAtomic(backupFile, currentRoot.bytes, { mode: 0o600 });
    const journal: ActiveRoutingV2EditJournal = {
      schemaVersion: 1,
      editId,
      layer: input.layer,
      targetPath: target.path,
      targetKey,
      beforeExisted: currentRoot.existed,
      beforeDigest: sha256(currentRoot.bytes),
      afterDigest: sha256(nextBytes),
      backupFile,
      beforeMarker: marker,
      afterMarker: nextMarker,
    };
    await writeFileAtomic(editJournalPath(activationFile), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    await input.fault?.("after-journal");
    await writeActiveLayerRoot(input.layer, currentRoot, nextBytes);
    await input.fault?.("after-config-write");
    const written = await readRoot(target.path);
    if (sha256(written.bytes) !== journal.afterDigest) throw new Error(`active routing v2 ${input.layer} write verification failed`);
    await writeFileAtomic(activationFile, markerJson(nextMarker), { mode: 0o600 });
    await input.fault?.("after-marker-write");
    await cleanupEditJournal(activationFile, journal);
    return { status: "updated", revision: nextMarker.revision };
  });
}

function backupManifestPath(plan: RoutingV2MigrationPlan): string {
  return path.join(plan.locations.backupDir, "manifest.json");
}

function plannedBackupTarget(backupDir: string, layer: "project" | "user", target: RoutingV2MigrationTarget): BackupTarget {
  return {
    path: target.file,
    existed: target.existed,
    digest: target.inputDigest,
    backupFile: path.join(backupDir, `${layer}.json.original`),
  };
}

function backupTarget(plan: RoutingV2MigrationPlan, layer: "project" | "user", target: RoutingV2MigrationTarget): BackupTarget {
  return plannedBackupTarget(plan.locations.backupDir, layer, target);
}

async function createBackup(plan: RoutingV2MigrationPlan, project: RootSnapshot, user: RootSnapshot): Promise<BackupManifest> {
  const manifest: BackupManifest = {
    schemaVersion: 1,
    migrationId: plan.migrationId,
    planDigest: plan.planDigest,
    targets: plan.rollback.targets,
  };
  ensureKeryxSubdir(["routing-v2", "backups", path.basename(plan.locations.backupDir)], plan.locations.configRoot);
  await mkdir(plan.locations.backupDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(plan.locations.backupDir, 0o700);
  if (project.existed) await writeFileAtomic(manifest.targets.project.backupFile, project.bytes, { mode: 0o600 });
  if (user.existed) await writeFileAtomic(manifest.targets.user.backupFile, user.bytes, { mode: 0o600 });
  await writeFileAtomic(backupManifestPath(plan), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

function validateBackupManifest(raw: unknown, plan: RoutingV2MigrationPlan): BackupManifest {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.migrationId !== plan.migrationId || raw.planDigest !== plan.planDigest || !isRecord(raw.targets)) {
    throw new Error("routing v2 migration backup manifest mismatch");
  }
  const expected = {
    project: backupTarget(plan, "project", plan.targets.project),
    user: backupTarget(plan, "user", plan.targets.user),
  };
  if (canonicalDigest(raw.targets) !== canonicalDigest(expected)) throw new Error("routing v2 migration backup targets mismatch");
  return raw as unknown as BackupManifest;
}

async function readBackupManifest(plan: RoutingV2MigrationPlan): Promise<BackupManifest | undefined> {
  try {
    const raw = JSON.parse(await readFile(backupManifestPath(plan), "utf8"));
    return validateBackupManifest(raw, plan);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function ensureBackup(plan: RoutingV2MigrationPlan, project: RootSnapshot, user: RootSnapshot, states: readonly TargetState[]): Promise<BackupManifest> {
  const existing = await readBackupManifest(plan);
  if (existing !== undefined) return existing;
  if (states.some((state) => state !== "pending" && state !== "noop")) {
    throw new Error("routing v2 migration is partially staged but its backup manifest is missing");
  }
  await rm(plan.locations.backupDir, { recursive: true, force: true });
  return createBackup(plan, project, user);
}

async function originalRoot(target: BackupTarget): Promise<RootSnapshot> {
  if (!target.existed) return { file: target.path, existed: false, bytes: "", value: {} };
  const bytes = await readFile(target.backupFile, "utf8");
  if (sha256(bytes) !== target.digest) throw new Error(`routing v2 backup digest mismatch for ${target.path}`);
  return { file: target.path, existed: true, bytes, value: parseRoot(bytes, target.path) };
}

function assertOriginalPlanConsistency(
  plan: RoutingV2MigrationPlan,
  project: RootSnapshot,
  user: RootSnapshot,
  normalization: RoutingV2NormalizationOptions = {},
): void {
  const projectDiff = plan.diff[0];
  const userDiff = plan.diff[1];
  if (projectDiff === undefined || userDiff === undefined) throw new Error("routing v2 migration diff is incomplete");
  const pairs = [
    { root: project, target: plan.targets.project, diff: projectDiff },
    { root: user, target: plan.targets.user, diff: userDiff },
  ] as const;
  for (const { root, target, diff } of pairs) {
    const before = root.value[target.key];
    const beforeLayer = before === undefined ? null : validateLayer(before, `original ${diff.layer}`, normalization);
    if (sha256(root.bytes) !== target.inputDigest || root.existed !== target.existed) {
      throw new Error(`routing v2 migration ${diff.layer} input digest mismatch`);
    }
    if (canonicalDigest(withoutKey(root.value, target.key)) !== target.baseDigest) {
      throw new Error(`routing v2 migration ${diff.layer} base digest mismatch`);
    }
    if (canonicalDigest(diff.before) !== canonicalDigest(beforeLayer)) {
      throw new Error(`routing v2 migration ${diff.layer} diff before value mismatch`);
    }
    const writeRequired = routingV2Digest(beforeLayer) !== target.proposedDigest;
    if (target.writeRequired !== writeRequired) {
      throw new Error(`routing v2 migration ${diff.layer} write metadata mismatch`);
    }
  }
}

function mergeTarget(root: RootSnapshot, target: RoutingV2MigrationTarget): string {
  const next = { ...root.value };
  if (target.proposed === null) delete next[target.key];
  else next[target.key] = target.proposed;
  return `${JSON.stringify(next, null, 2)}\n`;
}

function rootFromConfigRead(file: string, read: ConfigReadResult): RootSnapshot {
  if (read.ok) return { file, existed: true, bytes: read.text, value: parseRoot(read.text, file) };
  if (read.reason === "absent") return { file, existed: false, bytes: "", value: {} };
  throw new Error(`${file} cannot be safely read (${read.reason})`);
}

function writeUserTarget(plan: RoutingV2MigrationPlan): void {
  const target = plan.targets.user;
  const outcome = updateConfigFile(target.file, (read) => {
    const current = rootFromConfigRead(target.file, read);
    if (targetState(current, target) !== "pending") throw new Error("routing v2 user configuration became stale during apply");
    return mergeTarget(current, target);
  });
  if (outcome !== "written") throw new Error(`routing v2 user configuration write ${outcome}`);
}

async function verifyStaged(plan: RoutingV2MigrationPlan): Promise<{ project: RootSnapshot; user: RootSnapshot }> {
  const [project, user] = await Promise.all([readRoot(plan.targets.project.file), readRoot(plan.targets.user.file)]);
  const projectState = targetState(project, plan.targets.project);
  const userState = targetState(user, plan.targets.user);
  if ((projectState !== "staged" && projectState !== "noop") || (userState !== "staged" && userState !== "noop")) {
    throw new Error("routing v2 staged configuration verification failed");
  }
  return { project, user };
}

function activeMarkerFor(plan: RoutingV2MigrationPlan, project: RootSnapshot, user: RootSnapshot): RoutingV2ActiveMarker {
  const projectFragmentDigest = plan.targets.project.proposedDigest;
  const userFragmentDigest = plan.targets.user.proposedDigest;
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    engineVersion: 2,
    migrationId: plan.migrationId,
    planDigest: plan.planDigest,
    activatedAt: new Date().toISOString(),
    projectRoot: plan.locations.projectRoot,
    configRoot: plan.locations.configRoot,
    revision: activeRevision(projectFragmentDigest, userFragmentDigest),
    targets: {
      project: {
        path: plan.targets.project.file,
        digest: sha256(project.bytes),
        fragmentDigest: projectFragmentDigest,
      },
      user: {
        path: plan.targets.user.file,
        digest: sha256(user.bytes),
        fragmentDigest: userFragmentDigest,
      },
    },
  };
}

function sameActivation(marker: RoutingV2ActivationMarker, plan: RoutingV2MigrationPlan): boolean {
  return marker.engineVersion === 2 && marker.migrationId === plan.migrationId && marker.planDigest === plan.planDigest;
}

function inactiveMigrationId(marker: RoutingV2RolledBackMarker | RoutingV2DeactivatedMarker): string {
  return "rolledBackMigrationId" in marker ? marker.rolledBackMigrationId : marker.deactivatedMigrationId;
}

/**
 * Switch future top-level turns to legacy without mutating either config.
 * Existing attempts keep their frozen engineVersion/configDigest snapshots.
 */
export async function deactivateRoutingV2(options: DeactivateRoutingV2Options): Promise<RoutingV2DeactivationResult> {
  if (!options.confirmed) throw new Error("explicit routing v2 deactivation confirmation is required");
  const projectRoot = normalizedRoot(options.cwd);
  const configRoot = normalizedConfigRoot(options.configDir);
  const activationFile = routingV2ActivationPath(projectRoot, configRoot);
  return withRoutingMutationLocks(activationFile, projectRoot, async () => {
    await recoverActiveRoutingV2Edit(activationFile, projectRoot, configRoot);
    const marker = readMarker(activationFile);
    if (marker === undefined) throw new Error("routing v2 is not active and has no activation marker");
    assertMarkerBinding(marker, projectRoot, configRoot);
    if (marker.engineVersion === 1) {
      await cleanupRollbackReadJournal(activationFile);
      return { status: "already-deactivated", migrationId: inactiveMigrationId(marker), activationFile };
    }
    const deactivated: RoutingV2DeactivatedMarker = {
      schemaVersion: MARKER_SCHEMA_VERSION,
      engineVersion: 1,
      deactivatedMigrationId: marker.migrationId,
      planDigest: marker.planDigest,
      deactivatedAt: new Date().toISOString(),
      projectRoot,
      configRoot,
    };
    await writeFileAtomic(activationFile, markerJson(deactivated), { mode: 0o600 });
    await cleanupRollbackReadJournal(activationFile);
    return { status: "deactivated", migrationId: marker.migrationId, activationFile };
  });
}

/** Apply a confirmed, unchanged plan transactionally; the marker is committed last. */
export async function applyRoutingV2Migration(plan: RoutingV2MigrationPlan, options: ApplyRoutingV2MigrationOptions): Promise<RoutingV2MigrationResult> {
  assertApplicablePlan(plan, options.confirmed, options.cwd, options.configDir, options.normalization);
  return withRoutingMutationLocks(plan.locations.activationFile, plan.locations.projectRoot, async () => {
    await recoverActiveRoutingV2Edit(plan.locations.activationFile, plan.locations.projectRoot, plan.locations.configRoot);
    const currentMarker = readMarker(plan.locations.activationFile);
    if (currentMarker !== undefined) {
      assertMarkerBinding(currentMarker, plan.locations.projectRoot, plan.locations.configRoot);
      if (sameActivation(currentMarker, plan)) {
        readActiveRoutingV2Layers(plan.locations.projectRoot, plan.locations.configRoot, options.normalization);
        return { status: "already-applied", migrationId: plan.migrationId, activationFile: plan.locations.activationFile };
      }
      if (currentMarker.engineVersion === 2) {
        throw new Error("another routing v2 migration is active; roll it back before reconfiguration");
      }
      await cleanupRollbackReadJournal(plan.locations.activationFile);
      // An engineVersion=1 marker is explicit legacy state, not an activation.
      // A fresh, reviewed plan may replace it after the ordinary stale checks.
    }

    const [project, user] = await Promise.all([readRoot(plan.targets.project.file), readRoot(plan.targets.user.file)]);
    const projectState = targetState(project, plan.targets.project);
    const userState = targetState(user, plan.targets.user);
    if (projectState === "stale" || userState === "stale") throw new Error("routing v2 migration plan is stale");
    const backup = await ensureBackup(plan, project, user, [projectState, userState]);
    if (projectState === "staged" || userState === "staged") {
      const [originalProject, originalUser] = await Promise.all([
        originalRoot(backup.targets.project),
        originalRoot(backup.targets.user),
      ]);
      assertOriginalPlanConsistency(plan, originalProject, originalUser, options.normalization);
    } else {
      assertOriginalPlanConsistency(plan, project, user, options.normalization);
    }
    await options.fault?.("after-backup");

    if (projectState === "pending") {
      const currentProject = await readRoot(plan.targets.project.file);
      if (targetState(currentProject, plan.targets.project) !== "pending") throw new Error("routing v2 project configuration became stale during apply");
      await writeFileAtomic(plan.targets.project.file, mergeTarget(currentProject, plan.targets.project));
    }
    await options.fault?.("after-project-write");
    if (userState === "pending") writeUserTarget(plan);
    await options.fault?.("after-user-write");

    await verifyStaged(plan);
    await options.fault?.("before-activation");
    const finalStaged = await verifyStaged(plan);
    ensureKeryxSubdir(["routing-v2", "activations"], plan.locations.configRoot);
    await writeFileAtomic(plan.locations.activationFile, markerJson(activeMarkerFor(plan, finalStaged.project, finalStaged.user)), { mode: 0o600 });
    readActiveRoutingV2Layers(plan.locations.projectRoot, plan.locations.configRoot, options.normalization);
    return { status: "applied", migrationId: plan.migrationId, activationFile: plan.locations.activationFile };
  });
}

async function backupBytes(target: BackupTarget): Promise<string | undefined> {
  if (!target.existed) {
    return undefined;
  }
  const bytes = await readFile(target.backupFile, "utf8");
  if (sha256(bytes) !== target.digest) throw new Error(`routing v2 backup digest mismatch for ${target.path}`);
  return bytes;
}

async function restoreProjectBackup(target: BackupTarget, activatedDigest: string): Promise<void> {
  const bytes = await backupBytes(target);
  const current = await readRoot(target.path);
  if (sha256(current.bytes) !== activatedDigest) throw new Error("routing v2 project configuration changed during rollback");
  if (bytes === undefined) await rm(target.path, { force: true });
  else await writeFileAtomic(target.path, bytes);
}

async function restoreUserBackup(target: BackupTarget, activatedDigest: string): Promise<void> {
  const bytes = await backupBytes(target);
  if (bytes !== undefined) {
    const outcome = updateConfigFile(target.path, (read) => {
      const current = rootFromConfigRead(target.path, read);
      if (sha256(current.bytes) !== activatedDigest) throw new Error("routing v2 user configuration changed during rollback");
      return bytes;
    });
    if (outcome !== "written") throw new Error(`routing v2 user rollback write ${outcome}`);
    return;
  }
  const removed = withConfigFileLock(`${target.path}.lock`, () => {
    const read = readConfigFile(target.path);
    const current = rootFromConfigRead(target.path, read);
    if (sha256(current.bytes) !== activatedDigest) throw new Error("routing v2 user configuration changed during rollback");
    rmSync(target.path, { force: true });
    return true;
  });
  if (removed !== true) throw new Error("routing v2 user rollback could not acquire the configuration lock");
}

type RollbackTargetState = "active" | "restored" | "stale";

function rollbackTargetState(current: RootSnapshot, activatedDigest: string, backup: BackupTarget): RollbackTargetState {
  const digest = sha256(current.bytes);
  if (digest === activatedDigest) return "active";
  if (digest === backup.digest && current.existed === backup.existed) return "restored";
  return "stale";
}

/** Restore exact pre-migration bytes and switch future turns back to legacy. */
export async function rollbackRoutingV2Migration(plan: RoutingV2MigrationPlan, options: RollbackRoutingV2MigrationOptions): Promise<RoutingV2MigrationResult> {
  assertApplicablePlan(plan, options.confirmed, options.cwd, options.configDir, options.normalization);
  return withRoutingMutationLocks(plan.locations.activationFile, plan.locations.projectRoot, async () => {
    await recoverActiveRoutingV2Edit(plan.locations.activationFile, plan.locations.projectRoot, plan.locations.configRoot);
    const marker = readMarker(plan.locations.activationFile);
    if (marker === undefined) throw new Error("routing v2 migration is not active");
    assertMarkerBinding(marker, plan.locations.projectRoot, plan.locations.configRoot);
    if (marker.engineVersion === 1) {
      if (inactiveMigrationId(marker) === plan.migrationId && marker.planDigest === plan.planDigest && "rolledBackMigrationId" in marker) {
        await cleanupRollbackReadJournal(plan.locations.activationFile);
        return { status: "already-rolled-back", migrationId: plan.migrationId, activationFile: plan.locations.activationFile };
      }
      throw new Error("routing v2 is inactive; exact rollback requires its active marker");
    }
    if (!sameActivation(marker, plan)) throw new Error("routing v2 active marker does not match this migration plan");
    if (marker.lastEditId !== undefined) {
      throw new Error("routing v2 settings were edited after migration; exact rollback refused, use deactivation to preserve them");
    }
    const manifest = await readBackupManifest(plan);
    if (manifest === undefined) throw new Error("routing v2 migration backup manifest is missing");
    const [project, user] = await Promise.all([readRoot(marker.targets.project.path), readRoot(marker.targets.user.path)]);
    const projectState = rollbackTargetState(project, marker.targets.project.digest, manifest.targets.project);
    const userState = rollbackTargetState(user, marker.targets.user.digest, manifest.targets.user);
    if (projectState === "stale" || userState === "stale") {
      throw new Error("routing v2 configuration changed after activation; rollback refused");
    }
    await ensureRollbackReadJournal(
      plan.locations.activationFile,
      marker,
      project,
      user,
      [projectState, userState],
    );
    if (projectState === "active") await restoreProjectBackup(manifest.targets.project, marker.targets.project.digest);
    await options.fault?.("after-project-restore");
    if (userState === "active") await restoreUserBackup(manifest.targets.user, marker.targets.user.digest);
    await options.fault?.("after-user-restore");
    const rolledBack: RoutingV2RolledBackMarker = {
      schemaVersion: MARKER_SCHEMA_VERSION,
      engineVersion: 1,
      rolledBackMigrationId: plan.migrationId,
      planDigest: plan.planDigest,
      rolledBackAt: new Date().toISOString(),
      projectRoot: plan.locations.projectRoot,
      configRoot: plan.locations.configRoot,
    };
    await options.fault?.("before-rollback-marker");
    await writeFileAtomic(plan.locations.activationFile, markerJson(rolledBack), { mode: 0o600 });
    await cleanupRollbackReadJournal(plan.locations.activationFile);
    return { status: "rolled-back", migrationId: plan.migrationId, activationFile: plan.locations.activationFile };
  });
}

export interface ProposeRoutingV2CategoriesOptions {
  readonly subagentModelOverride?: string;
}

export interface ProposedRoutingV2Categories {
  readonly categories: Readonly<Record<RoutingCategory, RoutingAssignmentV2>>;
  readonly unresolved: readonly RoutingV2MigrationUnresolved[];
}

/** Conservative legacy mapping: ambiguity is reported, never guessed. */
export function proposeRoutingV2Categories(table: RoutingTable, options: ProposeRoutingV2CategoriesOptions = {}): ProposedRoutingV2Categories {
  const categories = {} as Record<RoutingCategory, RoutingAssignmentV2>;
  const unresolved: RoutingV2MigrationUnresolved[] = [];
  for (const category of ROUTING_CATEGORIES) {
    const assignment = table[category];
    if (assignment === undefined || assignment.kind === "session-default") {
      categories[category] = { mode: "baseline" };
    } else if (assignment.kind === "model") {
      categories[category] = { mode: "model", target: { providerId: assignment.providerId, modelId: assignment.modelId } };
    } else {
      categories[category] = { mode: "baseline" };
      unresolved.push({
        code: "provider-default",
        category,
        message: `legacy provider-default for ${assignment.providerId} must be materialized as a model or class`,
      });
    }
  }
  const override = options.subagentModelOverride?.trim();
  if (override !== undefined && override.length > 0 && override !== "inherit") {
    unresolved.push({
      code: "subagent-model-override",
      message: "KERYX_SUBAGENT_MODEL must be converted to an explicit scoped v2 assignment before activation",
    });
  }
  return { categories, unresolved };
}
