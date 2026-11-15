import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildStateSnapshot, type StateExportSession, type StateSnapshot } from "./state-snapshot";
export { buildStateSnapshot, type StateExportSession, type StateSnapshot } from "./state-snapshot";

export type PublishResult = { ok: true } | { ok: false; error: string };
export type StateExporter = { refresh: () => Promise<PublishResult>; stop: () => Promise<void> };
export type StateExportOptions = {
  file: string;
  getSession: () => StateExportSession | undefined;
  intervalMs?: number | undefined;
  maxBytes?: number;
  onError?: ((error: string) => void) | undefined;
  buildSnapshot?: (session: StateExportSession) => Promise<StateSnapshot>;
};
const message = (e: unknown): string => e instanceof Error ? e.message : String(e);
/** Explicit local file transport. No consumer identity, environment discovery or session guessing. */
export function startStateExport(options: StateExportOptions): StateExporter {
  const file = options.file, root = path.dirname(file), ownerId = randomUUID();
  let stopped = false, lastError = "";
  let queue: Promise<PublishResult> = Promise.resolve({ ok: true });
  const report = (e: unknown): PublishResult => {
    const error = message(e);
    if (lastError !== error) (options.onError ?? (text => process.stderr.write(`State export: ${text}\n`)))(error);
    lastError = error;
    return { ok: false, error };
  };
  const removeOwned = async (): Promise<void> => {
    try {
      const existing = JSON.parse(await readFile(file, "utf8"));
      if (existing.ownerId === ownerId) await rm(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  };
  const publish = async (): Promise<PublishResult> => {
    if (!path.isAbsolute(file)) return report("export file must be an absolute path");
    if (options.maxBytes !== undefined && (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0)) return report("maxBytes must be positive and finite");
    const temp = `${file}.${ownerId}.tmp`;
    try {
      const session = options.getSession();
      if (stopped || !session) { await removeOwned(); return { ok: true }; }
      const snapshot = await (options.buildSnapshot ?? buildStateSnapshot)(session);
      const current = options.getSession();
      if (stopped || !current || current.dir !== session.dir || current.cwd !== session.cwd || current.sessionId !== session.sessionId) {
        await removeOwned(); return { ok: true };
      }
      const text = JSON.stringify({ ...snapshot, ownerId });
      if (options.maxBytes !== undefined && Buffer.byteLength(text) > options.maxBytes) return report(`snapshot exceeds export limit (${options.maxBytes} bytes)`);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, file);
      lastError = "";
      return { ok: true };
    } catch (e) { return report(e); }
    finally { await rm(temp, { force: true }).catch(report); }
  };
  const refresh = (): Promise<PublishResult> => { queue = queue.then(publish); return queue; };
  const timer = setInterval(() => { void refresh(); }, options.intervalMs ?? 2000);
  timer.unref();
  void refresh();
  return { refresh, stop: async () => { stopped = true; clearInterval(timer); await refresh(); } };
}
