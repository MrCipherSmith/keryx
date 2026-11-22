// A single atomic activation unit. Callers must not log records: connected records contain a credential.
import path from "node:path";
import { statSync } from "node:fs";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { withFileLock } from "../lib/fs";
import { isBotTokenShape, loadBotToken, loadRemoteConfig, parseRemoteConfig, type Loaded, type RemoteConfig } from "./config";
import { botTokenPath, ensureRemoteDir, remoteConfigPath, remoteDirPath } from "./paths";

export interface ChannelBotIdentity { id: number; username?: string }
export interface ChannelCandidate { token: string; bot: ChannelBotIdentity | null; config: RemoteConfig; bindingId?: string }
export type ChannelRecord =
  | ({ schemaVersion: 1; revision: number; state: "connected" } & ChannelCandidate)
  | { schemaVersion: 1; revision: number; state: "disconnected" };
export type ChannelMutationResult = Loaded<ChannelRecord> | { ok: false; code: "conflict"; currentRevision: number | null; reason: string };

export function channelRecordPath(dir?: string): string { return path.join(remoteDirPath(dir), "channel.json"); }

/** Readers use the committed revision when present, including its disconnected marker. */
export function loadActiveRemoteConfig(dir?: string): Loaded<RemoteConfig> {
  const record = loadChannelRecord(dir);
  if (!record.ok) return record;
  if (record.value === null) return loadRemoteConfig(dir);
  if (record.value.state === "disconnected") return { ok: false, reason: "Telegram is disconnected." };
  return { ok: true, value: record.value.config };
}

export function loadChannelRecord(dir?: string): Loaded<ChannelRecord | null> {
  const file = channelRecordPath(dir);
  const read = readConfigFile(file);
  if (!read.ok) return read.reason === "absent" ? { ok: true, value: null } : { ok: false, reason: "channel record cannot be read" };
  try {
    const stats = statSync(file);
    if (!stats.isFile() || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) return { ok: false, reason: "channel record must be an owner-only regular file" };
    const raw: unknown = JSON.parse(read.text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error();
    const doc = raw as Record<string, unknown>;
    if (doc.schemaVersion !== 1 || !Number.isSafeInteger(doc.revision) || Number(doc.revision) < 1) throw new Error();
    const revision = Number(doc.revision);
    if (doc.state === "disconnected" && Object.keys(doc).every((key) => ["schemaVersion", "revision", "state"].includes(key))) return { ok: true, value: { schemaVersion: 1, revision, state: "disconnected" } };
    if (doc.state !== "connected" || !Object.keys(doc).every((key) => ["schemaVersion", "revision", "state", "token", "bot", "config", "bindingId"].includes(key))) throw new Error();
    const candidate = validateCandidate({ token: doc.token, bot: doc.bot, config: doc.config, bindingId: doc.bindingId });
    if (!candidate.ok) return candidate;
    return { ok: true, value: { schemaVersion: 1, revision, state: "connected", ...candidate.value } };
  } catch {
    return { ok: false, reason: "channel record is invalid" };
  }
}

function validateCandidate(value: { token: unknown; bot: unknown; config: unknown; bindingId?: unknown }): Loaded<ChannelCandidate> {
  if (typeof value.token !== "string" || !isBotTokenShape(value.token)) return { ok: false, reason: "invalid channel credential" };
  let bot: ChannelBotIdentity | null = null;
  if (value.bot !== null) {
    if (typeof value.bot !== "object" || value.bot === null || Array.isArray(value.bot)) return { ok: false, reason: "invalid channel bot identity" };
    const raw = value.bot as Record<string, unknown>;
    if (!Object.keys(raw).every((key) => key === "id" || key === "username") || !Number.isSafeInteger(raw.id) || Number(raw.id) <= 0 || (raw.username !== undefined && (typeof raw.username !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(raw.username)))) return { ok: false, reason: "invalid channel bot identity" };
    bot = { id: Number(raw.id), ...(typeof raw.username === "string" ? { username: raw.username } : {}) };
  }
  if (value.bindingId !== undefined && (typeof value.bindingId !== "string" || !/^[0-9a-f]{32}$/.test(value.bindingId))) return { ok: false, reason: "invalid channel binding id" };
  const config = parseRemoteConfig(value.config);
  if (!config.ok) return config;
  return { ok: true, value: { token: value.token, bot, config: config.value, ...(typeof value.bindingId === "string" ? { bindingId: value.bindingId } : {}) } };
}

async function locked<T>(dir: string | undefined, fn: () => T): Promise<T> {
  ensureRemoteDir(dir);
  return withFileLock(path.join(remoteDirPath(dir), "channel.lock"), async () => fn());
}
function write(record: ChannelRecord, dir?: string): void {
  writeOwnerOnlyFileAtomic(channelRecordPath(dir), `${JSON.stringify(record, null, 2)}\n`);
}
function conflict(currentRevision: number | null): ChannelMutationResult {
  return { ok: false, code: "conflict", currentRevision, reason: "channel revision changed; refresh and retry" };
}

export async function commitChannelRecord(expectedRevision: number | null, candidate: ChannelCandidate, dir?: string, stillOwned?: () => boolean): Promise<ChannelMutationResult> {
  const checked = validateCandidate(candidate);
  if (!checked.ok) return checked;
  return locked(dir, () => {
    const current = loadChannelRecord(dir);
    if (!current.ok) return current;
    const revision = current.value?.revision ?? null;
    if (revision !== expectedRevision || (stillOwned !== undefined && !stillOwned())) return conflict(revision);
    if (revision === Number.MAX_SAFE_INTEGER) return { ok: false, reason: "channel revision exhausted" };
    const record: ChannelRecord = { schemaVersion: 1, revision: (revision ?? 0) + 1, state: "connected", ...checked.value };
    write(record, dir);
    return { ok: true, value: record };
  });
}

export async function disconnectChannelRecord(expectedRevision: number | null, dir?: string): Promise<ChannelMutationResult> {
  return locked(dir, () => {
    const current = loadChannelRecord(dir);
    if (!current.ok) return current;
    const revision = current.value?.revision ?? null;
    if (revision !== expectedRevision) return conflict(revision);
    if (revision === Number.MAX_SAFE_INTEGER) return { ok: false, reason: "channel revision exhausted" };
    const record: ChannelRecord = { schemaVersion: 1, revision: (revision ?? 0) + 1, state: "disconnected" };
    write(record, dir);
    return { ok: true, value: record };
  });
}

/** Import only when no record exists. A tombstone always wins over legacy files. */
export async function migrateLegacyChannelRecord(dir?: string): Promise<Loaded<ChannelRecord | null>> {
  return locked(dir, () => {
    const current = loadChannelRecord(dir);
    if (!current.ok || current.value !== null) return current;
    const tokenFile = readConfigFile(botTokenPath(dir));
    const configFile = readConfigFile(remoteConfigPath(dir));
    if (!tokenFile.ok && tokenFile.reason === "absent" && !configFile.ok && configFile.reason === "absent") return { ok: true, value: null };
    const token = loadBotToken(dir);
    const config = loadRemoteConfig(dir);
    if (!token.ok || !config.ok) return { ok: false, reason: "legacy channel configuration is incomplete or invalid" };
    const record: ChannelRecord = { schemaVersion: 1, revision: 1, state: "connected", token: token.value, bot: null, config: config.value };
    write(record, dir);
    return { ok: true, value: record };
  });
}
