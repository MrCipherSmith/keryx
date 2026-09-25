// Flow 295 (F1): the per-machine key that signs every confirmed schedule.
//
// The first version protected a stored schedule with a plain sha256 of its content.
// Anyone who could write the store could therefore compute a matching "confirmed"
// hash themselves. A committed `schedules.json`, or a write by an agent, then ran
// with the operator's credentials. The hash is now an HMAC-SHA256 keyed with a
// secret that lives OUTSIDE the project, in keryx's user-global directory
// (`keryxConfigDir()`, beside `auth.json`), created 0600:
//
//   - a file committed to the repository cannot carry a valid MAC, because the
//     committer does not have this machine's key;
//   - the unattended sandbox hides $HOME wholesale, so a scheduled run cannot read it;
//   - an interactive agent that names the file (or `.local/share/keryx`) hits
//     the credentials-class floor: it is always asked, and the answer is never remembered.
//
// HONEST LIMIT: an interactive agent running as the same user in `trust` mode,
// with an unrestricted shell, could in principle read the key by spelling its
// path in a way the text floor does not see. The floor turns that into a prompt,
// not a guarantee. The boundary against an agent is the operator's approval.
//
// A missing, unreadable or group/world-readable key refuses every stored
// schedule, with the reason, rather than falling back to an unkeyed hash.

import { createHmac, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { createOwnerOnlyFileExclusive, ensureKeryxConfigDir, keryxConfigDir, readConfigFile } from "../lib/config-dir";
import { realOr } from "./granted-binary";

const KEY_FILE = "schedule-hmac.key";

/** Where the key lives. `dir` is the config-dir test seam every keryx config reader takes. */
export function scheduleKeyPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), KEY_FILE);
}

export type ScheduleKeyRead = { readonly ok: true; readonly key: Buffer } | { readonly ok: false; readonly reason: string };

/** Read the key. Never creates it: a run with no key refuses every stored schedule. */
export function readScheduleKey(dir?: string): ScheduleKeyRead {
  const file = scheduleKeyPath(dir);
  try {
    const stat = statSync(file);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      return { ok: false, reason: `${file} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}); it must be 0600` };
    }
  } catch {
    return { ok: false, reason: `the schedule key ${file} does not exist — schedules confirmed on this machine are signed with it; recreate them with \`keryx schedule add\`` };
  }
  const read = readConfigFile(file);
  if (!read.ok) return { ok: false, reason: `the schedule key ${file} could not be read (${read.reason})` };
  const hex = read.text.trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) return { ok: false, reason: `the schedule key ${file} is malformed` };
  return { ok: true, key: Buffer.from(hex, "hex") };
}

/** Read the key, creating it (0600, exclusively) the first time a schedule is confirmed. */
export function ensureScheduleKey(dir?: string): ScheduleKeyRead {
  const existing = readScheduleKey(dir);
  if (existing.ok) return existing;
  ensureKeryxConfigDir(dir);
  createOwnerOnlyFileExclusive(scheduleKeyPath(dir), `${randomBytes(32).toString("hex")}\n`);
  return readScheduleKey(dir);
}

/**
 * Flow 295 (N4): keryx's config directory must not be inside the project. If it
 * were, the project would carry the signing key and auth.json, and the key would sit
 * inside the read-only project bind every run gets. Returns the refusal reason, or
 * `undefined` when the layout is sound.
 */
export function configDirInsideProjectReason(projectRoot: string, dir?: string): string | undefined {
  // R3 regression fix (flow 319 CI): use the SAME ancestor-walking realpath
  // resolution `resolvesInsideProject` (`./granted-binary.ts`) uses, not a
  // bare realpathSync-or-unresolved-path fallback — a config dir under
  // XDG_DATA_HOME often does not exist yet at draft time (`ensureKeryxConfigDir`
  // only runs once a schedule is actually confirmed), so the naive fallback
  // left it unresolved through a symlinked ancestor (macOS's `/var` ->
  // `/private/var`) while `projectRoot` (which does exist) got fully
  // resolved — silently defeating this exact "inside the project" check for
  // a not-yet-created config dir. See `realOr`'s doc comment for the detail.
  const config = realOr(keryxConfigDir(dir));
  const root = realOr(projectRoot);
  const rel = path.relative(root, config);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return `keryx's config directory ${config} is inside this project (${root}); the schedule signing key and auth.json must live outside every project — point XDG_DATA_HOME elsewhere`;
  }
  return undefined;
}

/** HMAC-SHA256 of already-canonical content. */
export function scheduleMac(key: Buffer, canonical: string): string {
  return createHmac("sha256", key).update(canonical).digest("hex");
}
