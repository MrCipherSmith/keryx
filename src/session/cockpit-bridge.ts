import { homedir } from "node:os";
import path from "node:path";
import { buildStateSnapshot, startStateExport, type StateExportSession, type StateSnapshot, type StateExporter } from "./state-export";

/** Compatibility adapter: only Herdr identity, destination and read limit live here. */
export type CockpitSession = StateExportSession;
export type CockpitSnapshot = StateSnapshot & { terminalId: string };
export type BridgeOptions = {
  getSession: () => StateExportSession | undefined;
  env?: Record<string, string | undefined>;
  intervalMs?: number;
  onError?: (error: string) => void;
};
export async function buildCockpitSnapshot(session: CockpitSession, terminalId: string): Promise<CockpitSnapshot> {
  return { ...await buildStateSnapshot(session), terminalId };
}
/** Disabled outside a local Herdr terminal; legacy wire schema and path are unchanged. */
export function startCockpitBridge(options: BridgeOptions): StateExporter {
  const env = options.env ?? process.env;
  const id = env.HC_TERMINAL_ID;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return { refresh: async () => ({ ok: true }), stop: async () => {} };
  const root = path.join(env.HERDR_APP_HOME || path.join(homedir(), ".config", "herdr-app"), "data", "keryx-cockpit");
  return startStateExport({
    file: path.join(root, `${id}.json`), getSession: options.getSession,
    intervalMs: options.intervalMs, onError: options.onError,
    maxBytes: 1_000_000, buildSnapshot: session => buildCockpitSnapshot(session, id),
  });
}
