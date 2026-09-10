// The WRITE seam for native MCP-server config.
//
// P0 item 7. `config.ts` reads every layer and never writes; this writes, and
// only ever to the two native files. The split is deliberate: the compat
// sources (Cursor, Claude, `.mcp.json`, Grok TOML) are read-only by
// specification, and a writer that shared a module with the reader is one
// refactor away from rewriting a file keryx does not own.
//
// What it will not do:
//   - write into a compat source — `remove` on a compat-only name errors and
//     says which file to edit instead;
//   - write `enabled: false` into a committed project file — that is what the
//     personal overlay is for;
//   - write `.metaproject/core/mcp/mcp.config.json`, which belongs to the
//     inbound `keryx serve-mcp` surface entirely.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ensureKeryxConfigDir,
  isDefiniteAbsence,
  readConfigFile,
  writeOwnerOnlyFileAtomic,
} from "../lib/config-dir";
import type { McpDisableOverlay, McpServerEntry } from "./config";

export type McpScope = "user" | "project";

/** Names the specification allows, and the CLI must refuse before writing. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export type StoreTargets = {
  /** Overridden in tests; defaults to the real user config directory. */
  readonly configDir?: string | undefined;
  /** Project root for `--scope project`. The file is `<root>/.keryx/mcp-servers.json`. */
  readonly projectRoot?: string | undefined;
};

export function userConfigFile(configDir?: string): string {
  return path.join(configDir ?? ensureKeryxConfigDir(), "mcp-servers.json");
}

export function projectConfigFile(projectRoot: string): string {
  return path.join(projectRoot, ".keryx", "mcp-servers.json");
}

export function overlayFile(configDir?: string): string {
  return path.join(configDir ?? ensureKeryxConfigDir(), "mcp-servers-disabled.json");
}

/**
 * A write that did not happen, described.
 *
 * Returned rather than thrown so every caller has to look at it. The CLI turns
 * it into an exit code and a line; a thrown error would let a caller that
 * forgot a `try` report success for a write that never landed — the defect
 * class this package keeps finding.
 */
export type StoreResult =
  | { readonly ok: true; readonly file: string; readonly created: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * The file as it will be written back.
 *
 * The index signature is not slack: a rewrite that keeps only the keys this
 * code knows about would silently delete anything a future schema version, or
 * the operator, put beside `servers` — a comment, a `$schema` pointer, a field
 * a newer keryx writes and an older one is asked to edit. Round-tripping the
 * rest costs one spread.
 */
type Document = {
  schemaVersion: number;
  servers: Record<string, McpServerEntry>;
  [key: string]: unknown;
};

/**
 * Read one native file for rewriting.
 *
 * An unreadable or malformed file is refused, NOT replaced. Overwriting it
 * would be the one moment where `keryx mcp add` silently destroys hand-written
 * config — including the servers it could not parse — and the operator would
 * discover it by noticing something missing later.
 */
function readForWrite(file: string): { doc: Document; existed: boolean } | { error: string } {
  const read = readConfigFile(file);
  if (!read.ok) {
    return isDefiniteAbsence(read.reason)
      ? { doc: { schemaVersion: 1, servers: {} }, existed: false }
      : { error: `${file} could not be read (${read.reason}); nothing was written` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch (error) {
    return {
      error: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); nothing was written. Fix it by hand first.`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${file} is not a JSON object; nothing was written` };
  }

  const doc = parsed as Partial<Document>;
  const servers = doc.servers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    return { error: `${file} has a \`servers\` that is not an object; nothing was written` };
  }

  return {
    doc: {
      // Spread FIRST, so every other top-level key the operator wrote
      // round-trips, and the two keys this code owns still win.
      ...(parsed as Record<string, unknown>),
      schemaVersion: typeof doc.schemaVersion === "number" ? doc.schemaVersion : 1,
      servers: { ...(servers as Record<string, McpServerEntry> | undefined) },
    },
    existed: true,
  };
}

function writeDocument(file: string, doc: Document, scope: McpScope): void {
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  if (scope === "user") {
    // Owner-only: the user config dir holds credentials-adjacent material and
    // `env` values here can be secrets.
    writeOwnerOnlyFileAtomic(file, body);
    return;
  }
  // The project file is committed and read by whoever checks the repo out;
  // forcing 0600 on it would make it unreadable to a second account on a
  // shared machine and would be a permission the operator never asked for.
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, { encoding: "utf8" });
}

export type AddOptions = {
  readonly name: string;
  readonly entry: McpServerEntry;
  readonly scope: McpScope;
  /** Replace an existing entry of the same name instead of refusing. */
  readonly force?: boolean;
} & StoreTargets;

/**
 * Write one server into the native file for its scope.
 *
 * Refuses an existing name unless `force`. Silently replacing would make
 * `add` a same-named overwrite of a server the operator may have spent an
 * afternoon getting to connect, with no record of what it was.
 */
export function addServer(options: AddOptions): StoreResult {
  if (!SERVER_NAME_PATTERN.test(options.name)) {
    return { ok: false, error: `server name "${options.name}" must match ${SERVER_NAME_PATTERN.source}` };
  }
  const file = fileForScope(options.scope, options);
  if (typeof file !== "string") return file;

  const loaded = readForWrite(file);
  if ("error" in loaded) return { ok: false, error: loaded.error };

  if (loaded.doc.servers[options.name] !== undefined && options.force !== true) {
    return {
      ok: false,
      error: `server "${options.name}" already exists in ${file}. Pass --force to replace it, or remove it first.`,
    };
  }

  loaded.doc.servers[options.name] = options.entry;
  writeDocument(file, loaded.doc, options.scope);
  return { ok: true, file, created: !loaded.existed };
}

export type RemoveOptions = { readonly name: string; readonly scope: McpScope } & StoreTargets;

/** Delete a native entry. A name that is not in this scope's file is an error, not a no-op. */
export function removeServer(options: RemoveOptions): StoreResult {
  const file = fileForScope(options.scope, options);
  if (typeof file !== "string") return file;

  const loaded = readForWrite(file);
  if ("error" in loaded) return { ok: false, error: loaded.error };

  if (loaded.doc.servers[options.name] === undefined) {
    return { ok: false, error: `server "${options.name}" is not defined in ${file}` };
  }

  delete loaded.doc.servers[options.name];
  writeDocument(file, loaded.doc, options.scope);
  return { ok: true, file, created: false };
}

export type SetEnabledOptions = { readonly name: string; readonly enabled: boolean } & StoreTargets;

/**
 * Toggle a server through the PERSONAL overlay, and clear a sticky flag only
 * where clearing it is personal.
 *
 * Two writes, and the second is conditional:
 *
 *   1. the overlay always records the operator's choice, which is what lets
 *      `enable` lift an `enabled: false` a committed project file set;
 *   2. a matching `enabled` in the USER native file is deleted, because a
 *      stale flag there would be a second, invisible source of the same
 *      answer.
 *
 * The project file is never touched. Toggling a server for yourself must not
 * produce a diff for everyone — Grok Build's rule, and the reason the overlay
 * exists at all.
 */
export function setServerEnabled(options: SetEnabledOptions): StoreResult {
  const file = overlayFile(options.configDir);

  const read = readConfigFile(file);
  let overlay: McpDisableOverlay = {};
  if (read.ok) {
    try {
      const parsed = JSON.parse(read.text) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        overlay = parsed as McpDisableOverlay;
      }
    } catch {
      // A broken overlay is replaced rather than refused: unlike a config
      // file, it holds no server the operator authored — only toggles — so
      // the worst case is losing preferences that can be re-set in one
      // command, and refusing would leave `disable` permanently unusable.
      overlay = {};
    }
  } else if (!isDefiniteAbsence(read.reason)) {
    return { ok: false, error: `${file} could not be read (${read.reason}); nothing was written` };
  }

  const overrides = { ...overlay.overrides, [options.name]: options.enabled };
  writeOwnerOnlyFileAtomic(file, `${JSON.stringify({ ...overlay, overrides }, null, 2)}\n`);

  clearStickyUserFlag(options.name, options.enabled, options.configDir);
  return { ok: true, file, created: !read.ok };
}

/**
 * Delete `enabled` from the user native file, if it has one for this name.
 *
 * Best-effort by design: the overlay write above is the operation, and this is
 * hygiene. A user file that cannot be parsed is left exactly as it is rather
 * than failing a toggle that already succeeded.
 */
function clearStickyUserFlag(name: string, enabled: boolean, configDir?: string): void {
  const file = userConfigFile(configDir);
  const loaded = readForWrite(file);
  if ("error" in loaded) return;
  const entry = loaded.doc.servers[name];
  if (entry === undefined) return;
  // Only a flag that CONTRADICTS the new choice is stale. Deleting
  // `enabled` whatever its value destroyed a user-scope preference that was
  // not even in play — `enable` aimed at a project-scope server of the same
  // name removed `enabled: false` from the user entry, so removing the
  // overlay later brought a server back that the operator had switched off
  // in a file they wrote.
  if (entry.enabled === undefined || entry.enabled === enabled) return;
  delete entry.enabled;
  writeDocument(file, loaded.doc, "user");
}

function fileForScope(
  scope: McpScope,
  targets: StoreTargets,
): string | { ok: false; error: string } {
  if (scope === "user") return userConfigFile(targets.configDir);
  if (targets.projectRoot === undefined) {
    return { ok: false, error: "--scope project needs a project root; none was resolved" };
  }
  return projectConfigFile(targets.projectRoot);
}
