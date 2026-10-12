// Where remote-control state lives: `<user-global keryx dir>/remote/`.
//
// The `dir` argument everywhere in this package is the same override seam the
// other user-global modules thread through (`keryxConfigDir(dir)`), so a test
// points the whole package at a temp directory and never touches the real one.
//
// This file only RESOLVES paths and creates owner-only directories; reads and
// writes go through the sanctioned helpers in `lib/config-dir.ts`
// (`readConfigFile`, `readTurnFile`, `writeOwnerOnlyFileAtomic`,
// `appendOwnerOnlyLine`), which is what the config-dir guards require.

import path from "node:path";
import { ensureKeryxSubdir, keryxConfigDir } from "../lib/config-dir";

export const REMOTE_DIRNAME = "remote";
export const BOT_TOKEN_FILE = "bot-token";
export const REMOTE_CONFIG_FILE = "config.json";
export const REGISTRY_FILE = "sessions.json";
export const SERVICE_TOPICS_FILE = "service-topics.json";
export const POLLER_STATE_FILE = "poller-state.json";
export const OUTBOUND_FILE = "outbound.jsonl";
export const REJECTED_JOURNAL_FILE = "rejected.jsonl";
export const INBOUND_DIRNAME = "inbound";

/** `<config dir>/remote`, not created. */
export function remoteDirPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), REMOTE_DIRNAME);
}

/** Create `<config dir>/remote[/sub...]` owner-only at every level and return it. */
export function ensureRemoteDir(dir?: string, ...sub: string[]): string {
  return ensureKeryxSubdir([REMOTE_DIRNAME, ...sub], dir);
}

export function botTokenPath(dir?: string): string {
  return path.join(remoteDirPath(dir), BOT_TOKEN_FILE);
}

export function remoteConfigPath(dir?: string): string {
  return path.join(remoteDirPath(dir), REMOTE_CONFIG_FILE);
}
