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
import { isProjectRoutingApproved, ROUTING_TRUST_NOTICE } from "./trust";

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
   * A human-readable reason to surface, set when either:
   *  - the file/entry EXISTS but could not be read as a routing table —
   *    invalid JSON, a non-object payload, or a category entry that fails
   *    validation. `table` is still the best-effort partial parse (valid
   *    categories kept, invalid ones dropped) so one bad entry never blanks
   *    the whole layer.
   *  - (project layer only, AC11) the file is well-formed but UNAPPROVED —
   *    same text as `untrusted`, below, which a caller can also check
   *    directly when it needs to distinguish the two cases.
   * Either way, `error` must be surfaced by every caller rather than treated
   * as "nothing configured".
   */
  readonly error?: string;
  /**
   * AC11 — set (project layer only) when the file parses and validates fine
   * but its CURRENT content has not been approved via `keryx routing trust`
   * (or was approved for a since-changed content). `table` is EMPTY in this
   * state — the entries are ignored, not merely flagged — so every existing
   * caller that reads `.table` without checking this flag already gets the
   * safe behavior; callers that want to show the notice check this flag.
   */
  readonly untrusted?: boolean;
}

/** `routing.config.json` at the project root (sibling to the project's `.metaproject/`, per AC2). */
export function projectRoutingConfigPath(cwd: string): string {
  return path.join(cwd, "routing.config.json");
}

/** One `CategoryAssignment`'s validation error, or `undefined` when it is well-shaped. */
const ASSIGNMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  "session-default": ["kind"],
  model: ["kind", "providerId", "modelId"],
  "provider-default": ["kind", "providerId"],
};

function validateAssignment(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "must be an object";
  const kind = (value as { kind?: unknown }).kind;
  // An assignment carries only the fields its kind defines: an extra key (a
  // stray baseUrl, say) is refused rather than carried along unvalidated for
  // some later reader to trust.
  const allowed = typeof kind === "string" ? ASSIGNMENT_KEYS[kind] : undefined;
  if (allowed !== undefined) {
    const extra = Object.keys(value).filter((key) => !allowed.includes(key));
    if (extra.length > 0) return `unexpected field${extra.length > 1 ? "s" : ""} ${extra.map((key) => JSON.stringify(key)).join(", ")} for kind ${JSON.stringify(kind)}`;
  }
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
 * Read one layer's routing table AS WRITTEN — no AC11 trust gate applied.
 * Never throws. An absent project file or an absent/empty user entry is
 * `{table: {}}` — the ordinary "never configured" case — not an error.
 *
 * This is the merge base `setRoutingCategory`/`unsetRoutingCategory` read
 * before writing: a project file the operator has not yet approved still
 * physically holds whatever OTHER categories were already set in it, and a
 * `keryx routing set <cat> ... --project` on top of it must not silently
 * discard them just because AC11 hides them from ordinary reads. Approval
 * status is a DISPLAY/RESOLUTION concern, not a data-loss switch.
 */
export async function loadRoutingConfigRaw(layer: RoutingConfigLayer, location: RoutingConfigLocation): Promise<RoutingConfigResult> {
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
 * Read one layer's routing table for RESOLUTION/DISPLAY (AC1-AC9's original
 * contract, plus AC11's trust gate on the project layer): a well-formed
 * project table takes effect only once the operator has approved its CURRENT
 * content (`keryx routing trust`). Unapproved (or approved-then-edited) ->
 * the entries are ignored outright, exactly as if the project layer had
 * nothing configured, with `untrusted: true` and a notice in `error` for
 * callers that want to show it. The user layer has no trust gate (it is the
 * operator's own global config, not a file a repository can commit).
 */
export async function loadRoutingConfig(layer: RoutingConfigLayer, location: RoutingConfigLocation): Promise<RoutingConfigResult> {
  const raw = await loadRoutingConfigRaw(layer, location);
  if (layer === "user" || Object.keys(raw.table).length === 0) {
    return raw;
  }
  // The trust check runs on whatever survived validation, even when some other
  // entry in the same file was malformed: a partial parse still carries live
  // entries, and a stray invalid line must never switch the approval gate off.
  if (!isProjectRoutingApproved(location.cwd, raw.table, location.userConfigDir)) {
    const notice = raw.error !== undefined ? `${raw.error}; ${ROUTING_TRUST_NOTICE}` : ROUTING_TRUST_NOTICE;
    return { table: {}, untrusted: true, error: notice };
  }
  return raw;
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

/**
 * Set one category's assignment in a layer, preserving every other category
 * already set there. Merges against `loadRoutingConfigRaw` (AC11 note on that
 * function): an unapproved project file's OTHER entries must survive a write
 * that only meant to add or change one category.
 */
export async function setRoutingCategory(
  layer: RoutingConfigLayer,
  location: RoutingConfigLocation,
  category: RoutingCategory,
  assignment: CategoryAssignment,
): Promise<void> {
  const current = await loadRoutingConfigRaw(layer, location);
  await saveRoutingConfig(layer, location, { ...current.table, [category]: assignment });
}

/** Clear one category back to unset (`session-default` falls through to it) in a layer. Same raw-merge-base note as `setRoutingCategory`. */
export async function unsetRoutingCategory(layer: RoutingConfigLayer, location: RoutingConfigLocation, category: RoutingCategory): Promise<void> {
  const current = await loadRoutingConfigRaw(layer, location);
  const { [category]: _removed, ...rest } = current.table;
  await saveRoutingConfig(layer, location, rest);
}
