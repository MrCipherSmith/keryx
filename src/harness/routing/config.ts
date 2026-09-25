// Flow 305 (Flow A), AC2 — the routing table's two config layers:
// `routing.config.json` at the project root, and a per-user entry alongside
// `apiKeys`/`openrouterKey` in shell config (`src/lib/shell-config.ts`).
//
// Same "config file + schema validation" pattern `src/security/config.ts`
// already uses for `security.config.json`: an ABSENT file is the ordinary
// "never configured" case (an empty table); a file that EXISTS but cannot be
// read as one — invalid JSON, JSON that is not a plain object, or a category
// entry that does not match the `CategoryAssignment` shape — is a NAMED,
// SURFACED error, never a silently empty table.
import path from "node:path";
import { pathExists, writeFileAtomic } from "../../lib/fs";
import { readJsonObjectFile } from "../../lib/json";
import { loadShellConfig, saveShellConfig } from "../../lib/shell-config";
import { isRoutingCategory, ROUTING_CATEGORIES, type CategoryAssignment, type RoutingCategory, type RoutingTable } from "./table";

/** The two layers a config file/entry can be read from or written to. */
export type RoutingConfigLayer = "project" | "user";

/**
 * Where each layer's config lives. `cwd` (the project layer) and the per-user
 * config dir (`userConfigDir`) are DIFFERENT directories in production — a
 * project's `routing.config.json` sits at the project root, the per-user
 * entry sits in the OPERATOR's global `auth.json`
 * (`~/.local/share/keryx`, `src/lib/config-dir.ts`), which has nothing to do
 * with which project happens to be open. Collapsing both onto one `dir`
 * parameter (an earlier draft of this module did) would make `loadShellConfig`
 * read/write `<project root>/auth.json` instead of the real per-user file —
 * silently pointing every `keryx routing set` at the wrong store. `userConfigDir`
 * is the SAME test seam `loadShellConfig`/`saveShellConfig` already take
 * (`dir?: string`, `shell-config.ts`) — omitted in production, so the user
 * layer resolves to the real global config; a test overrides it to a temp
 * directory independently of whatever `cwd` it also uses for the project layer.
 */
export interface RoutingConfigLocation {
  /** Project root — the "project" layer's `routing.config.json` lives here. */
  readonly cwd: string;
  /** Per-user config dir override (test seam only) — the "user" layer. */
  readonly userConfigDir?: string;
}

export interface RoutingConfigResult {
  readonly table: RoutingTable;
  /**
   * Set when the file/entry EXISTS but could not be read as a routing table —
   * invalid JSON, a non-object payload, or a category entry that fails
   * validation. `table` is still the best-effort partial parse (valid
   * categories kept, invalid ones dropped) so one bad entry never blanks the
   * whole layer, but `error` must be surfaced by every caller rather than
   * treated as "nothing configured".
   */
  readonly error?: string;
}

/** `routing.config.json` at the project root (sibling to the project's `.metaproject/`, per AC2). */
export function projectRoutingConfigPath(cwd: string): string {
  return path.join(cwd, "routing.config.json");
}

/** One `CategoryAssignment`'s validation error, or `undefined` when it is well-shaped. */
function validateAssignment(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "must be an object";
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "session-default") return undefined;
  if (kind === "model") {
    const providerId = (value as { providerId?: unknown }).providerId;
    const modelId = (value as { modelId?: unknown }).modelId;
    if (typeof providerId !== "string" || providerId.length === 0) return "model.providerId must be a non-empty string";
    if (typeof modelId !== "string" || modelId.length === 0) return "model.modelId must be a non-empty string";
    return undefined;
  }
  if (kind === "provider-default") {
    const providerId = (value as { providerId?: unknown }).providerId;
    if (typeof providerId !== "string" || providerId.length === 0) return "provider-default.providerId must be a non-empty string";
    return undefined;
  }
  return `unknown kind ${JSON.stringify(kind)}`;
}

/**
 * Validate a raw `{categories: {...}}` payload into a `RoutingTable`. Unknown
 * top-level keys are ignored (forward compatibility); an unknown category name
 * or a malformed assignment is dropped from the result AND reported in the
 * returned error list — never silently kept or silently discarded with no
 * trace.
 */
export function validateRoutingConfig(raw: unknown): { table: RoutingTable; errors: string[] } {
  const table: RoutingTable = {};
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { table, errors: ["routing config must be a JSON object"] };
  }
  const categories = (raw as { categories?: unknown }).categories;
  if (categories === undefined) {
    return { table, errors };
  }
  if (typeof categories !== "object" || categories === null || Array.isArray(categories)) {
    return { table, errors: ["categories must be an object"] };
  }
  for (const [key, value] of Object.entries(categories as Record<string, unknown>)) {
    if (!isRoutingCategory(key)) {
      errors.push(`unknown category "${key}" (expected one of ${ROUTING_CATEGORIES.join(", ")})`);
      continue;
    }
    const assignmentError = validateAssignment(value);
    if (assignmentError !== undefined) {
      errors.push(`categories.${key}: ${assignmentError}`);
      continue;
    }
    table[key] = value as CategoryAssignment;
  }
  return { table, errors };
}

/** Render a `RoutingTable` back to the on-disk/on-config `{categories: {...}}` shape. */
export function renderRoutingConfig(table: RoutingTable): { categories: RoutingTable } {
  return { categories: table };
}

/**
 * Read one layer's routing table. Never throws. An absent project file or an
 * absent/empty user entry is `{table: {}}` — the ordinary "never configured"
 * case — not an error.
 */
export async function loadRoutingConfig(layer: RoutingConfigLayer, location: RoutingConfigLocation): Promise<RoutingConfigResult> {
  if (layer === "user") {
    const raw = loadShellConfig(location.userConfigDir).routing;
    if (raw === undefined) return { table: {} };
    // `ShellConfig.routing` stores the bare category map (no `{categories}`
    // envelope — it already lives under its OWN `routing` key inside
    // `auth.json`, alongside `apiKeys`/`modelParams`). `validateRoutingConfig`
    // validates the project file's self-describing `{categories: {...}}`
    // shape; wrap here so both layers share the one validator.
    const { table, errors } = validateRoutingConfig({ categories: raw });
    return errors.length > 0 ? { table, error: errors.join("; ") } : { table };
  }
  const file = projectRoutingConfigPath(location.cwd);
  if (!(await pathExists(file))) {
    return { table: {} };
  }
  const read = await readJsonObjectFile(file);
  if (read.state !== "object") {
    return { table: {}, error: `${file} could not be read as JSON (state: ${read.state})` };
  }
  const { table, errors } = validateRoutingConfig(read.value);
  return errors.length > 0 ? { table, error: `${file}: ${errors.join("; ")}` } : { table };
}

/**
 * Write one layer's routing table. The user layer merges into the existing
 * shell config (like every other `saveShellConfig` caller); the project layer
 * overwrites `routing.config.json` atomically (mirrors
 * `renderSecurityConfig`'s "config file, freshly rendered" writer).
 */
export async function saveRoutingConfig(layer: RoutingConfigLayer, location: RoutingConfigLocation, table: RoutingTable): Promise<void> {
  if (layer === "user") {
    saveShellConfig({ routing: table }, location.userConfigDir);
    return;
  }
  const file = projectRoutingConfigPath(location.cwd);
  const body = `${JSON.stringify(renderRoutingConfig(table), null, 2)}\n`;
  await writeFileAtomic(file, body);
}

/** Set one category's assignment in a layer, preserving every other category already set there. */
export async function setRoutingCategory(
  layer: RoutingConfigLayer,
  location: RoutingConfigLocation,
  category: RoutingCategory,
  assignment: CategoryAssignment,
): Promise<void> {
  const current = await loadRoutingConfig(layer, location);
  await saveRoutingConfig(layer, location, { ...current.table, [category]: assignment });
}

/** Clear one category back to unset (`session-default` falls through to it) in a layer. */
export async function unsetRoutingCategory(layer: RoutingConfigLayer, location: RoutingConfigLocation, category: RoutingCategory): Promise<void> {
  const current = await loadRoutingConfig(layer, location);
  const { [category]: _removed, ...rest } = current.table;
  await saveRoutingConfig(layer, location, rest);
}
