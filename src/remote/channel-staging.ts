// Opaque, one-use local handoff for a candidate credential. Never return the value to an HTTP caller.
import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { isBotTokenShape, type Loaded } from "./config";
import { ensureRemoteDir, remoteDirPath } from "./paths";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function file(id: string, dir?: string): string { return path.join(remoteDirPath(dir), "staged", id); }

/** The caller writes the token locally and sends only the opaque id through the control plane. */
export function stageChannelToken(token: string, dir?: string): Loaded<string> {
  const value = token.trim();
  if (!isBotTokenShape(value)) return { ok: false, reason: "invalid channel credential" };
  try {
    ensureRemoteDir(dir, "staged");
    const id = randomUUID();
    writeOwnerOnlyFileAtomic(file(id, dir), `${value}\n`);
    return { ok: true, value: id };
  } catch {
    return { ok: false, reason: "could not stage channel credential" };
  }
}

/** Atomically claim a staged token once. The claimed file is removed even when invalid. */
export function consumeChannelToken(id: string, dir?: string): Loaded<string> {
  if (!ID.test(id)) return { ok: false, reason: "invalid staging id" };
  const source = file(id, dir);
  const claimed = `${source}.${randomUUID()}.claimed`;
  try {
    const stat = lstatSync(source);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) return { ok: false, reason: "staged credential is not owner-only" };
    renameSync(source, claimed);
    const read = readConfigFile(claimed);
    if (!read.ok || !isBotTokenShape(read.text.trim())) return { ok: false, reason: "staged credential is invalid" };
    return { ok: true, value: read.text.trim() };
  } catch {
    return { ok: false, reason: "staged credential is unavailable" };
  } finally {
    try { unlinkSync(claimed); } catch { /* No claimed file remains. */ }
  }
}

export function discardChannelToken(id: string, dir?: string): void {
  if (!ID.test(id)) return;
  try { unlinkSync(file(id, dir)); } catch { /* Already consumed or removed. */ }
}
