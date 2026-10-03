// Bot token and remote-control config loading (flow 376, block 1).
//
// The token is a global secret: one file in the user-global directory, mode 600,
// outside every repository and sandbox. It is read here and handed to
// `createHttpBotApi`; it is never returned from a function that also returns
// text for display, never put in a thrown message and never written anywhere.
// Every failure below is a `reason` string built from fixed words and the FILE
// PATH, never from file content, so a malformed token file cannot leak through
// its own diagnostic.
//
// Config (allowlist, supergroup id, timeouts) is a small JSON file next to it,
// validated against a closed schema: an unknown key is an error, so a token
// pasted into the wrong file is rejected rather than stored.

import { statSync, unlinkSync } from "node:fs";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { botTokenPath, ensureRemoteDir, remoteConfigPath } from "./paths";
import { isRenderMode, RENDER_MODE_CHOICES, type RenderMode } from "./rendering-mode";

export const REMOTE_CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_ORPHAN_MS = 10 * 60_000;
/** Flow 396: a run started from Telegram has no time limit unless `runTimeoutMs` says otherwise; `/stop` ends it. */
export const DEFAULT_RUN_TIMEOUT_MS = 0;
/** The limit before flow 396, kept so a rollback has a named value (release note, docs, tests). */
export const LEGACY_RUN_TIMEOUT_MS = 30 * 60_000;
/** How long a Telegram approval prompt waits for a tap before it is denied (flow 396: 15 minutes). */
export const DEFAULT_APPROVAL_WAIT_MS = 15 * 60_000;
/** The wait before flow 396, kept for the rollback note. */
export const LEGACY_APPROVAL_WAIT_MS = 5 * 60_000;
export const MIN_APPROVAL_WAIT_MS = 30_000;
export const MAX_APPROVAL_WAIT_MS = 60 * 60_000;
/** The mode a Telegram-started turn starts with until `/mode` changes the shell's mode (flow 396). */
export type RemotePermissionMode = "ask" | "trust";
export const DEFAULT_REMOTE_PERMISSION_MODE: RemotePermissionMode = "trust";
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

export interface RemoteConfig {
  schemaVersion: typeof REMOTE_CONFIG_SCHEMA_VERSION;
  /** The supergroup (forum) the session topics are created in. */
  chatId: number;
  /** Telegram user ids whose messages and button presses are accepted. */
  allowedUserIds: number[];
  /** How long an unavailable session's topic is kept before deletion. */
  orphanMs: number;
  /** How long a run started from Telegram may take before the shell interrupts it; 0 means no limit. */
  runTimeoutMs: number;
  /**
   * The permission mode a Telegram-started turn starts with while the shell's own mode has not been
   * changed by `/mode` in this session. `auto` is not accepted here.
   */
  permissionMode: RemotePermissionMode;
  /** How long a Telegram approval prompt waits for an answer before it is denied. */
  approvalTimeoutMs: number;
  /**
   * How a reply is written for Telegram (flow 395): auto | rich | html | plain. Left out of the
   * file means `auto`; a reader applies `DEFAULT_RENDER_MODE`, so a config that never set it is
   * written back unchanged.
   */
  rendering?: RenderMode;
}

/** What a caller may hand to `saveRemoteConfig`: the two flow-396 keys are optional and default when absent. */
export type RemoteConfigInput = Omit<RemoteConfig, "permissionMode" | "approvalTimeoutMs"> &
  Partial<Pick<RemoteConfig, "permissionMode" | "approvalTimeoutMs">>;

export type Loaded<T> = { ok: true; value: T } | { ok: false; reason: string };

const CONFIG_KEYS = new Set([
  "schemaVersion",
  "chatId",
  "allowedUserIds",
  "orphanMs",
  "runTimeoutMs",
  "permissionMode",
  "approvalTimeoutMs",
  "rendering",
]);
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Validate a parsed config document against the closed schema. */
export function parseRemoteConfig(value: unknown): Loaded<RemoteConfig> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "remote config must be a JSON object" };
  }
  const doc = value as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!CONFIG_KEYS.has(key)) {
      const shown = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(key) ? key : "<not shown>";
      return { ok: false, reason: `remote config has an unknown key "${shown}" (the schema is closed)` };
    }
  }
  if (doc.schemaVersion !== REMOTE_CONFIG_SCHEMA_VERSION) {
    return { ok: false, reason: `remote config schemaVersion must be ${REMOTE_CONFIG_SCHEMA_VERSION}` };
  }
  if (!isSafeInt(doc.chatId) || doc.chatId === 0) {
    return { ok: false, reason: "remote config chatId must be a non-zero integer (the supergroup id)" };
  }
  const ids = doc.allowedUserIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => isSafeInt(id) && id > 0)) {
    return { ok: false, reason: "remote config allowedUserIds must be a non-empty array of positive integers" };
  }
  const timeout = (key: "orphanMs" | "runTimeoutMs", fallback: number): Loaded<number> => {
    const raw = doc[key];
    if (raw === undefined) {
      return { ok: true, value: fallback };
    }
    if (!isSafeInt(raw) || raw < 1 || raw > MAX_TIMEOUT_MS) {
      return { ok: false, reason: `remote config ${key} must be an integer from 1 to ${MAX_TIMEOUT_MS} (milliseconds)` };
    }
    return { ok: true, value: raw };
  };
  const orphan = timeout("orphanMs", DEFAULT_ORPHAN_MS);
  if (!orphan.ok) {
    return orphan;
  }
  let runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS;
  if (doc.runTimeoutMs !== undefined) {
    // 0 means "no limit" (flow 396); anything else is a real limit in milliseconds.
    if (doc.runTimeoutMs === 0) {
      runTimeoutMs = 0;
    } else {
      const run = timeout("runTimeoutMs", DEFAULT_RUN_TIMEOUT_MS);
      if (!run.ok) {
        return { ok: false, reason: `remote config runTimeoutMs must be 0 (no limit) or an integer from 1 to ${MAX_TIMEOUT_MS} (milliseconds)` };
      }
      runTimeoutMs = run.value;
    }
  }
  let permissionMode: RemotePermissionMode = DEFAULT_REMOTE_PERMISSION_MODE;
  if (doc.permissionMode !== undefined) {
    if (doc.permissionMode !== "ask" && doc.permissionMode !== "trust") {
      return { ok: false, reason: 'remote config permissionMode must be "ask" or "trust" (auto is not available here)' };
    }
    permissionMode = doc.permissionMode;
  }
  let approvalTimeoutMs = DEFAULT_APPROVAL_WAIT_MS;
  if (doc.approvalTimeoutMs !== undefined) {
    if (
      !isSafeInt(doc.approvalTimeoutMs) ||
      doc.approvalTimeoutMs < MIN_APPROVAL_WAIT_MS ||
      doc.approvalTimeoutMs > MAX_APPROVAL_WAIT_MS
    ) {
      return {
        ok: false,
        reason: `remote config approvalTimeoutMs must be an integer from ${MIN_APPROVAL_WAIT_MS} to ${MAX_APPROVAL_WAIT_MS} (milliseconds)`,
      };
    }
    approvalTimeoutMs = doc.approvalTimeoutMs;
  }
  if (doc.rendering !== undefined && !isRenderMode(doc.rendering)) {
    return { ok: false, reason: `remote config rendering must be ${RENDER_MODE_CHOICES}` };
  }
  return {
    ok: true,
    value: {
      schemaVersion: REMOTE_CONFIG_SCHEMA_VERSION,
      chatId: doc.chatId,
      allowedUserIds: [...new Set(ids as number[])],
      orphanMs: orphan.value,
      runTimeoutMs,
      permissionMode,
      approvalTimeoutMs,
      ...(doc.rendering === undefined ? {} : { rendering: doc.rendering }),
    },
  };
}

export function loadRemoteConfig(dir?: string): Loaded<RemoteConfig> {
  const file = remoteConfigPath(dir);
  const read = readConfigFile(file);
  if (!read.ok) {
    return {
      ok: false,
      reason:
        read.reason === "absent"
          ? `no remote-control config at ${file}; create it with chatId and allowedUserIds`
          : `remote-control config at ${file} cannot be read (${read.reason})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: `remote-control config at ${file} is not valid JSON` };
  }
  return parseRemoteConfig(parsed);
}

/** Write a validated config, atomically and owner-only. */
export function saveRemoteConfig(config: RemoteConfigInput, dir?: string): Loaded<RemoteConfig> {
  const checked = parseRemoteConfig(config);
  if (!checked.ok) {
    return checked;
  }
  ensureRemoteDir(dir);
  // A key the caller did not set stays out of the file: an absent key means the default, so a file
  // written by Connect is the same file as before flow 396 and a later default change reaches it.
  const { permissionMode, approvalTimeoutMs, ...base } = checked.value;
  const onDisk = {
    ...base,
    ...(config.permissionMode === undefined ? {} : { permissionMode }),
    ...(config.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
  };
  writeOwnerOnlyFileAtomic(remoteConfigPath(dir), `${JSON.stringify(onDisk, null, 2)}\n`);
  return checked;
}

/** The saved defaults `/remote-policy` may change (flow 396). Each key is optional: only the ones given change. */
export interface RemotePolicyPatch {
  permissionMode?: RemotePermissionMode;
  /** 0 means no limit. */
  runTimeoutMs?: number;
  approvalTimeoutMs?: number;
}

/**
 * Change the saved defaults for a Telegram-started turn. The file is edited as it is: a key the caller
 * did not name keeps its place, and an absent key stays absent so a later default change still reaches
 * it. The result is validated by the same closed schema as a load, so a bad value is refused here and
 * the file is not touched.
 */
export function updateRemotePolicy(patch: RemotePolicyPatch, dir?: string): Loaded<RemoteConfig> {
  const file = remoteConfigPath(dir);
  const read = readConfigFile(file);
  if (!read.ok) {
    return {
      ok: false,
      reason:
        read.reason === "absent"
          ? `no remote-control config at ${file}; connect Telegram first`
          : `remote-control config at ${file} cannot be read (${read.reason})`,
    };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: `remote-control config at ${file} is not valid JSON` };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, reason: "remote config must be a JSON object" };
  }
  const next: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode;
  if (patch.runTimeoutMs !== undefined) next.runTimeoutMs = patch.runTimeoutMs;
  if (patch.approvalTimeoutMs !== undefined) next.approvalTimeoutMs = patch.approvalTimeoutMs;
  const checked = parseRemoteConfig(next);
  if (!checked.ok) {
    return checked;
  }
  writeOwnerOnlyFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return checked;
}

/**
 * Read the bot token. Refuses a file readable by group or others, naming the
 * fix; refuses content that is not shaped like a bot token without echoing it.
 */
export function loadBotToken(dir?: string): Loaded<string> {
  const file = botTokenPath(dir);
  let mode: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) {
      return { ok: false, reason: `bot token path ${file} is not a regular file` };
    }
    mode = stats.mode & 0o777;
  } catch {
    return {
      ok: false,
      reason: `no bot token file at ${file}; put the token on one line in it and run: chmod 600 ${file}`,
    };
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    return {
      ok: false,
      reason: `bot token file ${file} is accessible to other users (mode ${mode.toString(8)}); run: chmod 600 ${file}`,
    };
  }
  const read = readConfigFile(file);
  if (!read.ok) {
    return { ok: false, reason: `bot token file ${file} cannot be read (${read.reason})` };
  }
  const token = read.text.trim();
  if (!TOKEN_SHAPE.test(token)) {
    return {
      ok: false,
      reason: `bot token file ${file} does not hold a bot token (expected <digits>:<secret> on a single line)`,
    };
  }
  return { ok: true, value: token };
}

export function isBotTokenShape(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

/**
 * Write the bot token, atomically and owner-only. The token is validated for shape
 * first and never echoed: a refusal names the expected shape, not the value.
 */
export function saveBotToken(token: string, dir?: string): Loaded<true> {
  const trimmed = token.trim();
  if (!TOKEN_SHAPE.test(trimmed)) {
    return { ok: false, reason: "that does not look like a bot token (expected <digits>:<secret>, as BotFather gives it)" };
  }
  const file = botTokenPath(dir);
  try {
    ensureRemoteDir(dir);
    writeOwnerOnlyFileAtomic(file, `${trimmed}\n`);
  } catch {
    return { ok: false, reason: `could not write the bot token file at ${file}` };
  }
  return { ok: true, value: true };
}

function removeFile(file: string): boolean {
  try {
    unlinkSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Erase the bot token file. True when it is gone (including when it never existed). */
export function removeBotToken(dir?: string): boolean {
  return removeFile(botTokenPath(dir));
}

/** Erase the remote-control config file. True when it is gone. */
export function removeRemoteConfig(dir?: string): boolean {
  return removeFile(remoteConfigPath(dir));
}
