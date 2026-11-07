// File access for the two files a routing layer lives in: the project's
// `routing.config.json` and the operator's `auth.json`. Both are shared with
// other readers (`reviewChunks`, API keys, OAuth grants), so every write here
// replaces exactly one top-level key of the file as it is at write time and
// leaves every other byte of meaning untouched.
import { isDefiniteAbsence, readConfigFile, ensureKeryxConfigDir } from "../../lib/config-dir";
import { updateConfigFile } from "../../lib/config-update";
import { writeFileAtomic } from "../../lib/fs";
import { shellConfigPath } from "../../lib/shell-config";
import { projectRoutingConfigPath, withProjectRoutingWriteLock } from "./config";

export type JsonObject = Record<string, unknown>;

export interface RoutingFileRoot {
  readonly file: string;
  readonly existed: boolean;
  readonly value: JsonObject;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRoot(file: string, text: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is malformed JSON; routing settings cannot be read`);
  }
  if (!isJsonObject(parsed)) throw new Error(`${file} must contain a JSON object; routing settings cannot be read`);
  return parsed;
}

/** Read one routing file. Absent is an empty object; anything unreadable or malformed throws. */
export function readRoutingFileRoot(file: string): RoutingFileRoot {
  const read = readConfigFile(file);
  if (!read.ok) {
    if (read.reason === "absent") return { file, existed: false, value: {} };
    throw new Error(`${file} cannot be read (${read.reason}); routing settings cannot be read`);
  }
  return { file, existed: true, value: parseRoot(file, read.text) };
}

export function userRoutingFile(configDir?: string): string {
  return shellConfigPath(configDir);
}

export function projectRoutingFile(cwd: string): string {
  return projectRoutingConfigPath(cwd);
}

function render(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Change one key of the user's `auth.json` as it is on disk when the write
 * happens. `change` receives the fresh root and returns the key's next value,
 * or `undefined` to leave the file untouched; it may run more than once.
 */
export function updateUserRoutingKey(
  configDir: string | undefined,
  key: string,
  change: (root: JsonObject) => unknown,
): "written" | "unchanged" {
  ensureKeryxConfigDir(configDir);
  const file = userRoutingFile(configDir);
  const outcome = updateConfigFile(file, (read) => {
    if (!read.ok && !isDefiniteAbsence(read.reason)) throw new Error(`${file} cannot be read (${read.reason}); nothing was written`);
    const root = read.ok ? parseRoot(file, read.text) : {};
    const next = change(root);
    return next === undefined ? undefined : render({ ...root, [key]: next });
  });
  if (outcome === "failed") throw new Error(`${file} kept changing under concurrent keryx writers; nothing was written — try again`);
  return outcome;
}

/** Same contract as `updateUserRoutingKey`, for the project's `routing.config.json`, under its write lock. */
export async function updateProjectRoutingKey(
  cwd: string,
  key: string,
  change: (root: JsonObject) => unknown,
): Promise<"written" | "unchanged"> {
  return withProjectRoutingWriteLock(cwd, async () => {
    const root = readRoutingFileRoot(projectRoutingFile(cwd));
    const next = change(root.value);
    if (next === undefined) return "unchanged";
    await writeFileAtomic(root.file, render({ ...root.value, [key]: next }));
    return "written";
  });
}
